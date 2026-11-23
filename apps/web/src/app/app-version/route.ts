/**
 * Which deployment is serving the CRM right now. A tab that was opened before a new deployment notices the change
 * and offers a reload (components/shell/new-version.tsx), so nobody keeps working on old screens.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const id = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || 'local';
  return Response.json({ id }, { headers: { 'cache-control': 'no-store' } });
}
