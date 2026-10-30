import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { AdmissionsModule } from './admissions/admissions.module.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CompanyModule } from './company/company.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BranchesModule } from './branches/branches.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { ConfigModule, ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { MailModule } from './mail/mail.module.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { PayrollModule } from './payroll/payroll.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { TelephonyModule } from './telephony/telephony.module.js';
import { FollowUpsModule } from './followups/followups.module.js';
import { HealthModule } from './health/health.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { LeadConfigModule } from './lead-config/lead-config.module.js';
import { LeaveModule } from './leave/leave.module.js';
import { MastersModule } from './masters/masters.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RolesModule } from './roles/roles.module.js';
import { StorageModule } from './storage/storage.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // The request body is never logged, and credentials are removed from headers.
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
          },
          autoLogging: { ignore: (req) => (req.url ?? '').includes('/health/') },
          customLogLevel: (_req, res, err) =>
            err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
              : undefined,
        },
      }),
    }),
    DatabaseModule,
    AuditModule,
    CompanyModule,
    StorageModule,
    AuthModule,
    AttendanceModule,
    NotificationsModule,
    LeaveModule,
    IntakeModule,
    IntegrationsModule,
    LeadConfigModule,
    LeadsModule,
    MastersModule,
    AdmissionsModule,
    DocumentsModule,
    ImportsModule,
    CryptoModule,
    MailModule,
    TelephonyModule,
    PayrollModule,
    ReportsModule,
    CustomFieldsModule,
    FollowUpsModule,
    RolesModule,
    UsersModule,
    BranchesModule,
    DevicesModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useFactory: (host: HttpAdapterHost) => new AllExceptionsFilter(host), inject: [HttpAdapterHost] },
  ],
})
export class AppModule {}
