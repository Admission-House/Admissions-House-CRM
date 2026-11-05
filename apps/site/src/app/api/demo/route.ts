import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { demoRequestSchema, toLead } from '@/lib/demo-request';
import { RateLimiter } from '@/lib/rate-limit';
import { crm } from '@/lib/site';

const limiter = new RateLimiter(5, 10 * 60_000);

/** The visitor's address as the proxy in front of this site reports it. */
function visitor(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(req: Request) {
  if (!limiter.allow(visitor(req))) {
    return NextResponse.json({ message: 'Too many requests. Please try again in a few minutes.' }, { status: 429 });
  }
  const body: unknown = await req.json().catch(() => null);
  const parsed = demoRequestSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key && !fields[key]) fields[key] = issue.message;
    }
    return NextResponse.json({ message: 'Please check the highlighted fields.', fields }, { status: 400 });
  }
  // A robot filled the hidden field: say thanks and drop it.
  if (parsed.data.website) return NextResponse.json({ ok: true });

  if (!crm.url || !crm.secret) {
    console.error('demo request refused: CRM_WEBHOOK_URL / CRM_WEBHOOK_SECRET are not set');
    return NextResponse.json({ message: 'We cannot take requests right now. Please call or email us.' }, { status: 503 });
  }

  const lead = toLead(parsed.data, { id: randomUUID(), now: new Date() });
  try {
    const res = await fetch(crm.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${crm.secret}`, 'idempotency-key': lead.id },
      body: JSON.stringify(lead),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.error(`demo request: CRM answered ${res.status}`);
      return NextResponse.json({ message: 'We could not save your request. Please call or email us.' }, { status: 502 });
    }
  } catch (err) {
    console.error('demo request: CRM unreachable', err instanceof Error ? err.message : err);
    return NextResponse.json({ message: 'We could not save your request. Please call or email us.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
