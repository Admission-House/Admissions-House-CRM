import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from './auth-context.js';

export const IS_PUBLIC = 'auth:public';
export const PERMISSIONS = 'auth:permissions';
export const PERMISSIONS_ANY = 'auth:permissions-any';
export const ALLOW_PASSWORD_CHANGE = 'auth:allow-password-change';
export const ALLOW_MFA_SETUP = 'auth:allow-mfa-setup';
export const HEAVY = 'auth:heavy';

/** The route needs no sign-in. Every other route requires one by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The caller must hold all of these permissions. */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS, codes);

/** The caller must hold at least one of these permissions. */
export const RequireAnyPermission = (...codes: string[]) => SetMetadata(PERMISSIONS_ANY, codes);

/**
 * An expensive operation (an export, an import, an upload, a file download). Each signed-in user
 * gets a smaller allowance for these than for ordinary requests, so one person (or one stolen
 * session) cannot use them to slow everyone else down or copy the data out in bulk.
 */
export const Heavy = () => SetMetadata(HEAVY, true);

/** Usable even while the account still has to choose a new password (sign out, change password). */
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);
/** A route a person may use before two-step sign-in is set up, when their company requires it. */
export const AllowMfaSetup = () => SetMetadata(ALLOW_MFA_SETUP, true);

/** The signed-in user. Only available on routes that are not @Public(). */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
  if (!auth) throw new Error('CurrentAuth used on a route that is not authenticated');
  return auth;
});
