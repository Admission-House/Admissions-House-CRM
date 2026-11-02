import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AuthService } from './auth.service.js';
import { ALLOW_PASSWORD_CHANGE, HEAVY, IS_PUBLIC, PERMISSIONS, PERMISSIONS_ANY } from './decorators.js';

/**
 * Applied to every route. A route is closed unless it is marked @Public(). For the rest it checks,
 * in order: a valid access token, a live session, how often this user has called us, a password
 * that is not waiting to be changed, and the permissions the route asks for.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /** Counted per signed-in user. In this process only; behind several API containers each has its own count. */
  private readonly perUser: SlidingWindowLimiter;
  private readonly heavyPerUser: SlidingWindowLimiter;

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    @Inject(ENV) env: Env,
  ) {
    this.perUser = new SlidingWindowLimiter(env.USER_RATE_PER_MIN, 60_000);
    this.heavyPerUser = new SlidingWindowLimiter(env.HEAVY_RATE_PER_MIN, 60_000);
  }

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

    // Every request counts against the user's allowance; expensive ones count against a second,
    // smaller one. Asking for a report or list as a file is expensive whichever route it is.
    const format = (request.query as { format?: unknown } | undefined)?.format;
    const heavy = this.reflector.getAllAndOverride<boolean>(HEAVY, targets) || format === 'csv' || format === 'xlsx';
    const wait = this.perUser.hit(auth.userId) || (heavy ? this.heavyPerUser.hit(auth.userId) : 0);
    if (wait) throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.', 429, undefined, { 'retry-after': String(wait) });

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
