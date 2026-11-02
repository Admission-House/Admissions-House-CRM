'use client';

import { Check, Copy, Download, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button, Field, Input, Notice, Panel, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/use-api';

interface Status { enabled: boolean; setupStarted: boolean; recoveryCodesLeft: number }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
/** The secret in groups of four, so it is easy to type if the QR code cannot be scanned. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/** The recovery codes, shown once, with a way to keep them. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  function download() {
    const href = URL.createObjectURL(new Blob([`Recovery codes for two-step sign-in\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="space-y-4">
      <Notice tone="ok">Two-step sign-in is on.</Notice>
      <p className="max-w-xl text-sm text-muted">
        Keep these recovery codes somewhere safe, such as a password manager. If you lose your phone, each code lets you sign in once. They are shown only now.
      </p>
      <ul className="grid max-w-md grid-cols-2 gap-2 rounded-lg border border-line bg-head p-4 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)); }}>{copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copied ? 'Copied' : 'Copy'}</Button>
        <Button variant="secondary" onClick={download}><Download className="h-4 w-4" aria-hidden /> Download</Button>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> I have saved these codes</label>
      <Button disabled={!saved} onClick={onDone}>Done</Button>
    </div>
  );
}

/** Turning it on: the password, then the QR code and the first code from the app. */
function Setup({ onFinished, onCancel }: { onFinished: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!secret) return;
    let live = true;
    void QRCode.toDataURL(secret.otpauthUrl, { margin: 1, width: 192 }).then((url) => { if (live) setQr(url); });
    return () => { live = false; };
  }, [secret]);

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={onFinished} />;

  if (!secret) {
    return (
      <form className="max-w-sm space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => setSecret(await api('/auth/mfa/setup', { method: 'POST', body: { password } }))); }}>
        {error && <Notice tone="bad">{error}</Notice>}
        <p className="text-sm text-muted">You will need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or Authy. First, enter your password to confirm it is you.</p>
        <Field label="Your password" htmlFor="mfa-pw"><Input id="mfa-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <div className="flex gap-2"><Button type="submit" loading={busy} disabled={!password}>Continue</Button><Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button></div>
      </form>
    );
  }

  return (
    <form className="max-w-md space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => setCodes((await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', { method: 'POST', body: { code } })).recoveryCodes)); }}>
      {error && <Notice tone="bad">{error}</Notice>}
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>In your authenticator app, add an account and scan this picture.</li>
        <li>Type the 6-digit code the app shows now.</li>
      </ol>
      <div className="flex items-start gap-4">
        {/* The picture is a data URL made here, so the image optimiser has nothing to do. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qr ? <img src={qr} alt="QR code to scan with your authenticator app" width={192} height={192} className="rounded-lg border border-line" /> : <Spinner />}
        <div className="text-sm">
          <p className="text-muted">Cannot scan? Type this key into the app:</p>
          <p className="mt-1 break-all font-mono text-ink">{grouped(secret.secret)}</p>
        </div>
      </div>
      <Field label="6-digit code" htmlFor="mfa-code"><Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
      <div className="flex gap-2"><Button type="submit" loading={busy} disabled={code.replace(/\s/g, '').length !== 6}>Turn on</Button><Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

/** Turning it off needs the password and a current code, so a stolen session cannot do it. */
function TurnOff({ onFinished, onCancel }: { onFinished: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/mfa/disable', { method: 'POST', body: { password, code } });
      onFinished();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}
      <p className="text-sm text-muted">Enter your password and a code from your app (or a recovery code) to turn two-step sign-in off.</p>
      <Field label="Your password" htmlFor="off-pw"><Input id="off-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      <Field label="Code from your app, or a recovery code" htmlFor="off-code"><Input id="off-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
      <div className="flex gap-2"><Button type="submit" variant="danger" loading={busy} disabled={!password || code.trim().length < 6}>Turn off</Button><Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

/** Two-step sign-in: an authenticator app code after the password. */
export function TwoStep() {
  const status = useApi<Status>('/auth/mfa');
  const [mode, setMode] = useState<'view' | 'setup' | 'off'>('view');
  const done = () => { setMode('view'); status.reload(); };

  if (status.loading && !status.data) return <Spinner />;
  if (status.error) return <Notice tone="bad">{status.error.message}</Notice>;
  const s = status.data!;

  return (
    <Panel title="Two-step sign-in">
      {mode === 'setup' ? <Setup onFinished={done} onCancel={() => setMode('view')} /> : mode === 'off' ? <TurnOff onFinished={done} onCancel={() => setMode('view')} /> : (
        <div className="space-y-4">
          <p className="max-w-xl text-sm text-muted">
            With two-step sign-in, a code from an app on your phone is needed as well as your password. Someone who learns your password still cannot sign in. We recommend it for Super Admins and Admins.
          </p>
          {s.enabled ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-ok"><ShieldCheck className="h-4 w-4" aria-hidden /> Two-step sign-in is on. {s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? '' : 's'} left.</p>
              <Button variant="secondary" onClick={() => setMode('off')}>Turn off</Button>
            </>
          ) : (
            <Button onClick={() => setMode('setup')}>Turn on two-step sign-in</Button>
          )}
        </div>
      )}
    </Panel>
  );
}
