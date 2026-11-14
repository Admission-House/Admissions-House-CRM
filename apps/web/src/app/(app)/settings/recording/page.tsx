'use client';

import { useState } from 'react';
import { Button, Field, Input, Notice, Panel, Select, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { RecordingPolicy } from '@/lib/communications';
import { useApi } from '@/lib/use-api';

const MODE_HELP: Record<RecordingPolicy['mode'], string> = {
  off: 'Calls and meetings are not recorded.',
  optional: 'The person who starts a meeting chooses whether to record it. Calls from a lead are recorded.',
  always: 'Every call and meeting is recorded.',
};

/** The company's recording rules. Changing the notice makes everyone agree to the new words next time. */
export default function RecordingSettingsPage() {
  const policy = useApi<RecordingPolicy>('/communications/recording/policy');
  const [mode, setMode] = useState<RecordingPolicy['mode'] | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  if (policy.error) return <Notice tone="bad">{policy.error.message}</Notice>;
  if (!policy.data) return <Spinner />;
  const p = policy.data;
  const m = mode ?? p.mode;
  const d = days ?? String(p.retentionDays);
  const n = notice ?? p.noticeText;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/communications/recording/policy', { method: 'PUT', body: { mode: m, retentionDays: Number(d), noticeText: n.trim() } });
      setMode(null); setDays(null); setNotice(null);
      policy.reload();
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof ApiError ? err.message : 'Cannot reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      {!p.ready && (
        <Notice tone="warn">
          Recording is not set up on the server yet, so nothing is recorded whatever you choose here.
          {p.missing && p.missing.length > 0 && <> Still missing: {p.missing.join(', ')}.</>}
        </Notice>
      )}
      <form onSubmit={(e) => void save(e)}>
        <Panel title="Recording rules">
          <div className="space-y-4">
            <Field label="Record calls and meetings" htmlFor="rec-mode" hint={MODE_HELP[m]}>
              <Select id="rec-mode" value={m} onChange={(e) => setMode(e.target.value as RecordingPolicy['mode'])}>
                <option value="off">Never</option><option value="optional">When chosen</option><option value="always">Always</option>
              </Select>
            </Field>
            <Field label="Keep recordings for (days)" htmlFor="rec-days" hint="After this, the files are deleted for good.">
              <Input id="rec-days" type="number" min={1} max={3650} value={d} onChange={(e) => setDays(e.target.value)} className="max-w-32" />
            </Field>
            <Field label="Notice shown before joining" htmlFor="rec-notice" hint="People must agree to this to join a recorded session. Have your legal advisor approve the words.">
              <Textarea id="rec-notice" rows={4} value={n} onChange={(e) => setNotice(e.target.value)} maxLength={1000} />
            </Field>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            <Button type="submit" loading={busy}>Save</Button>
          </div>
        </Panel>
      </form>
    </div>
  );
}
