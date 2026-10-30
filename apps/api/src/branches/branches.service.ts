import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { distanceMeters } from '../auth/office-rules.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { AddNetworkDto, ConfirmDetectionDto, CreateBranchDto, DetectDto, UpdateBranchDto } from './branches.dto.js';
import { isInternalAddress, normalizeAllowedRange, rangeForAddress } from './network-rules.js';

/** GPS indoors is rough. Below this a reading is good; up to the hard limit it is accepted with a warning. */
const GOOD_ACCURACY_M = 50;
const MAX_ACCURACY_M = 100;

export interface BranchView {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  detectedAt: Date | null;
  isActive: boolean;
  userCount: number;
  networks: { id: string; kind: string; ipRange: string | null; wifiId: string | null }[];
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<BranchView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const ids = await trx.selectFrom('branches').select('id').orderBy('name').execute();
      return Promise.all(ids.map((b) => this.load(trx, b.id)));
    });
  }

  get(auth: AuthContext, id: string): Promise<BranchView> {
    return this.db.withTenant(auth.tenantId, (trx) => this.load(trx, id));
  }

  create(auth: AuthContext, dto: CreateBranchDto): Promise<BranchView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertNameFree(trx, dto.name);
      const row = await trx
        .insertInto('branches')
        .values({
          tenant_id: auth.tenantId,
          name: dto.name,
          address: dto.address ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          radius_m: dto.radiusM ?? 200,
          detected_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'branch.create', row.id, undefined, dto);
      return this.load(trx, row.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateBranchDto): Promise<BranchView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.load(trx, id);
      if (dto.name && dto.name !== before.name) await this.assertNameFree(trx, dto.name);
      if (dto.isActive === false && before.isActive && before.userCount > 0) {
        throw AppError.conflict('BRANCH_IN_USE', `${before.userCount} active people are placed in this office. Move them first.`);
      }
      await trx
        .updateTable('branches')
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.radiusM !== undefined && { radius_m: dto.radiusM }),
          ...(dto.isActive !== undefined && { is_active: dto.isActive }),
        })
        .where('id', '=', id)
        .execute();
      const after = await this.load(trx, id);
      await this.record(trx, auth, 'branch.update', id, summary(before), summary(after));
      return after;
    });
  }

  addNetwork(auth: AuthContext, id: string, dto: AddNetworkDto): Promise<BranchView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.load(trx, id);
      const range = dto.kind === 'ip_range' ? normalizeAllowedRange(dto.ipRange!) : null;
      await this.insertNetwork(trx, auth, id, dto.kind, range, dto.wifiId ?? null);
      return this.load(trx, id);
    });
  }

  removeNetwork(auth: AuthContext, id: string, networkId: string): Promise<BranchView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const removed = await trx
        .deleteFrom('branch_networks')
        .where('id', '=', networkId)
        .where('branch_id', '=', id)
        .returning(['kind', sql<string | null>`host(ip_range)`.as('ip_text'), sql<string | null>`ip_range::text`.as('range_text'), 'wifi_id'])
        .executeTakeFirst();
      if (!removed) throw AppError.notFound('Network');
      await this.record(trx, auth, 'branch.network_remove', id, { kind: removed.kind, ipRange: removed.range_text, wifiId: removed.wifi_id }, undefined);
      return this.load(trx, id);
    });
  }

  /**
   * Step one of setting up an office: read what the server sees. Nothing is saved. The person
   * stands in the office, the browser reports its position, and the screen shows the position and
   * the address for confirmation.
   */
  detect(auth: AuthContext, id: string, reading: DetectDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const branch = await this.load(trx, id);
      const warnings: string[] = [];
      if (reading.accuracy > MAX_ACCURACY_M) warnings.push('The position is too vague to save. Move near a window, wait a few seconds and try again.');
      else if (reading.accuracy > GOOD_ACCURACY_M) warnings.push('The position is not very precise. Moving near a window usually helps.');
      if (isInternalAddress(auth.ip)) {
        warnings.push('The server sees a private address, not the office\'s public one. Check the proxy setting before saving the network.');
      }
      const hadPosition = branch.latitude !== null && branch.longitude !== null;
      return {
        observedIp: auth.ip,
        suggestedRange: isInternalAddress(auth.ip) ? null : rangeForAddress(auth.ip),
        position: { lat: reading.lat, lng: reading.lng, accuracy: reading.accuracy },
        canSave: reading.accuracy <= MAX_ACCURACY_M,
        movedFromCurrentM: hadPosition
          ? Math.round(distanceMeters({ lat: branch.latitude!, lng: branch.longitude! }, reading))
          : null,
        warnings,
      };
    });
  }

  /**
   * Step two: save the confirmed position and, normally, the address the request came from.
   * The address is the one the server observed, never one typed by the client.
   */
  confirm(auth: AuthContext, id: string, body: ConfirmDetectionDto): Promise<BranchView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.load(trx, id);
      if (body.accuracy > MAX_ACCURACY_M) {
        throw AppError.badRequest('GPS_TOO_VAGUE', 'The position is too vague to save. Try again near a window.');
      }
      if (body.addCurrentIp && isInternalAddress(auth.ip) && !body.allowInternalAddress) {
        throw AppError.badRequest(
          'ADDRESS_NOT_PUBLIC',
          'The server sees a private address, not the office\'s public one. Fix the proxy setting, or confirm that this address is intended.',
        );
      }
      await trx
        .updateTable('branches')
        .set({ latitude: body.lat, longitude: body.lng, detected_at: sql`now()` })
        .where('id', '=', id)
        .execute();
      if (body.addCurrentIp) {
        const range = rangeForAddress(auth.ip);
        const exists = before.networks.some((n) => n.ipRange === range);
        if (!exists) await this.insertNetwork(trx, auth, id, 'ip_range', range, null);
      }
      const after = await this.load(trx, id);
      await this.record(trx, auth, 'branch.detect', id, summary(before), { ...summary(after), accuracy: body.accuracy });
      return after;
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(trx: Trx, id: string): Promise<BranchView> {
    const branch = await trx.selectFrom('branches').selectAll().where('id', '=', id).executeTakeFirst();
    if (!branch) throw AppError.notFound('Office');
    const networks = await trx
      .selectFrom('branch_networks')
      .select(['id', 'kind', sql<string | null>`ip_range::text`.as('ip_range'), 'wifi_id'])
      .where('branch_id', '=', id)
      .orderBy('created_at')
      .execute();
    const users = await trx
      .selectFrom('users')
      .select(sql<string>`count(*)`.as('n'))
      .where('branch_id', '=', id)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return {
      id: branch.id,
      name: branch.name,
      address: branch.address,
      latitude: branch.latitude === null ? null : Number(branch.latitude),
      longitude: branch.longitude === null ? null : Number(branch.longitude),
      radiusM: branch.radius_m,
      detectedAt: branch.detected_at,
      isActive: branch.is_active,
      userCount: Number(users.n),
      networks: networks.map((n) => ({ id: n.id, kind: n.kind, ipRange: n.ip_range, wifiId: n.wifi_id })),
    };
  }

  private async insertNetwork(trx: Trx, auth: AuthContext, branchId: string, kind: string, range: string | null, wifiId: string | null): Promise<void> {
    const duplicate = await trx
      .selectFrom('branch_networks')
      .select('id')
      .where('branch_id', '=', branchId)
      .where((eb) => (range ? eb(sql`ip_range::text`, '=', range) : eb('wifi_id', '=', wifiId)))
      .executeTakeFirst();
    if (duplicate) throw AppError.conflict('NETWORK_EXISTS', 'This network is already allowed for the office');

    await trx
      .insertInto('branch_networks')
      .values({ tenant_id: auth.tenantId, branch_id: branchId, kind, ip_range: range, wifi_id: wifiId })
      .execute();
    await this.record(trx, auth, 'branch.network_add', branchId, undefined, { kind, ipRange: range, wifiId });
  }

  private async assertNameFree(trx: Trx, name: string): Promise<void> {
    const taken = await trx.selectFrom('branches').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (taken) throw AppError.conflict('BRANCH_NAME_TAKEN', 'An office with this name already exists');
  }

  private record(trx: Trx, auth: AuthContext, action: string, id: string, before: unknown, after: unknown): Promise<void> {
    return this.audit.write(trx, {
      tenantId: auth.tenantId, actorId: auth.userId, action, entity: 'branch', entityId: id,
      before, after, ip: auth.ip, requestId: auth.requestId,
    });
  }
}

function summary(b: BranchView) {
  return { name: b.name, address: b.address, latitude: b.latitude, longitude: b.longitude, radiusM: b.radiusM, isActive: b.isActive };
}
