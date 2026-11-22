'use client';

import { ChevronRight, FileSpreadsheet, MapPin, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AddCollegeModal } from '@/components/leads/add-college-modal';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { LocationPicker, type Place } from '@/components/ui/location-picker';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface CollegeRow {
  id: string;
  name: string;
  location: { id: string; name: string; type: string; state: string | null } | null;
  isActive: boolean;
  pendingReview: boolean;
  courseCount: number;
  offersOnline: boolean;
  offersRegular: boolean;
}

interface OfferedCourse {
  id: string;
  course: { id: string; name: string; level: string; stream: string | null };
  deliveryMode: 'online' | 'regular' | 'both';
  cafFee: number | null;
  annualFee: number | null;
  durationYears: number | null;
  isActive: boolean;
}

interface CollegeDetail extends Omit<CollegeRow, 'courseCount' | 'offersOnline' | 'offersRegular'> {
  courses: OfferedCourse[];
}

interface CourseOption { id: string; name: string; level: string }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const rupees = (n: number | null) => (n === null ? '—' : `₹ ${n.toLocaleString('en-IN')}`);
const MODE_LABEL = { online: 'Online', regular: 'Regular', both: 'Online and regular' } as const;
const place = (l: CollegeRow['location']) => (l ? (l.state ? `${l.name}, ${l.state}` : l.name) : null);

