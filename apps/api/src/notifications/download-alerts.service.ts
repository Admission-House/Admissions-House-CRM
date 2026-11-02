import { Injectable, Logger } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { DatabaseService } from '../database/database.service.js';
import { NotificationsService } from './notifications.service.js';

export type DownloadKind = 'lead_export' | 'report_export' | 'salary_export' | 'payslip' | 'import_problems' | 'document' | 'recording';

/**
 * Tells every Super Admin when anyone downloads anything: an export, a report, a payslip, a student
 * document or a call recording. The person who downloaded is not told about themselves.
 *
 * It is called after the file has been produced, in its own short transaction. It never throws: an
 * alert that cannot be written must not stop a person from getting their file (the download itself
 * is also in the audit log).
 */
@Injectable()
export class DownloadAlerts {
  private readonly logger = new Logger(DownloadAlerts.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  async record(auth: AuthContext, kind: DownloadKind, what: string, fileName?: string): Promise<void> {
    try {
      await this.db.withTenant(auth.tenantId, (trx) =>
        this.notifications.notifySuperAdmins(trx, {
          tenantId: auth.tenantId,
          exceptUserId: auth.userId,
          payload: { event: 'download', userId: auth.userId, userName: auth.name, kind, what, fileName: fileName ?? null, ip: auth.ip ?? null },
        }),
      );
    } catch (err) {
      this.logger.error(`could not write download alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
