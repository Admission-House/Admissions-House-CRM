'use client';

import { CheckCircle2, GraduationCap, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Field, Notice, Panel, Select, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import type { LeadDetail } from '@/components/leads/lead-panels';
import { useApi } from '@/lib/use-api';

interface Partner {
  key: string;
  name: string;
  configured: boolean;
  programs: { campus: string; course: string; specializations: string[] }[];
  states: string[];
}

interface Submission {
  id: string;
  partner: string;
  partnerName: string;
  state: 'sending' | 'sent' | 'failed';
  course: string | null;
  specialization: string | null;
  message: string | null;
  submittedBy: string | null;
  createdAt: string;
  /** The student did not pick up the college's call. */
  dnp: { at: string; reason: string | null; by: string | null } | null;
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/**
 * Sending the student to a college that takes leads through its own API. Shows what has already gone, and opens a form
 * to send the lead: the course and specialization, and the student's state and city, all from the college's own lists.
 */
export function PartnerPanel({ lead }: { lead: LeadDetail }) {
  const { can } = useAuth();
  const partners = useApi<Partner[]>('/partners');
  const sent = useApi<Submission[]>(`/leads/${lead.id}/partner-submissions`);
  const [open, setOpen] = useState<Partner | null>(null);
  const [dnpFor, setDnpFor] = useState<Submission | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  if (!partners.data || partners.data.length === 0) return null;
  const rows = sent.data ?? [];

  return (
    <Panel title="Send to a college">
      <ul className="space-y-3">
        {partners.data.map((p) => {
          const mine = rows.filter((r) => r.partner === p.key);
          const done = mine.find((r) => r.state === 'sent');
          return (
            <li key={p.key} className="rounded-lg border border-line p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <GraduationCap className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                </div>
                {done ? (done.dnp ? <Badge tone="bad">DNP</Badge> : <Badge tone="ok">Shortlisted</Badge>) : <Badge>Not sent</Badge>}
              </div>
              {mine.length > 0 && (
                <ul className="mt-2 space-y-1.5" aria-label={`Sent to ${p.name}`}>
                  {mine.slice(0, 3).map((r) => (
                    <li key={r.id} className="flex items-start gap-1.5 text-xs text-muted">
                      {r.state === 'failed' ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />}
                      <span>
                        {r.state === 'sending' ? 'Sending… ' : r.state === 'failed' ? 'Not accepted. ' : ''}
                        {r.course}{r.specialization ? `, ${r.specialization}` : ''}. {fmtDateTime(r.createdAt)}{r.submittedBy ? ` by ${r.submittedBy}` : ''}
                        {r.state === 'failed' && r.message ? ` (${r.message})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {done?.dnp && <p className="mt-2 rounded-md bg-warn-50 px-3 py-2 text-xs text-warn">DNP{done.dnp.by ? ` by ${done.dnp.by}` : ''}: {done.dnp.reason}</p>}
              {done && can('lead.update') && (
                done.dnp
                  ? <Button className="mt-3 w-full" variant="secondary" onClick={async () => { setMoveError(null); try { await api(`/leads/${lead.id}/partner-submissions/${done.id}/dnp`, { method: 'DELETE' }); sent.reload(); } catch (e) { setMoveError(errorText(e)); } }}>Move back to shortlisted</Button>
                  : <Button className="mt-3 w-full" variant="secondary" onClick={() => setDnpFor(done)}>Mark DNP</Button>
              )}
              {can('lead.update') && lead.status.isOpen && (
                p.configured
                  ? <Button className="mt-3 w-full" variant={done ? 'secondary' : 'primary'} onClick={() => setOpen(p)}>{done ? 'Send again' : `Send to ${p.name}`}</Button>
                  : <p className="mt-3 text-xs text-muted">Not set up yet. Your Super Admin needs to add the college&apos;s key.</p>
              )}
            </li>
          );
        })}
      </ul>
      {moveError && <Notice tone="bad">{moveError}</Notice>}
      {dnpFor && <DnpModal lead={lead} submission={dnpFor} onClose={() => setDnpFor(null)} onDone={() => { setDnpFor(null); sent.reload(); }} />}
      {open && (
        <SendModal
          partner={open}
          lead={lead}
          already={rows.some((r) => r.partner === open.key && r.state === 'sent')}
          onClose={() => setOpen(null)}
          onSent={() => { setOpen(null); sent.reload(); }}
        />
      )}
    </Panel>
  );
}

function SendModal({ partner, lead, already, onClose, onSent }: { partner: Partner; lead: LeadDetail; already: boolean; onClose: () => void; onSent: () => void }) {
  const [course, setCourse] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cities = useApi<string[]>(state ? `/partners/${partner.key}/cities` : null, { state });

  const program = partner.programs.find((p) => p.course === course);
  const noEmail = !lead.email;
  const ready = !!course && !!specialization && !!state && !!city && agreed && !noEmail;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: boolean; message: string }>(`/leads/${lead.id}/partners/${partner.key}/send`, { method: 'POST', body: { course, specialization, state, city, ...(already && { resend: true }) } });
      if (r.ok) onSent();
      else setError(r.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Send to ${partner.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (ready) void send(); }} className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        {noEmail && <Notice tone="warn">This student has no email address. Add one first: the college needs it.</Notice>}
        {already && <Notice tone="warn">This lead has already been sent to {partner.name}. Send again only if the college asked for it.</Notice>}
        <Field label="Course" htmlFor="pc" required>
          <Select id="pc" value={course} onChange={(e) => { setCourse(e.target.value); setSpecialization(''); }} required>
            <option value="">Choose a course</option>
            {partner.programs.map((p) => <option key={p.course} value={p.course}>{p.course}</option>)}
          </Select>
        </Field>
        <Field label="Specialization" htmlFor="ps" required>
          <Select id="ps" value={specialization} onChange={(e) => setSpecialization(e.target.value)} disabled={!program} required>
            <option value="">{program ? 'Choose a specialization' : 'Choose a course first'}</option>
            {(program?.specializations ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Student's state" htmlFor="pst" required>
            <Select id="pst" value={state} onChange={(e) => { setState(e.target.value); setCity(''); }} required>
              <option value="">Choose a state</option>
              {partner.states.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Student's city" htmlFor="pci" required>
            <Select id="pci" value={city} onChange={(e) => setCity(e.target.value)} disabled={!state || cities.loading} required>
              <option value="">{!state ? 'Choose a state first' : cities.loading ? 'Loading…' : 'Choose a city'}</option>
              {(cities.data ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <div className="rounded-md bg-head px-3 py-2 text-xs text-muted">
          What is sent: <span className="font-medium text-ink">{lead.name}</span>, <span className="font-medium text-ink">{lead.phone.length === 12 && lead.phone.startsWith('91') ? lead.phone.slice(2) : lead.phone}</span>
          {lead.email ? <>, <span className="font-medium text-ink">{lead.email}</span></> : null}, with the course, specialization, state and city above.
        </div>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#0f625e]" />
          <span>The student has agreed to share these details with {partner.name}.</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!ready}>Send</Button>
        </div>
      </form>
    </Modal>
  );
}

function DnpModal({ lead, submission, onClose, onDone }: { lead: LeadDetail; submission: Submission; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/partner-submissions/${submission.id}/dnp`, { method: 'POST', body: { reason: reason.trim() } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={`Mark DNP with ${submission.partnerName}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) void save(); }} className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Reason" hint="So the next person knows why. At least 3 characters." htmlFor="dnpr"><Textarea id="dnpr" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={reason.trim().length < 3}>Save</Button></div>
      </form>
    </Modal>
  );
}
