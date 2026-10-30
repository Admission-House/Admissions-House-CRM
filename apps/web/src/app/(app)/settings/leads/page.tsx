'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Select, Spinner, Tabs, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { LocationPicker, type Place } from '@/components/ui/location-picker';
import { api, ApiError } from '@/lib/api';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

const QUEUES: Record<string, string> = { fresh: 'Fresh', missed: 'Missed', followup: 'Follow-up', counselled: 'Counselled', fee_paid: 'Application fee paid', closed: 'Closed' };
const CHANNELS: Record<string, string> = { website: 'Website', ads: 'Ads', portal: 'Portal', call: 'Phone call', referral: 'Referral', walk_in: 'Walk-in', import: 'Import', other: 'Other' };
const STRATEGY: Record<string, string> = { round_robin: 'Take turns', least_busy: 'Least busy first', fixed: 'Always the first person' };

interface Status { id: string; name: string; queue: string; isOpen: boolean; requiresFollowup: boolean; sortOrder: number; isActive: boolean; substatuses: { id: string; name: string }[] }
interface Source { id: string; name: string; channelType: string; isActive: boolean }
interface Rule { id: string; name: string; priority: number; sourceId: string | null; courseId: string | null; locationId: string | null; studyMode: string | null; strategy: string; isActive: boolean; users: { id: string; name: string }[] }
interface Policy { duplicateAction: 'attach' | 'reject'; autoAssign: boolean; downloadForms: string[] }

/** Saves, then reports the result; keeps every form below short. */
function useSave(done: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      done();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }
  return { busy, error, run, fe: (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message };
}

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return <label htmlFor={id} className="flex items-center gap-2.5 text-sm"><input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" />{children}</label>;
}

// ------------------------------------------------------------------ statuses

