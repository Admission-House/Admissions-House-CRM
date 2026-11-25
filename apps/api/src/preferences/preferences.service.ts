import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import {
  allowedStartPages,
  checkAvatar,
  NOTIFY_KINDS,
  type NotifyKind,
  type StartPage,
} from './preferences-rules.js';

export interface PreferencesView {
  startPage: StartPage | null;
  /** The pages this person may choose from. */
  startPages: StartPage[];
  /** One entry per kind of alert that can be switched off. */
  notify: Record<NotifyKind, boolean>;
  hasAvatar: boolean;
  /** Changes whenever the photo does, so screens know to fetch it again. */
  avatarVersion: number | null;
}

interface Row {
  start_page: StartPage | null;
  notify: Record<string, unknown>;
  avatar_updated_at: Date | null;
}

@Injectable()
export class PreferencesService {
  constructor(private readonly db: DatabaseService) {}

  async get(auth: AuthContext): Promise<PreferencesView> {
    const { rows } = await this.db.withTenant(auth.tenantId, (trx) =>
      sql<Row>`SELECT start_page, notify, avatar_updated_at FROM user_preferences WHERE user_id = ${auth.userId}::uuid`.execute(
        trx,
      ),
    );
    return this.view(auth, rows[0]);
  }

  /** What the person chose for the alerts, the start page, or both. A page they may not open is refused. */
  async update(
    auth: AuthContext,
    input: { startPage?: StartPage | null; notify?: Partial<Record<NotifyKind, boolean>> },
  ): Promise<PreferencesView> {
    if (input.startPage && !allowedStartPages(auth.permissions).includes(input.startPage)) {
      throw AppError.badRequest(
        'START_PAGE_NOT_ALLOWED',
        'You cannot open that page, so it cannot be your start page.',
      );
    }
    const { rows } = await this.db.withTenant(auth.tenantId, (trx) =>
      sql<Row>`
        INSERT INTO user_preferences (tenant_id, user_id, start_page, notify)
        VALUES (${auth.tenantId}::uuid, ${auth.userId}::uuid, ${input.startPage ?? null}, ${JSON.stringify(input.notify ?? {})}::jsonb)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET
          start_page = ${input.startPage === undefined ? sql`user_preferences.start_page` : sql`${input.startPage}`},
          notify = user_preferences.notify || ${JSON.stringify(input.notify ?? {})}::jsonb,
          updated_at = now()
        RETURNING start_page, notify, avatar_updated_at`.execute(trx),
    );
    return this.view(auth, rows[0]);
  }

  async setAvatar(auth: AuthContext, image: string): Promise<PreferencesView> {
    const checked = checkAvatar(image);
    if (!checked.ok) throw AppError.badRequest('INVALID_PICTURE', checked.reason);
    const { rows } = await this.db.withTenant(auth.tenantId, (trx) =>
      sql<Row>`
        INSERT INTO user_preferences (tenant_id, user_id, avatar, avatar_type, avatar_updated_at)
        VALUES (${auth.tenantId}::uuid, ${auth.userId}::uuid, ${checked.bytes}, ${checked.type}, now())
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET avatar = EXCLUDED.avatar, avatar_type = EXCLUDED.avatar_type, avatar_updated_at = now(), updated_at = now()
        RETURNING start_page, notify, avatar_updated_at`.execute(trx),
    );
    return this.view(auth, rows[0]);
  }

  async removeAvatar(auth: AuthContext): Promise<PreferencesView> {
    const { rows } = await this.db.withTenant(auth.tenantId, (trx) =>
      sql<Row>`
        UPDATE user_preferences SET avatar = NULL, avatar_type = NULL, avatar_updated_at = NULL, updated_at = now()
        WHERE user_id = ${auth.userId}::uuid RETURNING start_page, notify, avatar_updated_at`.execute(
        trx,
      ),
    );
    return this.view(auth, rows[0]);
  }

  /** Anyone signed in to the same company may see a colleague's photo. Another company's is not there to find. */
  async avatarOf(auth: AuthContext, userId: string): Promise<{ bytes: Buffer; type: string }> {
    const { rows } = await this.db.withTenant(auth.tenantId, (trx) =>
      sql<{
        avatar: Buffer;
        avatar_type: string;
      }>`SELECT avatar, avatar_type FROM user_preferences WHERE user_id = ${userId}::uuid AND avatar IS NOT NULL`.execute(
        trx,
      ),
    );
    if (!rows[0]) throw AppError.notFound('Picture');
    return { bytes: rows[0].avatar, type: rows[0].avatar_type };
  }

  private view(auth: AuthContext, row: Row | undefined): PreferencesView {
    const stored = row?.notify ?? {};
    return {
      startPage: row?.start_page ?? null,
      startPages: allowedStartPages(auth.permissions),
      notify: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, stored[k] !== false])) as Record<
        NotifyKind,
        boolean
      >,
      hasAvatar: !!row?.avatar_updated_at,
      avatarVersion: row?.avatar_updated_at ? new Date(row.avatar_updated_at).getTime() : null,
    };
  }
}
