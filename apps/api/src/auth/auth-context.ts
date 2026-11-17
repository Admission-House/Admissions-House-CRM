export type RoleKey = 'super_admin' | 'admin' | 'counsellor';
export type DataScope = 'all' | 'team' | 'own';

/** Who is making the request, as established by the AuthGuard. Passed explicitly to services. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  sessionId: string;
  name: string;
  email: string;
  roleId: string;
  /** Set for the three standard roles; null for roles a company created itself. */
  roleKey: RoleKey | null;
  dataScope: DataScope;
  permissions: ReadonlySet<string>;
  mustChangePassword: boolean;
  /** The company requires two-step sign-in for this role and this person has not set it up yet. */
  mfaSetupRequired: boolean;
  /** True when signing in records the person's attendance (the office roles, and the Super Admin). */
  tracksAttendance: boolean;
  /** True when the person must sign in from the office. Others (the Super Admin) can also check in without signing in again. */
  requiresOffice: boolean;
  ip: string;
  requestId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