function StatusForm({ status, onClose, onSaved }: { status?: Status; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(status?.name ?? '');
  const [queue, setQueue] = useState(status?.queue ?? 'followup');
  const [isOpen, setOpen] = useState(status?.isOpen ?? true);
  const [needs, setNeeds] = useState(status?.requiresFollowup ?? false);
  const [active, setActive] = useState(status?.isActive ?? true);
  const { busy, error, run, fe } = useSave(onSaved);
  return (
    <Modal title={status ? `Edit ${status.name}` : 'New status'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => (status ? api(`/lead-statuses/${status.id}`, { method: 'PATCH', body: { name: name.trim(), queue, isOpen, requiresFollowup: needs, isActive: active } }) : api('/lead-statuses', { method: 'POST', body: { name: name.trim(), queue, isOpen, requiresFollowup: needs } }))); }} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Name" htmlFor="sn" required error={fe('name')}><Input id="sn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <Field label="Shows in the list" htmlFor="sq" hint="Leads with this status appear under this heading in the menu" error={fe('queue')}>
          <Select id="sq" value={queue} onChange={(e) => setQueue(e.target.value)}>{Object.entries(QUEUES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        <Check id="so" checked={isOpen} onChange={setOpen}>The lead is still being worked on (leave off for a final status)</Check>
        <Check id="sf" checked={needs} onChange={setNeeds}>Ask for the next follow-up when a lead is moved here</Check>
        {status && <Check id="sa" checked={active} onChange={setActive}>In use</Check>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function SubstatusAdd({ status, onDone }: { status: Status; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const { busy, error, run } = useSave(() => { setName(''); setOpen(false); onDone(); });
  if (!open) return <button onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"><Plus className="h-3 w-3" aria-hidden /> Add a reason</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run(() => api(`/lead-statuses/${status.id}/substatuses`, { method: 'POST', body: { name: name.trim() } })); }} className="mt-2 flex items-center gap-2">
      <Input aria-label={`New reason under ${status.name}`} autoFocus placeholder="Reason" value={name} onChange={(e) => setName(e.target.value)} minLength={2} required className="h-8 max-w-56" />
      <Button size="sm" variant="secondary" type="submit" loading={busy}>Add</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
      {error && <span role="alert" className="text-xs text-bad">{error.message}</span>}
    </form>
  );
}

function StatusesTab() {
  const statuses = useApi<Status[]>('/lead-statuses');
  const [form, setForm] = useState<Status | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function dropSub(id: string) {
    setNotice(null);
    try { await api(`/lead-substatuses/${id}`, { method: 'DELETE' }); statuses.reload(); } catch (e) { setNotice(errorText(e)); }
  }
  return (
    <Panel title="Lead statuses" flush actions={<Button onClick={() => setForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New status</Button>}>
      {notice && <div className="p-3 pb-0"><Notice tone="bad">{notice}</Notice></div>}
      {statuses.error ? <div className="p-4"><Notice tone="bad">{statuses.error.message}</Notice></div> : !statuses.data ? <Spinner /> : (
        <ul className="divide-y divide-line">
          {statuses.data.map((s) => (
            <li key={s.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">{s.name}<Badge tone="brand">{QUEUES[s.queue] ?? s.queue}</Badge>{!s.isOpen && <Badge>Final</Badge>}{s.requiresFollowup && <Badge tone="info">Asks for follow-up</Badge>}{!s.isActive && <Badge tone="warn">Not in use</Badge>}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setForm(s)}>Edit</Button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {s.substatuses.map((x) => (
                  <span key={x.id} className="inline-flex items-center gap-1 rounded-md bg-head px-2 py-1 text-xs text-ink">{x.name}<button onClick={() => void dropSub(x.id)} aria-label={`Remove ${x.name}`} className="text-muted hover:text-bad"><Trash2 className="h-3 w-3" /></button></span>
                ))}
              </div>
              <SubstatusAdd status={s} onDone={statuses.reload} />
            </li>
          ))}
        </ul>
      )}
      {form && <StatusForm status={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); statuses.reload(); }} />}
    </Panel>
  );
}

// ------------------------------------------------------------------- sources

function SourceForm({ source, onClose, onSaved }: { source?: Source; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(source?.name ?? '');
  const [channel, setChannel] = useState(source?.channelType ?? 'website');
  const [active, setActive] = useState(source?.isActive ?? true);
  const { busy, error, run, fe } = useSave(onSaved);
  return (
    <Modal title={source ? `Edit ${source.name}` : 'New source'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => (source ? api(`/lead-sources/${source.id}`, { method: 'PATCH', body: { name: name.trim(), channelType: channel, isActive: active } }) : api('/lead-sources', { method: 'POST', body: { name: name.trim(), channelType: channel } }))); }} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Name" htmlFor="cn" required error={fe('name')}><Input id="cn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <Field label="Kind" htmlFor="ck" error={fe('channelType')}><Select id="ck" value={channel} onChange={(e) => setChannel(e.target.value)}>{Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        {source && <Check id="ca" checked={active} onChange={setActive}>In use</Check>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function SourcesTab() {
  const sources = useApi<Source[]>('/lead-sources');
  const [form, setForm] = useState<Source | 'new' | null>(null);
  return (
    <Panel title="Lead sources" flush actions={<Button onClick={() => setForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New source</Button>}>
      {sources.error ? <div className="p-4"><Notice tone="bad">{sources.error.message}</Notice></div> : !sources.data ? <Spinner /> : (
        <ul className="divide-y divide-line">
          {sources.data.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="flex items-center gap-2 text-[15px] font-medium">{s.name}<Badge>{CHANNELS[s.channelType] ?? s.channelType}</Badge>{!s.isActive && <Badge tone="warn">Not in use</Badge>}</p>
              <Button size="sm" variant="secondary" onClick={() => setForm(s)}>Edit</Button>
            </li>
          ))}
        </ul>
      )}
      {form && <SourceForm source={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); sources.reload(); }} />}
    </Panel>
  );
}

// --------------------------------------------------------------------- rules

function RuleForm({ rule, onClose, onSaved }: { rule?: Rule; onClose: () => void; onSaved: () => void }) {
  const sources = useApi<Source[]>('/lead-sources');
  const courses = useApi<Page<{ id: string; name: string }>>('/courses', { limit: 100 });
  const people = useApi<Page<{ id: string; name: string; role: { key: string | null; name: string } }>>('/users', { limit: 100, status: 'active' });
  const [name, setName] = useState(rule?.name ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 10));
  const [sourceId, setSourceId] = useState(rule?.sourceId ?? '');
  const [courseId, setCourseId] = useState(rule?.courseId ?? '');
  const [place, setPlace] = useState<Place[]>([]);
  const [mode, setMode] = useState(rule?.studyMode ?? '');
  const [strategy, setStrategy] = useState(rule?.strategy ?? 'round_robin');
  const [userIds, setUserIds] = useState<string[]>(rule?.users.map((u) => u.id) ?? []);
  const [active, setActive] = useState(rule?.isActive ?? true);
  const { busy, error, run, fe } = useSave(onSaved);
  const body = () => ({ name: name.trim(), priority: Number(priority), sourceId: sourceId || null, courseId: courseId || null, locationId: place[0]?.id ?? rule?.locationId ?? null, studyMode: mode || null, strategy, userIds, isActive: active });
  return (
    <Modal title={rule ? `Edit ${rule.name}` : 'New assignment rule'} onClose={onClose} width="max-w-2xl">
      <form onSubmit={(e) => { e.preventDefault(); void run(() => (rule ? api(`/assignment-rules/${rule.id}`, { method: 'PATCH', body: body() }) : api('/assignment-rules', { method: 'POST', body: body() }))); }} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rule name" htmlFor="rn" required error={fe('name')}><Input id="rn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
          <Field label="Order" htmlFor="rp" hint="Rules are tried from the lowest number; the first match decides" error={fe('priority')}><Input id="rp" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} required /></Field>
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">When a lead matches</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Source" htmlFor="rs"><Select id="rs" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">Any source</option>{sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Course" htmlFor="rc"><Select id="rc" value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">Any course</option>{courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Study mode" htmlFor="rm"><Select id="rm" value={mode} onChange={(e) => setMode(e.target.value)}><option value="">Any</option><option value="regular">Regular</option><option value="online">Online</option></Select></Field>
          <Field label="Location" htmlFor="rl" hint={rule?.locationId && place.length === 0 ? 'A location is set. Search to change it.' : 'Leave empty for any'}><LocationPicker id="rl" value={place} onChange={setPlace} /></Field>
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Then give it to</p>
        <Field label="How" htmlFor="rh"><Select id="rh" value={strategy} onChange={(e) => setStrategy(e.target.value)}>{Object.entries(STRATEGY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="People" hint="Leave all unticked to use every counsellor who is in today">
          <ul className="grid max-h-40 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
            {people.data?.items.filter((u) => u.role.key !== 'super_admin').map((u) => (
              <li key={u.id}><Check id={`u${u.id}`} checked={userIds.includes(u.id)} onChange={(v) => setUserIds((s) => (v ? [...s, u.id] : s.filter((x) => x !== u.id)))}>{u.name} <span className="text-xs text-muted">({u.role.name})</span></Check></li>
            ))}
          </ul>
        </Field>
        {rule && <Check id="ra" checked={active} onChange={setActive}>In use</Check>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save rule</Button></div>
      </form>
    </Modal>
  );
}

function RulesTab() {
  const rules = useApi<Rule[]>('/assignment-rules');
  const sources = useApi<Source[]>('/lead-sources');
  const [form, setForm] = useState<Rule | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function remove(r: Rule) {
    setNotice(null);
    try { await api(`/assignment-rules/${r.id}`, { method: 'DELETE' }); rules.reload(); } catch (e) { setNotice(errorText(e)); }
  }
  const source = (id: string | null) => (id ? sources.data?.find((s) => s.id === id)?.name ?? 'A source' : null);
  return (
    <Panel title="Assignment rules" flush actions={<Button onClick={() => setForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New rule</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">New leads are given out by the first rule that matches. If none matches, the lead goes round robin among counsellors who are in today.</p>
      {notice && <div className="p-3 pb-0"><Notice tone="bad">{notice}</Notice></div>}
      {rules.error ? <div className="p-4"><Notice tone="bad">{rules.error.message}</Notice></div> : !rules.data ? <Spinner /> : rules.data.length === 0 ? <Empty title="No rules yet">Without rules, leads are shared round robin among counsellors who are in today.</Empty> : (
        <ul className="divide-y divide-line">
          {rules.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold"><span className="tabular grid h-6 min-w-6 place-items-center rounded bg-head px-1 text-xs">{r.priority}</span>{r.name}{!r.isActive && <Badge tone="warn">Not in use</Badge>}</p>
                <p className="mt-1 text-xs text-muted">{[source(r.sourceId), r.courseId && 'one course', r.locationId && 'one location', r.studyMode].filter(Boolean).join(' · ') || 'Every lead'} → {STRATEGY[r.strategy]?.toLowerCase()}, {r.users.length ? r.users.map((u) => u.name).join(', ') : 'all counsellors'}</p>
              </div>
              <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setForm(r)}>Edit</Button><Button size="sm" variant="danger" onClick={() => void remove(r)}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete</Button></div>
            </li>
          ))}
        </ul>
      )}
      {form && <RuleForm rule={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); rules.reload(); }} />}
    </Panel>
  );
}

