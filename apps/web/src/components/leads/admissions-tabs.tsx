'use client';

import { Check, MapPin, Plus, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, Textarea, cx } from '@/components/ui';
import { LocationPicker, type Place } from '@/components/ui/location-picker';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import type { LeadDetail } from './lead-panels';

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const rupees = (n: number | null) => (n === null ? '—' : `₹ ${n.toLocaleString('en-IN')}`);

interface CollegeItem {
  id: string;
  name: string;
  location: { id: string; name: string; state: string | null } | null;
  courseCount: number;
  offersOnline: boolean;
  offersRegular: boolean;
}

interface CollegeCourse {
  id: string;
  course: { id: string; name: string; level: string; stream: string | null };
  deliveryMode: string;
  cafFee: number | null;
  annualFee: number | null;
  durationYears: number | null;
  isActive: boolean;
}

interface Recommendation {
  college: { id: string; name: string; location: string | null };
  recommendedBy: string | null;
  at: string;
  shortlisted: boolean;
}

export interface Shortlist {
  id: string;
  college: { id: string; name: string; location: string | null };
  formStatus: 'not_started' | 'filled' | 'submitted';
  reconciliationStatus: 'not_sent' | 'mail_sent' | 'reconciled';
  payment: { status: string; amount: number | null; paidAt: string | null };
  niDnp: { kind: 'ni' | 'dnp'; reason: string | null } | null;
  courses: { collegeCourseId: string; course: { id: string; name: string; level: string }; deliveryMode: string; cafFee: number | null; annualFee: number | null; durationYears: number | null }[];
  shortlistedBy: string | null;
  createdAt: string;
}

const FORM_LABEL = { not_started: 'Not started', filled: 'Form filled', submitted: 'Form submitted' } as const;
const RECON_LABEL = { not_sent: 'Not sent', mail_sent: 'Mail sent', reconciled: 'Reconciled' } as const;

// ------------------------------------------------------- choose courses

