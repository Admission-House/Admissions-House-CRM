import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from './auth-context.js';

export const IS_PUBLIC = 'auth:public';
export const PERMISSIONS = 'auth:permissions';
export const PERMISSIONS_ANY = 'auth:permissions-any';
export const ALLOW_PASSWORD_CHANGE = 'auth:allow-password-change';

/** The route needs no sign-in. Every other route requires one by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The caller must hold all of these permissions. */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS, codes);

/** The caller must hold at least one of these permissions. */
export const RequireAnyPermission = (...codes: string[]) => SetMetadata(PERMISSIONS_ANY, codes);

/** Usable even while the account still has to choose a new password (sign out, change password). */
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

/** The signed-in user. Only available on routes that are not @Public(). */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
  if (!auth) throw new Error('CurrentAuth used on a route that is not authenticated');
  return auth;
});
