'use client';

import { useRef, useState } from 'react';
import { Avatar, Button, Notice, Panel } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { START_PAGE_LABELS, type StartPageKey } from '@/lib/start-page';
import { shrinkPicture, usePhoto } from '@/lib/use-photo';
import { useApi } from '@/lib/use-api';

interface Prefs {
  startPage: StartPageKey | null;
  startPages: StartPageKey[];
  notify: { leads: boolean; calls: boolean; approvals: boolean };
  hasAvatar: boolean;
}

const KINDS: { key: keyof Prefs['notify']; label: string; hint: string }[] = [
  { key: 'leads', label: 'Leads and follow-ups', hint: 'A new lead, a lead given to you, a follow-up that is due.' },
  { key: 'calls', label: 'Calls and meetings', hint: 'Someone calling or inviting you.' },
  { key: 'approvals', label: 'Approvals', hint: 'Leave and other requests waiting for a decision.' },
];

const message = (e: unknown) => (e instanceof Error && !(e instanceof ApiError) ? e.message : e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/** The person's own photo, the page they land on after signing in, and which alerts they want. The same for every role. */
export function Preferences() {
  const { me, reload } = useAuth();
  const prefs = useApi<Prefs>('/me/preferences');
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'photo' | 'prefs' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const photo = usePhoto(me?.user.id, me?.user.avatarVersion);

  if (!me) return null;

  async function run(kind: 'photo' | 'prefs', work: () => Promise<unknown>, done: string) {
    setBusy(kind);
    setMsg(null);
    try {
      await work();
      await Promise.all([reload(), prefs.reload()]);
      setMsg({ tone: 'ok', text: done });
    } catch (e) {
      setMsg({ tone: 'bad', text: message(e) });
    } finally {
      setBusy(null);
    }
  }

  const choose = (f: File | undefined) => {
    if (!f) return;
    void run('photo', async () => api('/me/avatar', { method: 'PUT', body: { image: await shrinkPicture(f) } }), 'Your photo is saved.');
    if (file.current) file.current.value = '';
  };
  const data = prefs.data;

  return (
    <div className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Panel title="My photo">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={me.user.name} size={72} photo={photo} />
          <div>
            <p className="max-w-md text-sm text-muted">Your colleagues see this next to your name. A square picture of your face works best. JPEG, PNG or WebP, up to 5 MB.</p>
            <div className="mt-3 flex gap-2">
              <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="photo-file" onChange={(e) => choose(e.target.files?.[0])} />
              <Button type="button" loading={busy === 'photo'} onClick={() => file.current?.click()}>{data?.hasAvatar ? 'Change photo' : 'Choose a photo'}</Button>
              {data?.hasAvatar && <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void run('photo', () => api('/me/avatar', { method: 'DELETE' }), 'Your photo is removed.')}>Remove</Button>}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="After I sign in">
        <label htmlFor="start-page" className="block text-sm font-medium text-ink">Open this page first</label>
        <select
          id="start-page"
          className="mt-1.5 h-10 w-full max-w-xs rounded-lg border border-line bg-white px-3 text-sm text-ink"
          value={data?.startPage ?? ''}
          disabled={!data || busy !== null}
          onChange={(e) => void run('prefs', () => api('/me/preferences', { method: 'PUT', body: { startPage: e.target.value || null } }), 'Saved. You will land here next time you sign in.')}
        >
          <option value="">Dashboard (default)</option>
          {data?.startPages.filter((p) => p !== 'dashboard').map((p) => <option key={p} value={p}>{START_PAGE_LABELS[p]}</option>)}
        </select>
      </Panel>

      <Panel title="Alerts I want">
        <p className="max-w-xl text-sm text-muted">Switch off what you do not need. Security alerts and system messages always reach you.</p>
        <ul className="mt-3 max-w-xl divide-y divide-line/60">
          {KINDS.map((k) => (
            <li key={k.key} className="flex items-start justify-between gap-4 py-3">
              <label htmlFor={`n-${k.key}`} className="min-w-0 cursor-pointer">
                <span className="block text-sm font-medium text-ink">{k.label}</span>
                <span className="block text-xs text-muted">{k.hint}</span>
              </label>
              <input
                id={`n-${k.key}`}
                type="checkbox"
                role="switch"
                className="mt-1 h-5 w-5 shrink-0 accent-brand"
                checked={data?.notify[k.key] ?? true}
                disabled={!data || busy !== null}
                onChange={(e) => void run('prefs', () => api('/me/preferences', { method: 'PUT', body: { notify: { [k.key]: e.target.checked } } }), 'Saved.')}
              />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