/** Pick the courses a student wants at one college. Fees are read from the college, never typed here. */
function ShortlistModal({ lead, college, existing, onClose, onDone }: { lead: LeadDetail; college: { id: string; name: string }; existing?: Shortlist; onClose: () => void; onDone: () => void }) {
  const detail = useApi<{ courses: CollegeCourse[] }>(`/colleges/${college.id}`);
  const [chosen, setChosen] = useState<Set<string>>(new Set(existing?.courses.map((c) => c.collegeCourseId) ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const courses = detail.data?.courses.filter((c) => c.isActive) ?? [];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (existing) await api(`/leads/${lead.id}/shortlists/${existing.id}`, { method: 'PATCH', body: { collegeCourseIds: [...chosen] } });
      else await api(`/leads/${lead.id}/shortlists`, { method: 'POST', body: { collegeId: college.id, collegeCourseIds: [...chosen] } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `Courses at ${college.name}` : `Shortlist ${college.name}`} onClose={onClose} width="max-w-2xl">
      {error && <div className="mb-3"><Notice tone="bad">{error}</Notice></div>}
      {detail.loading && !detail.data ? <Spinner /> : courses.length === 0 ? <Empty title="This college has no courses listed yet" /> : (
        <div className="overflow-hidden rounded-md border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-head text-xs uppercase tracking-wide text-muted"><tr><th className="w-9 px-3 py-2" /><th className="px-3 py-2">Course</th><th className="px-3 py-2">Mode</th><th className="px-3 py-2 text-right">CAF</th><th className="px-3 py-2 text-right">Fee (annual)</th><th className="px-3 py-2 text-right">Duration</th></tr></thead>
            <tbody className="divide-y divide-line">
              {courses.map((c) => (
                <tr key={c.id} className="hover:bg-mint-50">
                  <td className="px-3 py-2"><input type="checkbox" aria-label={c.course.name} checked={chosen.has(c.id)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} className="h-3.5 w-3.5 accent-[#0f625e]" /></td>
                  <td className="px-3 py-2 font-medium">{c.course.name}<span className="ml-1.5 text-xs font-normal text-muted">{c.course.level}</span></td>
                  <td className="px-3 py-2 capitalize text-muted">{c.deliveryMode}</td>
                  <td className="tabular px-3 py-2 text-right">{rupees(c.cafFee)}</td>
                  <td className="tabular px-3 py-2 text-right">{rupees(c.annualFee)}</td>
                  <td className="px-3 py-2 text-right text-muted">{c.durationYears ? `${c.durationYears} yr` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy}>{existing ? 'Save courses' : 'Shortlist'}</Button></div>
    </Modal>
  );
}

// ---------------------------------------------------------- recommended

export function RecommendedTab({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const manage = can('shortlist.manage');
  const [q, setQ] = useState('');
  const [place, setPlace] = useState<Place[]>([]);
  const [mode, setMode] = useState('');
  const [courseId, setCourseId] = useState('');
  const recommended = useApi<Recommendation[]>(`/leads/${lead.id}/recommendations`);
  const courses = useApi<Page<{ id: string; name: string; level: string }>>('/courses', { limit: 100 });
  const colleges = useApi<Page<CollegeItem>>('/colleges', { leadId: lead.id, q: q.trim() || undefined, locationId: place[0]?.id, courseId: courseId || undefined, mode: mode || undefined, limit: 24 });
  const [shortlisting, setShortlisting] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recommendedIds = new Set(recommended.data?.map((r) => r.college.id));

  async function recommend(id: string) {
    setError(null);
    try {
      await api(`/leads/${lead.id}/recommendations`, { method: 'POST', body: { collegeId: id } });
      recommended.reload();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function unrecommend(id: string) {
    setError(null);
    try {
      await api(`/leads/${lead.id}/recommendations/${id}`, { method: 'DELETE' });
      recommended.reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}

      <Card>
        <div className="border-b border-line px-4 py-3"><h2 className="text-sm font-semibold">Find colleges</h2></div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Name"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a college" /></Field>
          <Field label="City or state"><LocationPicker value={place} onChange={setPlace} /></Field>
          <Field label="Course">
            <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">Any course</option>{courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.level})</option>)}</Select>
          </Field>
          <Field label="Study mode" hint={lead.studyMode ? `This student prefers ${lead.studyMode}` : undefined}>
            <Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="">{lead.studyMode ? 'Student preference' : 'Online or regular'}</option><option value="online">Online</option><option value="regular">Regular</option><option value="any">Any</option></Select>
          </Field>
        </div>
        {colleges.loading && !colleges.data ? <Spinner /> : (colleges.data?.items.length ?? 0) === 0 ? <Empty title="No colleges match">Change a filter, or ask an admin to add the college.</Empty> : (
          <ul className="divide-y divide-line border-t border-line">
            {colleges.data!.items.map((c) => {
              const isRec = recommendedIds.has(c.id);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-info">{c.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      {c.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden />{c.location.name}{c.location.state ? `, ${c.location.state}` : ''}</span>}
                      <span>{c.courseCount} course{c.courseCount === 1 ? '' : 's'}</span>
                      {c.offersOnline && <Badge tone="info">Online</Badge>}
                      {c.offersRegular && <Badge tone="neutral">Regular</Badge>}
                    </p>
                  </div>
                  {manage && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" disabled={isRec} onClick={() => void recommend(c.id)}>{isRec ? <><Check className="h-3.5 w-3.5" aria-hidden /> Recommended</> : 'Recommend'}</Button>
                      <Button size="sm" onClick={() => setShortlisting({ id: c.id, name: c.name })}>Shortlist</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <div className="border-b border-line px-4 py-3"><h2 className="text-sm font-semibold">Recommended to {lead.name}</h2></div>
        {recommended.loading && !recommended.data ? <Spinner /> : (recommended.data?.length ?? 0) === 0 ? <Empty title="Nothing recommended yet">Pick colleges above to suggest them to the student.</Empty> : (
          <ul className="divide-y divide-line">
            {recommended.data!.map((r) => (
              <li key={r.college.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-info">{r.college.name}</p>
                  <p className="text-xs text-muted">{r.college.location ?? ''}{r.recommendedBy ? ` · by ${r.recommendedBy}` : ''} · {fmtDateTime(r.at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {r.shortlisted ? <Badge tone="ok">Shortlisted</Badge> : manage && <Button size="sm" onClick={() => setShortlisting({ id: r.college.id, name: r.college.name })}>Shortlist</Button>}
                  {manage && !r.shortlisted && <Button size="sm" variant="ghost" aria-label={`Remove ${r.college.name}`} onClick={() => void unrecommend(r.college.id)}><Trash2 className="h-3.5 w-3.5 text-bad" aria-hidden /></Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {shortlisting && <ShortlistModal lead={lead} college={shortlisting} onClose={() => setShortlisting(null)} onDone={() => { setShortlisting(null); recommended.reload(); onChanged(); }} />}
    </div>
  );
}

// ---------------------------------------------------------- shortlisted

function PaymentBox({ lead, s, manage, onChanged }: { lead: LeadDetail; s: Shortlist; manage: boolean; onChanged: () => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paid = s.payment.status === 'completed' || s.payment.amount !== null;

  async function record() {
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/shortlists/${s.id}/payment`, { method: 'PUT', body: { amount: Number(amount) } });
      setAmount('');
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    try {
      await api(`/leads/${lead.id}/shortlists/${s.id}/payment`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="rounded-md border border-line p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Payment status</p>
      {paid ? (
        <div className="text-sm">
          <p className="flex items-center gap-1.5 font-medium text-ok"><Check className="h-3.5 w-3.5" aria-hidden /> Payment completed</p>
          <p className="mt-1 text-muted">Amount: <span className="tabular font-medium text-ink">{rupees(s.payment.amount)}</span></p>
          {s.payment.paidAt && <p className="text-muted">{fmtDateTime(s.payment.paidAt)}</p>}
          {manage && <button onClick={() => void clear()} className="mt-2 text-xs font-medium text-bad hover:underline">Remove this payment</button>}
        </div>
      ) : manage ? (
        <div className="flex gap-2">
          <Input aria-label="Amount paid" inputMode="decimal" placeholder="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button size="sm" variant="secondary" disabled={!Number(amount)} loading={busy} onClick={() => void record()}>Record</Button>
        </div>
      ) : <p className="text-sm text-muted">Not paid yet</p>}
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
    </div>
  );
}

function ShortlistCard({ lead, s, manage, onChanged }: { lead: LeadDetail; s: Shortlist; manage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [kind, setKind] = useState<'ni' | 'dnp'>('ni');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: object) {
    setError(null);
    try {
      await api(`/leads/${lead.id}/shortlists/${s.id}`, { method: 'PATCH', body });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function mark() {
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/shortlists/${s.id}/ni-dnp`, { method: 'PUT', body: { kind, reason } });
      setMarking(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    try {
      await api(`/leads/${lead.id}/shortlists/${s.id}/ni-dnp`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function remove() {
    try {
      await api(`/leads/${lead.id}/shortlists/${s.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Card className={cx(s.niDnp && 'opacity-90')}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-info">{s.college.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
            {s.college.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden />{s.college.location}</span>}
            <span>{s.shortlistedBy ? `by ${s.shortlistedBy}, ` : ''}{fmtDateTime(s.createdAt)}</span>
            {s.niDnp && <Badge tone={s.niDnp.kind === 'ni' ? 'warn' : 'bad'}>{s.niDnp.kind === 'ni' ? 'Not interested' : 'Did not pick'}</Badge>}
          </p>
        </div>
        {manage && (
          <div className="flex gap-2">
            {s.niDnp ? <Button size="sm" variant="secondary" onClick={() => void undo()}><Undo2 className="h-3.5 w-3.5" aria-hidden /> Move back</Button> : <Button size="sm" variant="secondary" onClick={() => setMarking(true)}>Mark NI / DNP</Button>}
            <Button size="sm" variant="danger" onClick={() => void remove()}>Remove</Button>
          </div>
        )}
      </div>

      {error && <div className="px-4 pt-3"><Notice tone="bad">{error}</Notice></div>}
      {s.niDnp?.reason && <p className="mx-4 mt-3 rounded-md bg-warn-50 px-3 py-2 text-xs text-warn">{s.niDnp.reason}</p>}

      <div className="grid gap-3 p-4 md:grid-cols-3">
        <div className="rounded-md border border-line p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Product status</p>
          <Select aria-label="Form status" value={s.formStatus} disabled={!manage} onChange={(e) => void patch({ formStatus: e.target.value })}>
            {Object.entries(FORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        <div className="rounded-md border border-line p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Reconciliation status</p>
          <Select aria-label="Reconciliation status" value={s.reconciliationStatus} disabled={!manage} onChange={(e) => void patch({ reconciliationStatus: e.target.value })}>
            {Object.entries(RECON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        <PaymentBox lead={lead} s={s} manage={manage} onChanged={onChanged} />
      </div>

      <div className="mx-4 mb-4 overflow-hidden rounded-md border border-line">
        <div className="flex items-center justify-between bg-head px-3 py-2"><p className="text-[13px] font-semibold">Shortlisted courses ({s.courses.length})</p>{manage && <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"><Plus className="h-3 w-3" aria-hidden /> Add or change</button>}</div>
        {s.courses.length === 0 ? <p className="px-3 py-3 text-xs text-muted">No courses chosen yet.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-subtle"><tr><th className="px-3 py-1.5">Course</th><th className="px-3 py-1.5 text-right">CAF</th><th className="px-3 py-1.5 text-right">Fee (annual)</th><th className="px-3 py-1.5 text-right">Duration</th></tr></thead>
            <tbody className="divide-y divide-line">
              {s.courses.map((c) => <tr key={c.collegeCourseId}><td className="px-3 py-2 font-medium text-info">{c.course.name}</td><td className="tabular px-3 py-2 text-right">{rupees(c.cafFee)}</td><td className="tabular px-3 py-2 text-right">{rupees(c.annualFee)}</td><td className="px-3 py-2 text-right text-muted">{c.durationYears ? `${c.durationYears} Years` : '—'}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>

      {editing && <ShortlistModal lead={lead} college={s.college} existing={s} onClose={() => setEditing(false)} onDone={() => { setEditing(false); onChanged(); }} />}
      {marking && (
        <Modal title="Mark as not interested or did not pick" onClose={() => setMarking(false)}>
          <div className="space-y-4">
            <Field label="What happened">
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'ni' | 'dnp')}><option value="ni">Not interested (NI)</option><option value="dnp">Did not pick (DNP)</option></Select>
            </Field>
            <Field label="Reason" hint="So the next person knows why. At least 3 characters."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setMarking(false)}>Cancel</Button><Button loading={busy} disabled={reason.trim().length < 3} onClick={() => void mark()}>Save</Button></div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** One list of shortlisted colleges: the active ones, the ones marked NI or DNP, or the reconciled ones. */
export function ShortlistTab({ lead, view, onChanged, empty }: { lead: LeadDetail; view: 'active' | 'ni_dnp' | 'reconciled'; onChanged: () => void; empty: string }) {
  const { can } = useAuth();
  const list = useApi<Shortlist[]>(`/leads/${lead.id}/shortlists`, { view });
  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <Notice tone="bad">{list.error.message}</Notice>;
  if ((list.data?.length ?? 0) === 0) return <Card><Empty title={empty} /></Card>;
  return (
    <div className="space-y-4">
      {list.data!.map((s) => <ShortlistCard key={s.id} lead={lead} s={s} manage={can('shortlist.manage')} onChanged={() => { list.reload(); onChanged(); }} />)}
    </div>
  );
}
