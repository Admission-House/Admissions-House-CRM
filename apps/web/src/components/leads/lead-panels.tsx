'use client';

import {
  Check,
  CircleDot,
  FileText,
  MessageSquare,
  PhoneCall,
  RefreshCw,
  Repeat,
  UserCheck,
  CalendarClock,
  Clock,
} from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
  Textarea,
  cx,
} from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { api, ApiError, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fromNow } from '@/lib/format';
import type { Page, StatusOption, UserOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { localToIso, minFollowUp } from '@/lib/date-picker';
import { backToListUrl, nextLeadId, useInListContext } from '@/lib/lead-list-context';

export interface LeadDetail {
  id: string;
  leadNo: string;
  name: string;
  phone: string;
  email: string | null;
  intent: 'hot' | 'warm' | 'cold' | null;
  studyMode: 'online' | 'regular' | null;
  expectedClosureOn: string | null;
  interestNote: string | null;
  status: { id: string; name: string; queue: string; isOpen: boolean; requiresFollowup: boolean };
  substatus: { id: string; name: string } | null;
  source: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  assignedAt: string | null;
  nextFollowupAt: string | null;
  firstCalledAt: string | null;
  openFollowUps: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  extraPhones: { phone: string; label: string }[];
}

/** datetime-local gives "2026-11-03T15:30" in the viewer's zone; the API wants a full timestamp with offset. */

// ---------------------------------------------------------------- status

export function StatusPanel({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const [statusId, setStatusId] = useState('');
  const [substatusId, setSubstatusId] = useState('');
  const [remark, setRemark] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [map, setMap] = useState(false);
  const router = useRouter();
  // "Save & next" is offered when the lead was opened from the leads list: the next lead of that list opens after saving.
  const fromList = useInListContext(lead.id);
  const [goNext, setGoNext] = useState(false);

  // The company's own list to choose from, plus the status the lead already has (so it still shows, even if it is no longer offered).
  const options =
    statuses.data?.filter(
      (s) => s.isActive !== false && (s.selectable !== false || s.id === lead.status.id),
    ) ?? [];
  // Every disposition is complete (company rule, 24 Nov): the status is chosen each time (it does not start on the current
  // one), a reason is chosen when the status has reasons, a comment is always written, and an open status always gets the
  // next follow-up date and time. A closed status has no date: the lead is finished.
  const chosen = options.find((s) => s.id === statusId);
  const hasReasons = !!chosen?.substatuses?.length;
  const needsDate = !!chosen && chosen.isOpen && can('followup.manage');

  if (!can('lead.update')) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const thenNext = goNext;
    setGoNext(false);
    // Say what is missing, here, in words. The browser's own "fill this in" bubble is easy to miss, and then Save looks as if it does nothing.
    const missing = !statusId
      ? 'Choose the lead status.'
      : hasReasons && !substatusId
        ? 'Choose a reason in "Lead sub-status" for this status.'
        : !remark.trim()
          ? 'Write what was discussed in "Comments".'
          : needsDate && !due
            ? 'Choose the next follow-up date and time.'
            : null;
    if (missing) {
      setSaved(null);
      setError(missing);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api(`/leads/${lead.id}/status`, {
        method: 'POST',
        body: {
          statusId,
          ...(substatusId && { substatusId }),
          ...(remark.trim() && { remark: remark.trim() }),
          ...(due &&
            chosen?.isOpen &&
            can('followup.manage') && { followUp: { dueAt: localToIso(due) } }),
        },
      });
      if (thenNext) {
        const next = await nextLeadId(lead.id).catch(() => null);
        if (next) {
          router.push(`/leads/${next}`);
          return;
        }
        setSaved('Saved. That was the last lead in this list.');
      } else if (fromList) {
        // Save alone goes back to the list the lead came from (same section, filters and page), now without this lead
        // if its new status moved it to another section.
        router.push(backToListUrl(lead.id));
        return;
      }
      setRemark('');
      setDue('');
      setStatusId('');
      setSubstatusId('');
      if (!thenNext) setSaved('Saved.');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">Dispose lead</h2>
      <form onSubmit={save} noValidate className="mt-4 space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        {saved && <Notice tone="ok">{saved}</Notice>}
        <Field
          label="Lead status"
          htmlFor="st"
          required
          hint={`Now: ${lead.status.name}${lead.substatus ? ` · ${lead.substatus.name}` : ''}`}
        >
          <Select
            id="st"
            value={statusId}
            onChange={(e) => {
              setStatusId(e.target.value);
              setSubstatusId('');
            }}
          >
            <option value="">Select status</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Lead sub-status" htmlFor="sub" required={hasReasons}>
          <Select
            id="sub"
            value={substatusId}
            onChange={(e) => setSubstatusId(e.target.value)}
            required={hasReasons}
            disabled={!(chosen?.substatuses && chosen.substatuses.length > 0)}
          >
            <option value="">
              {!chosen
                ? 'Choose a status first'
                : !hasReasons
                  ? 'No reasons for this status'
                  : 'Select a reason'}
            </option>
            {(chosen?.substatuses ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.requiresComment ? ' (comments required)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <button
          type="button"
          onClick={() => setMap(true)}
          className="-mt-2 text-xs font-medium text-info hover:underline"
        >
          View all dependencies
        </button>
        {can('followup.manage') && (
          <Field label="Next follow-up" htmlFor="due" required={!chosen || chosen.isOpen}>
            <DateTimePicker
              id="due"
              min={minFollowUp()}
              value={chosen?.isOpen ? due : ''}
              onChange={setDue}
              required={needsDate}
              disabled={!chosen?.isOpen}
              placeholder={
                !chosen
                  ? 'Choose a status first'
                  : chosen.isOpen
                    ? 'Choose date and time'
                    : 'Not needed for a closed status'
              }
            />
          </Field>
        )}
        <Field label="Comments" htmlFor="rm" required>
          <Textarea
            id="rm"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={1000}
            required
            placeholder="What was discussed?"
          />
        </Field>
        {fromList ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="submit"
              variant="secondary"
              loading={busy && !goNext}
              disabled={busy}
              onClick={() => setGoNext(false)}
            >
              Save
            </Button>
            <Button
              type="submit"
              loading={busy && goNext}
              disabled={busy}
              onClick={() => setGoNext(true)}
              title="Save, then open the next lead of the list you came from"
            >
              Save &amp; next
            </Button>
          </div>
        ) : (
          <Button type="submit" loading={busy} className="w-full">
            Save
          </Button>
        )}
      </form>
      {map && <DependencyMap statuses={options} onClose={() => setMap(false)} />}
    </Card>
  );
}

/** Every status with the reasons (sub-statuses) that can be chosen under it, so a person can see the whole list at once. */
function DependencyMap({ statuses, onClose }: { statuses: StatusOption[]; onClose: () => void }) {
  return (
    <Modal title="Statuses and their reasons" onClose={onClose}>
      <p className="mb-3 text-xs text-muted">
        A status marked * needs one of its reasons to be chosen. A reason marked (comments required)
        needs a comment.
      </p>
      <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
        {statuses.map((s) => (
          <li key={s.id} className="rounded-md border border-line px-3 py-2">
            <p className="text-sm font-medium text-ink">
              {s.name}
              {s.requiresSubstatus ? ' *' : ''}
            </p>
            {s.substatuses && s.substatuses.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {s.substatuses.map((x) => (
                  <li key={x.id}>
                    {x.name}
                    {x.requiresComment ? ' (comments required)' : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-subtle">No reasons to choose from.</p>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------- assign

export function AssignPanel({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const people = useApi<Page<UserOption>>(
    can('lead.assign') && can('user.read') ? '/users' : null,
    { limit: 100, status: 'active' },
  );
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The chosen person is absent, on leave or on a break: the Admin may still hand the lead over.
  const [unavailable, setUnavailable] = useState(false);

  if (!can('lead.assign')) return null;

  async function assign(anyway = false) {
    setBusy(true);
    setError(null);
    setUnavailable(false);
    try {
      await api(`/leads/${lead.id}/assign`, {
        method: 'POST',
        body: {
          userId: userId === 'none' ? null : userId,
          ...(anyway && { allowUnavailable: true }),
        },
      });
      setUserId('');
      onChanged();
    } catch (e) {
      setUnavailable(e instanceof ApiError && e.code === 'ASSIGNEE_UNAVAILABLE');
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">Assigned to</h2>
      <p className="mt-1 text-sm text-muted">
        {lead.assignedTo
          ? `${lead.assignedTo.name}${lead.assignedAt ? `, ${fromNow(lead.assignedAt)}` : ''}`
          : 'Nobody yet'}
      </p>
      {error && (
        <div className="mt-3">
          <Notice tone="bad">
            {error}
            {unavailable && (
              <>
                {' '}
                <button
                  type="button"
                  className="font-semibold underline"
                  onClick={() => void assign(true)}
                >
                  Assign anyway
                </button>
              </>
            )}
          </Notice>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Select
          aria-label="Hand over to"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          <option value="">Choose a person</option>
          <option value="none">Move to the unassigned pool</option>
          {people.data?.items.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => void assign()} disabled={!userId} loading={busy}>
          Assign
        </Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- follow-ups

interface FollowUp {
  id: string;
  dueAt: string;
  note: string | null;
  doneAt: string | null;
  owner: { id: string; name: string };
}

export function FollowUpsPanel({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const list = useApi<FollowUp[]>(`/leads/${lead.id}/followups`);
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!due) {
      setError('Choose when to follow up.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/followups`, {
        method: 'POST',
        body: { dueAt: localToIso(due), ...(note.trim() && { note: note.trim() }) },
      });
      setDue('');
      setNote('');
      list.reload();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function done(id: string) {
    try {
      await api(`/followups/${id}/done`, { method: 'POST', body: {} });
      list.reload();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const items = list.data ?? [];
  return (
    <Card>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Follow-ups</h2>
      </div>
      {can('followup.manage') && lead.status.isOpen && (
        <form
          onSubmit={add}
          className="grid gap-3 border-b border-line p-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]"
        >
          <DateTimePicker
            min={minFollowUp()}
            value={due}
            onChange={setDue}
            required
            placeholder="When to follow up"
          />
          <Input
            aria-label="Note"
            placeholder="What to do (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
          <Button type="submit" loading={busy}>
            Add
          </Button>
        </form>
      )}
      {error && (
        <div className="p-5 pb-0">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {list.loading && !list.data ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="No follow-ups yet" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((f) => {
            const late = !f.doneAt && new Date(f.dueAt) < new Date();
            return (
              <li key={f.id} className="flex items-start justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className={cx('text-sm font-medium', late ? 'text-bad' : 'text-ink')}>
                    {fmtDateTime(f.dueAt)}{' '}
                    <span className="font-normal text-muted">· {fromNow(f.dueAt)}</span>
                  </p>
                  {f.note && <p className="mt-0.5 text-sm text-muted">{f.note}</p>}
                  <p className="mt-0.5 text-xs text-subtle">{f.owner.name}</p>
                </div>
                {f.doneAt ? (
                  <Badge tone="ok">Done</Badge>
                ) : can('followup.manage') ? (
                  <Button
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    onClick={() => void done(f.id)}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden /> Mark done
                  </Button>
                ) : (
                  <Badge tone={late ? 'bad' : 'info'}>{late ? 'Overdue' : 'Open'}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// --------------------------------------------------------------- timeline

interface Activity {
  id: string;
  type: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  remark: string | null;
  user: { id: string; name: string } | null;
  createdAt: string;
}

const ICON: Record<string, typeof CircleDot> = {
  note: MessageSquare,
  status_change: RefreshCw,
  assignment: UserCheck,
  call: PhoneCall,
  document: FileText,
  shortlist: Check,
  enquiry: Repeat,
  field_change: CircleDot,
  followup: CalendarClock,
};

/** Names for the student-profile details that the history records, so nobody reads "profile.preferred_stream_id". */
const FIELD_LABEL: Record<string, string> = {
  'profile.alternate_email': 'Alternate email',
  'profile.date_of_birth': 'Date of birth',
  'profile.gender': 'Gender',
  'profile.category': 'Category',
  'profile.current_location_id': 'Current city',
  'profile.preferred_year': 'Preferred year',
  'profile.preferred_level': 'Level',
  'profile.preferred_stream_id': 'Stream',
  'profile.budget_min': 'Budget from',
  'profile.budget_max': 'Budget up to',
  'profile.loan_required': 'Loan required',
  'profile.extra_phones': 'Extra phone numbers',
  'profile.preferred_locations': 'Preferred places',
  'profile.guardians': 'Parent or guardian details',
  'profile.education': 'Academic details',
  'profile.exams': 'Exam scores',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value fit to show: ids are hidden, and yes/no values are written as words. */
function shown(v: string | null): string | null {
  if (v === null || v === '' || UUID.test(v)) return null;
  if (v === 'true') return 'Yes';
  if (v === 'false') return 'No';
  return v;
}

function describe(a: Activity): string {
  switch (a.type) {
    case 'status_change':
      return `Status changed${a.oldValue ? ` from ${a.oldValue}` : ''}${a.newValue ? ` to ${a.newValue}` : ''}`;
    case 'followup':
      if (a.field === 'done') return a.remark ?? 'Follow-up marked done';
      return a.newValue ? `Follow-up set for ${fmtDateTime(a.newValue)}` : 'Follow-up updated';
    case 'field_change': {
      const label = (a.field && FIELD_LABEL[a.field]) ?? a.field ?? 'A detail';
      const from = shown(a.oldValue);
      const to = shown(a.newValue);
      return `${label} ${a.remark === 'Updated' ? 'updated' : 'changed'}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`;
    }
    case 'document':
      return `${a.remark ?? 'Document'}: ${a.field ?? ''} ${a.newValue ?? a.oldValue ?? ''}`.trim();
    case 'shortlist':
      return a.remark ?? 'College shortlist updated';
    default:
      return a.remark ?? a.type;
  }
}

export function Timeline({ lead }: { lead: LeadDetail }) {
  const { can } = useAuth();
  const [pages, setPages] = useState<Activity[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const first = useApi<Page<Activity>>(`/leads/${lead.id}/activities`, { limit: 30 });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = [...(first.data?.items ?? []), ...pages];
  const cursor = pages.length > 0 ? next : (first.data?.nextCursor ?? null);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/notes`, { method: 'POST', body: { remark: note.trim() } });
      setNote('');
      setPages([]);
      first.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function showMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const p = await api<Page<Activity>>(`/leads/${lead.id}/activities`, {
        query: { limit: 30, cursor },
      });
      setPages((prev) => [...prev, ...p.items]);
      setNext(p.nextCursor);
    } finally {
      setMore(false);
    }
  }

  return (
    <Card>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">History</h2>
      </div>
      {can('lead.update') && (
        <form onSubmit={addNote} className="space-y-3 border-b border-line p-5">
          {error && <Notice tone="bad">{error}</Notice>}
          <Textarea
            aria-label="Add a note"
            placeholder="Add a note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            required
          />
          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={!note.trim()}>
              Add note
            </Button>
          </div>
        </form>
      )}
      {first.loading && !first.data ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="Nothing here yet" />
      ) : (
        <ol className="relative space-y-5 p-5">
          <span className="absolute bottom-6 left-[2.15rem] top-6 w-px bg-line" aria-hidden />
          {items.map((a) => {
            const Icon = ICON[a.type] ?? Clock;
            return (
              <li key={a.id} className="relative flex gap-4">
                <span className="relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mint text-brand ring-4 ring-surface">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm text-ink">{describe(a)}</p>
                  {a.type === 'status_change' && a.remark && (
                    <p className="mt-1 rounded-lg bg-canvas px-3 py-2 text-sm text-muted">
                      {a.remark}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-subtle">
                    {a.user?.name ?? 'System'} · {fmtDateTime(a.createdAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {cursor && (
        <div className="flex justify-center border-t border-line p-4">
          <Button variant="secondary" loading={more} onClick={() => void showMore()}>
            Show older
          </Button>
        </div>
      )}
    </Card>
  );
}
