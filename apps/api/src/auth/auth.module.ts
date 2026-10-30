import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordService,
    PasswordResetService,
    TokenService,
    // Closed by default: every route needs a sign-in unless it is marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthRepository, PasswordService],
})
export class AuthModule {}