// -------------------------------------------------------------------- policy

function PolicyTab() {
  const policy = useApi<Policy>('/lead-policy');
  const [draft, setDraft] = useState<Policy | null>(null);
  // The download words are typed as one comma-separated line and split when saved.
  const [words, setWords] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const value = draft ?? policy.data;
  async function save() {
    if (!value) return;
    setBusy(true);
    setMsg(null);
    try {
      const downloadForms = (words ?? value.downloadForms.join(',')).split(',').map((w) => w.trim()).filter(Boolean);
      await api('/lead-policy', { method: 'PUT', body: { ...value, downloadForms } });
      setDraft(null);
      setWords(null);
      policy.reload();
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Lead handling">
      {policy.error ? <Notice tone="bad">{policy.error.message}</Notice> : !value ? <Spinner /> : (
        <div className="max-w-xl space-y-5">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <Check id="pa" checked={value.autoAssign} onChange={(v) => setDraft({ ...value, autoAssign: v })}>Give new leads to counsellors automatically</Check>
          <Field label="When the same phone number enquires again" htmlFor="pd" hint="Adding keeps one record per student, with the new enquiry in its history">
            <Select id="pd" value={value.duplicateAction} onChange={(e) => setDraft({ ...value, duplicateAction: e.target.value as Policy['duplicateAction'] })}>
              <option value="attach">Add it to the existing lead</option>
              <option value="reject">Refuse it</option>
            </Select>
          </Field>
          <Field label="Website forms that mean a download" htmlFor="pw" hint="If a website form's name contains one of these words, every Super Admin gets a bell alert and an email. Separate words with commas.">
            <Input id="pw" value={words ?? value.downloadForms.join(', ')} onChange={(e) => setWords(e.target.value)} placeholder="brochure, download" />
          </Field>
          <Button onClick={() => void save()} loading={busy} disabled={!draft && words === null}>Save</Button>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------- extra fields

interface CustomField { id: string; key: string; label: string; dataType: 'text' | 'number' | 'date' | 'select'; isRequired: boolean; isActive: boolean; options?: { value: string; label: string }[] }
const TYPE_LABEL: Record<CustomField['dataType'], string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown' };
/** A short code for the field made from its label, the way the API expects it: lower case, digits and underscores. */
const keyFrom = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'f_$1').slice(0, 40);

function FieldForm({ field, onClose, onSaved }: { field?: CustomField; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(field?.label ?? '');
  const [type, setType] = useState<CustomField['dataType']>(field?.dataType ?? 'text');
  const [required, setRequired] = useState(field?.isRequired ?? false);
  const [active, setActive] = useState(field?.isActive ?? true);
  const [options, setOptions] = useState((field?.options ?? []).map((o) => o.label).join('\n'));
  const { busy, error, run, fe } = useSave(onSaved);
  const opts = options.split('\n').map((o) => o.trim()).filter(Boolean).map((o) => ({ value: o, label: o }));
  return (
    <Modal title={field ? `Edit ${field.label}` : 'New extra field'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => (field ? api(`/custom-fields/${field.id}`, { method: 'PATCH', body: { label: label.trim(), isRequired: required, isActive: active, ...(field.dataType === 'select' && { options: opts }) } }) : api('/custom-fields', { method: 'POST', body: { key: keyFrom(label), label: label.trim(), dataType: type, isRequired: required, options: type === 'select' ? opts : [] } }))); }} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Name of the field" htmlFor="xl" required error={fe('label') ?? fe('key')} hint="What counsellors see, for example Parent's occupation"><Input id="xl" value={label} onChange={(e) => setLabel(e.target.value)} required minLength={2} /></Field>
        <Field label="Kind" htmlFor="xk" hint={field ? 'The kind cannot be changed after the field is made' : undefined}>
          <Select id="xk" value={type} onChange={(e) => setType(e.target.value as CustomField['dataType'])} disabled={!!field}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        {type === 'select' && <Field label="Choices" htmlFor="xo" required hint="One choice on each line" error={fe('options')}><Textarea id="xo" value={options} onChange={(e) => setOptions(e.target.value)} className="min-h-28" /></Field>}
        <Check id="xr" checked={required} onChange={setRequired}>Required once it has a value (it cannot be cleared)</Check>
        {field && <Check id="xa" checked={active} onChange={setActive}>In use. Switching it off hides it but keeps what was entered.</Check>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function ExtraFieldsTab() {
  const fields = useApi<CustomField[]>('/custom-fields', useMemo(() => ({ includeInactive: 'true' }), []));
  const [form, setForm] = useState<CustomField | 'new' | null>(null);
  return (
    <Panel title="Extra fields on a lead" flush actions={<Button onClick={() => setForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New field</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">Add the details your team wants to keep on every lead. They show on the lead, filled in by counsellors.</p>
      {fields.error ? <div className="p-4"><Notice tone="bad">{fields.error.message}</Notice></div> : !fields.data ? <Spinner /> : fields.data.length === 0 ? <Empty title="No extra fields yet" /> : (
        <ul className="divide-y divide-line">
          {fields.data.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">{f.label}<Badge>{TYPE_LABEL[f.dataType]}</Badge>{f.isRequired && <Badge tone="info">Required</Badge>}{!f.isActive && <Badge tone="warn">Not in use</Badge>}{f.options && f.options.length > 0 && <span className="text-xs font-normal text-muted">{f.options.map((o) => o.label).join(', ')}</span>}</p>
              <Button size="sm" variant="secondary" onClick={() => setForm(f)}>Edit</Button>
            </li>
          ))}
        </ul>
      )}
      {form && <FieldForm field={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); fields.reload(); }} />}
    </Panel>
  );
}

const TABS = [
  { key: 'statuses', label: 'Statuses' },
  { key: 'sources', label: 'Sources' },
  { key: 'rules', label: 'Assignment' },
  { key: 'fields', label: 'Extra fields' },
  { key: 'policy', label: 'Handling' },
] as const;

export default function LeadSettingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('statuses');
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={[...TABS]} value={tab} onChange={setTab} label="Lead settings" /></div>
      {tab === 'statuses' && <StatusesTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'fields' && <ExtraFieldsTab />}
      {tab === 'policy' && <PolicyTab />}
    </div>
  );
}