/** A rupee amount typed by hand: empty means "not known". */
function money(text: string): number | null | 'bad' {
  const t = text.replace(/[,\s₹]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : 'bad';
}

// ------------------------------------------------------------ one course

/** Adds a course to a college, or changes its mode, fees and duration. A course not in the list yet can be made here. */
function CourseForm({ college, offered, onClose, onSaved }: { college: CollegeDetail; offered?: OfferedCourse; onClose: () => void; onSaved: (c: CollegeDetail) => void }) {
  const courses = useApi<Page<CourseOption>>(offered ? null : '/courses', { limit: 100 });
  const taken = new Set(college.courses.map((c) => c.course.id));
  const choices = (courses.data?.items ?? []).filter((c) => !taken.has(c.id));
  const [courseId, setCourseId] = useState(offered?.course.id ?? '');
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('UG');
  const [mode, setMode] = useState<string>(offered?.deliveryMode ?? 'regular');
  const [caf, setCaf] = useState(offered?.cafFee?.toString() ?? '');
  const [annual, setAnnual] = useState(offered?.annualFee?.toString() ?? '');
  const [years, setYears] = useState(offered?.durationYears?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const making = !offered && courseId === 'new';

  async function save() {
    setError(null);
    const cafFee = money(caf);
    const annualFee = money(annual);
    if (cafFee === 'bad' || annualFee === 'bad') return setError('Fees must be numbers in rupees, or left empty.');
    const durationYears = years.trim() === '' ? null : Number(years);
    if (durationYears !== null && !(durationYears >= 0.5 && durationYears <= 10)) return setError('Duration must be between 0.5 and 10 years, or left empty.');
    if (!courseId) return setError('Choose a course.');
    if (making && newName.trim().length < 2) return setError('Type the name of the new course.');
    setBusy(true);
    try {
      const id = making ? (await api<{ id: string }>('/courses', { method: 'POST', body: { name: newName.trim(), level: newLevel } })).id : courseId;
      onSaved(await api<CollegeDetail>(`/colleges/${college.id}/courses/${id}`, {
        method: 'PUT',
        body: { deliveryMode: mode, cafFee, annualFee, durationYears, isActive: offered?.isActive ?? true },
      }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={offered ? `${offered.course.name} at ${college.name}` : `Add a course to ${college.name}`} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        {!offered && (
          <Field label="Course" htmlFor="cf-course" required hint={choices.length === 0 && !courses.loading ? 'No courses in the list yet. Choose "A new course" to add one.' : undefined}>
            <Select id="cf-course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">Choose a course</option>
              {choices.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.level})</option>)}
              <option value="new">+ A new course, not in the list</option>
            </Select>
          </Field>
        )}
        {making && (
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Name of the new course" htmlFor="cf-name" required hint="For example MBA, BBA or B.Tech Computer Science"><Input id="cf-name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} /></Field>
            <Field label="Level" htmlFor="cf-level"><Select id="cf-level" value={newLevel} onChange={(e) => setNewLevel(e.target.value)}><option value="UG">UG</option><option value="PG">PG</option><option value="Diploma">Diploma</option></Select></Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How it is taught" htmlFor="cf-mode"><Select id="cf-mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="regular">Regular</option><option value="online">Online</option><option value="both">Online and regular</option></Select></Field>
          <Field label="Duration in years" htmlFor="cf-years"><Input id="cf-years" inputMode="decimal" placeholder="e.g. 2" value={years} onChange={(e) => setYears(e.target.value)} /></Field>
          <Field label="Application fee (CAF) in ₹" htmlFor="cf-caf"><Input id="cf-caf" inputMode="numeric" placeholder="Leave empty if not known" value={caf} onChange={(e) => setCaf(e.target.value)} /></Field>
          <Field label="Yearly fee in ₹" htmlFor="cf-annual"><Input id="cf-annual" inputMode="numeric" placeholder="Leave empty if not known" value={annual} onChange={(e) => setAnnual(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted">Counsellors see these fees when they shortlist this college for a student.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void save()} loading={busy}>{offered ? 'Save' : 'Add course'}</Button>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------- one college

function EditCollege({ college, onClose, onSaved }: { college: CollegeDetail; onClose: () => void; onSaved: (c: CollegeDetail) => void }) {
  const [name, setName] = useState(college.name);
  const [where, setWhere] = useState<Place[]>(college.location ? [{ id: college.location.id, name: college.location.name, type: college.location.type as Place['type'], state: college.location.state }] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<CollegeDetail>(`/colleges/${college.id}`, { method: 'PATCH', body: { name: name.trim(), locationId: where[0]?.id ?? null } }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${college.name}`} onClose={onClose}>
      <div className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Name of the college" htmlFor="ec-name" required><Input id="ec-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} /></Field>
        <Field label="City or state" htmlFor="ec-place" hint="Counsellors find the college by this place."><LocationPicker id="ec-place" value={where} onChange={setWhere} /></Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void save()} loading={busy} disabled={name.trim().length < 2}>Save</Button>
      </div>
    </Modal>
  );
}

/** Everything about one college: where it is, its courses and fees, and (for those who manage the list) the means to change them. */
function CollegeView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const manage = can('master.manage');
  const review = can('master.review');
  const loaded = useApi<CollegeDetail>(`/colleges/${id}`);
  const [college, setCollege] = useState<CollegeDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [course, setCourse] = useState<OfferedCourse | 'new' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OfferedCourse | null>(null);
  const c = college ?? loaded.data;

  function saved(next: CollegeDetail, text: string) {
    setCollege(next);
    setNotice({ tone: 'ok', text });
    onChanged();
  }

  async function run(key: string, work: () => Promise<CollegeDetail>, text: string) {
    setBusy(key);
    setNotice(null);
    try {
      saved(await work(), text);
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const switchCollege = (on: boolean) => run('college', () => api<CollegeDetail>(`/colleges/${id}`, { method: 'PATCH', body: { isActive: on } }),
    on ? 'The college is back in the list counsellors choose from.' : 'Switched off. Counsellors no longer see it; students who already shortlisted it keep it.');
  const decide = (decision: 'approved' | 'rejected') => run('review', async () => {
    await api(`/colleges/${id}/review`, { method: 'POST', body: { decision } });
    return api<CollegeDetail>(`/colleges/${id}`);
  }, decision === 'approved' ? 'Approved. It stays in the list.' : 'Turned down and switched off.');
  const switchCourse = (o: OfferedCourse) => run(o.id, () => api<CollegeDetail>(`/colleges/${id}/courses/${o.course.id}`, {
    method: 'PUT', body: { deliveryMode: o.deliveryMode, cafFee: o.cafFee, annualFee: o.annualFee, durationYears: o.durationYears, isActive: !o.isActive },
  }), o.isActive ? `${o.course.name} switched off at this college.` : `${o.course.name} is offered again.`);
  const removeCourse = async (o: OfferedCourse) => {
    setRemoving(null);
    await run(o.id, () => api<CollegeDetail>(`/colleges/${id}/courses/${o.course.id}`, { method: 'DELETE' }), `${o.course.name} removed from this college.`);
  };

  return (
    <Modal title={c?.name ?? 'College'} onClose={onClose} width="max-w-3xl">
      {loaded.error && !c ? <Notice tone="bad">{loaded.error.message}</Notice> : !c ? <Spinner /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 text-muted"><MapPin className="h-3.5 w-3.5" aria-hidden />{place(c.location) ?? 'City not set'}</span>
            {manage && (c.isActive ? <Badge tone="ok">In use</Badge> : <Badge>Switched off</Badge>)}
            {c.pendingReview && <Badge tone="warn">Added by a counsellor, waiting for review</Badge>}
            {manage && (
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" aria-hidden /> Edit name or city</Button>
                <Button size="sm" variant={c.isActive ? 'danger' : 'secondary'} loading={busy === 'college'} onClick={() => void switchCollege(!c.isActive)}><Power className="h-3.5 w-3.5" aria-hidden /> {c.isActive ? 'Switch off' : 'Switch on'}</Button>
              </div>
            )}
          </div>

          {c.pendingReview && review && (
            <Notice tone="warn">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>A counsellor added this college. Keep it in the list?</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" loading={busy === 'review'} onClick={() => void decide('rejected')}>Turn down</Button>
                  <Button size="sm" loading={busy === 'review'} onClick={() => void decide('approved')}>Approve</Button>
                </span>
              </div>
            </Notice>
          )}
          {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
          {removing && (
            <Notice tone="warn">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Remove <strong>{removing.course.name}</strong> and its fees from this college? To keep it for later, switch it off instead.</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button>
                  <Button size="sm" variant="danger" loading={busy === removing.id} onClick={() => void removeCourse(removing)}>Remove</Button>
                </span>
              </div>
            </Notice>
          )}

          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Courses and fees <span className="font-normal text-muted">({c.courses.length})</span></h3>
            {manage && <Button size="sm" onClick={() => setCourse('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> Add a course</Button>}
          </div>

          {c.courses.length === 0 ? (
            <Empty title="No courses are listed for this college yet">
              {manage
                ? <>Add them here one at a time, or for many colleges at once upload the sheet in <Link href="/imports" className="font-medium text-info hover:underline">Import and export → Colleges and fees</Link>. Counsellors can still shortlist this college meanwhile.</>
                : 'Counsellors can still shortlist this college. An Admin will add its courses and fees.'}
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Course</th>
                    <th className="px-3 py-2 font-semibold">Mode</th>
                    <th className="px-3 py-2 text-right font-semibold">CAF</th>
                    <th className="px-3 py-2 text-right font-semibold">Fee per year</th>
                    <th className="px-3 py-2 text-right font-semibold">Duration</th>
                    {manage && <th className="px-3 py-2"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {c.courses.map((o) => (
                    <tr key={o.id} className={o.isActive ? 'hover:bg-mint-50' : 'bg-head/60 text-muted'}>
                      <td className="px-3 py-2">
                        <span className="font-medium text-ink">{o.course.name}</span>
                        <span className="ml-1.5 text-xs text-muted">{o.course.level}</span>
                        {!o.isActive && <Badge className="ml-2">Switched off</Badge>}
                      </td>
                      <td className="px-3 py-2 text-muted">{MODE_LABEL[o.deliveryMode] ?? o.deliveryMode}</td>
                      <td className="tabular px-3 py-2 text-right">{rupees(o.cafFee)}</td>
                      <td className="tabular px-3 py-2 text-right">{rupees(o.annualFee)}</td>
                      <td className="px-3 py-2 text-right text-muted">{o.durationYears ? `${o.durationYears} yr` : '—'}</td>
                      {manage && (
                        <td className="px-2 py-1.5">
                          <div className="flex justify-end gap-0.5">
                            <button type="button" onClick={() => setCourse(o)} aria-label={`Edit ${o.course.name}`} title="Edit fees and mode" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink"><Pencil className="h-4 w-4" /></button>
                            <button type="button" disabled={busy === o.id} onClick={() => void switchCourse(o)} aria-label={o.isActive ? `Switch off ${o.course.name}` : `Switch on ${o.course.name}`} title={o.isActive ? 'Switch off (keeps it for students who chose it)' : 'Switch on'} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink disabled:opacity-50"><Power className="h-4 w-4" /></button>
                            <button type="button" disabled={busy === o.id} onClick={() => { setNotice(null); setRemoving(o); }} aria-label={`Remove ${o.course.name}`} title="Remove (only if no student chose it)" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-bad-50 hover:text-bad disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {editing && c && <EditCollege college={c} onClose={() => setEditing(false)} onSaved={(next) => { setEditing(false); saved(next, 'Saved.'); }} />}
      {course && c && <CourseForm college={c} offered={course === 'new' ? undefined : course} onClose={() => setCourse(null)} onSaved={(next) => { const name = course === 'new' ? 'The course was added.' : 'Saved.'; setCourse(null); saved(next, name); }} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ list

export default function CollegesPage() {
  const { can } = useAuth();
  const manage = can('master.manage');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [where, setWhere] = useState<Place[]>([]);
  const [courseId, setCourseId] = useState('');
  const [mode, setMode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const query = useMemo(() => ({ limit: 100, q: debounced || undefined, locationId: where[0]?.id, courseId: courseId || undefined, mode: mode || 'any' }), [debounced, where, courseId, mode]);
  const first = useApi<Page<CollegeRow>>('/colleges', query);
  const courses = useApi<Page<CourseOption>>('/courses', { limit: 100 });

  // "Show more" adds pages after the first; a change of filter starts again.
  const key = JSON.stringify(query);
  const [more, setMore] = useState<{ key: string; base: string | null; items: CollegeRow[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const base = first.data?.nextCursor ?? null;
  const extra = more?.key === key && more.base === base ? more : null;
  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  const cursor = extra ? extra.next : base;
  const filtered = !!(debounced || where.length || courseId || mode);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<Page<CollegeRow>>('/colleges', { query: { ...query, cursor } });
      setMore({ key, base, items: [...(extra?.items ?? []), ...page.items], next: page.nextCursor });
    } finally {
      setLoadingMore(false);
    }
  }

  const inUse = items.filter((c) => c.isActive);
  const withoutCourses = inUse.filter((c) => c.courseCount === 0).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Colleges"
        subtitle="Every college with its courses and fees. Counsellors shortlist from this list on each lead."
        actions={manage && <>
          <Link href="/imports" className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-head"><FileSpreadsheet className="h-4 w-4" aria-hidden /> Upload a sheet</Link>
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden /> Add a college</Button>
        </>}
      />

      {manage && !filtered && first.data && withoutCourses > 0 && (
        <Notice tone="warn">
          {withoutCourses === inUse.length ? 'No college has its courses and fees yet.' : withoutCourses === 1 ? '1 college has no courses or fees yet.' : `${withoutCourses} colleges have no courses or fees yet.`}{' '}
          Until they are added, counsellors cannot search colleges by course. Open a college to add its courses, or upload the colleges and fees sheet in Import and export.
        </Notice>
      )}
      {notice && <Notice tone="ok">{notice}</Notice>}

      <Panel flush>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative w-full sm:min-w-52 sm:w-auto sm:flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <Input aria-label="Search colleges" placeholder="Search by college name" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <div className="w-full sm:w-56"><LocationPicker value={where} onChange={setWhere} placeholder="Any city or state" /></div>
          <Select aria-label="Course" value={courseId} onChange={(e) => setCourseId(e.target.value)} className="w-full sm:w-48">
            <option value="">Any course</option>
            {courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.level})</option>)}
          </Select>
          <Select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value)} className="w-full sm:w-40">
            <option value="">Online or regular</option>
            <option value="online">Online</option>
            <option value="regular">Regular</option>
          </Select>
        </div>

        {first.error ? <div className="p-4"><Notice tone="bad">{first.error.message}</Notice></div> : first.loading && !first.data ? <Spinner /> : items.length === 0 ? (
          <Empty title={filtered ? 'No college matches' : 'No colleges yet'}>{filtered ? 'Try fewer filters.' : manage ? 'Add a college, or upload the colleges and fees sheet.' : 'An Admin will add them.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">College</th>
                  <th className="hidden px-3 py-2.5 font-semibold sm:table-cell">City</th>
                  <th className="px-3 py-2.5 font-semibold">Courses</th>
                  <th className="hidden px-3 py-2.5 font-semibold md:table-cell">Mode</th>
                  {manage && <th className="px-3 py-2.5 font-semibold">Status</th>}
                  <th className="w-10 px-3 py-2.5"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c.id)} className={`cursor-pointer hover:bg-mint-50 ${c.isActive ? '' : 'text-muted'}`}>
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(c.id); }} className="text-left font-medium text-ink hover:underline">{c.name}</button>
                      {!manage && c.pendingReview && <Badge tone="warn" className="ml-2">New, waiting for review</Badge>}
                      {c.location && <p className="mt-0.5 text-xs text-muted sm:hidden">{place(c.location)}</p>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-muted sm:table-cell">{place(c.location) ?? '—'}</td>
                    <td className="px-3 py-2.5">{c.courseCount > 0 ? c.courseCount : <span className="text-subtle">Not added</span>}</td>
                    <td className="hidden px-3 py-2.5 md:table-cell">
                      <span className="flex flex-wrap gap-1">
                        {c.offersOnline && <Badge tone="info">Online</Badge>}
                        {c.offersRegular && <Badge tone="brand">Regular</Badge>}
                        {!c.offersOnline && !c.offersRegular && <span className="text-subtle">—</span>}
                      </span>
                    </td>
                    {manage && (
                      <td className="px-3 py-2.5">
                        {c.pendingReview ? <Badge tone="warn">Waiting for review</Badge> : c.isActive ? <Badge tone="ok">In use</Badge> : <Badge>Switched off</Badge>}
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-subtle"><ChevronRight className="h-4 w-4" aria-hidden /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
              <span>{items.length} {items.length === 1 ? 'college' : 'colleges'}{cursor ? ' shown' : ''}</span>
              {cursor && <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>Show more</Button>}
            </div>
          </div>
        )}
      </Panel>

      {open && <CollegeView id={open} onClose={() => setOpen(null)} onChanged={() => { first.reload(); courses.reload(); }} />}
      {adding && <AddCollegeModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); setNotice('The college was added. Open it to add its courses and fees.'); first.reload(); }} />}
    </div>
  );
}
