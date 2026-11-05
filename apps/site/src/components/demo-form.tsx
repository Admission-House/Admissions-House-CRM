'use client';

import { useState } from 'react';
import { TEAM_SIZES } from '@/lib/demo-request';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' } | { kind: 'error'; message: string; fields?: Record<string, string> };

export function DemoForm() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      if (res.ok) return setState({ kind: 'done' });
      const body = (await res.json().catch(() => ({}))) as { message?: string; fields?: Record<string, string> };
      setState({ kind: 'error', message: body.message ?? 'Something went wrong. Please try again.', fields: body.fields });
    } catch {
      setState({ kind: 'error', message: 'We could not reach the server. Check your connection and try again.' });
    }
  }

  if (state.kind === 'done') {
    return (
      <div role="status">
        <h2 className="text-xl font-bold text-ok">Thank you, we have your request</h2>
        <p className="mt-2 text-muted">We will call you soon to arrange the demo.</p>
      </div>
    );
  }

  const fields = state.kind === 'error' ? (state.fields ?? {}) : {};
  const err = (name: string) => fields[name] && <p className="mt-1 text-sm text-bad">{fields[name]}</p>;

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <label className="block">Your name
        <input name="name" required autoComplete="name" className="field mt-1" aria-invalid={!!fields.name} />{err('name')}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">Email
          <input name="email" type="email" required autoComplete="email" className="field mt-1" aria-invalid={!!fields.email} />{err('email')}
        </label>
        <label className="block">Mobile number
          <input name="phone" type="tel" required autoComplete="tel" className="field mt-1" aria-invalid={!!fields.phone} />{err('phone')}
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">Company
          <input name="company" required autoComplete="organization" className="field mt-1" aria-invalid={!!fields.company} />{err('company')}
        </label>
        <label className="block">City (optional)
          <input name="city" autoComplete="address-level2" className="field mt-1" />
        </label>
      </div>
      <label className="block">Team size
        <select name="teamSize" required defaultValue="" className="field mt-1" aria-invalid={!!fields.teamSize}>
          <option value="" disabled>Choose</option>
          {TEAM_SIZES.map((t) => <option key={t}>{t}</option>)}
        </select>{err('teamSize')}
      </label>
      <label className="block">Anything we should know? (optional)
        <textarea name="message" rows={3} maxLength={600} className="field mt-1" />
      </label>
      {/* Hidden from people; a robot that fills it in is ignored. */}
      <div aria-hidden="true" className="absolute -left-[9999px]">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      {state.kind === 'error' && <p role="alert" className="text-bad">{state.message}</p>}
      <button type="submit" className="btn btn-primary" disabled={state.kind === 'sending'}>
        {state.kind === 'sending' ? 'Sending…' : 'Request a demo'}
      </button>
    </form>
  );
}
