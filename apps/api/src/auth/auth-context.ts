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
  /** True for people who sign in from the office; their attendance is recorded at sign-in. */
  tracksAttendance: boolean;
  ip: string;
  requestId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
