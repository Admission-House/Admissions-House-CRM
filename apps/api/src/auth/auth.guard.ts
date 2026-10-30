import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { AuthService } from './auth.service.js';
import { ALLOW_PASSWORD_CHANGE, IS_PUBLIC, PERMISSIONS, PERMISSIONS_ANY } from './decorators.js';

/**
 * Applied to every route. A route is closed unless it is marked @Public(). For the rest it checks,
 * in order: a valid access token, a live session, a password that is not waiting to be changed,
 * and the permissions the route asks for.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header) : null;
    if (!match) throw AppError.unauthorized('Please sign in');

    const auth = await this.auth.authenticate(match[1]!, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: request.id,
    });
    request.auth = auth;

    if (auth.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password before you continue', 403);
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS, targets) ?? [];
    if (required.some((code) => !auth.permissions.has(code))) throw AppError.forbidden();

    const any = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_ANY, targets) ?? [];
    if (any.length > 0 && !any.some((code) => auth.permissions.has(code))) throw AppError.forbidden();
    return true;
  }
}
