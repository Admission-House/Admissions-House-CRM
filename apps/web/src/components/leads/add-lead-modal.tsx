'use client';

import { useMemo, useState } from 'react';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { LocationPicker, type Place } from '@/components/ui/location-picker';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Page, SourceOption, UserOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface CollegeItem {
  id: string;
  name: string;
  location: { id: string; name: string; state: string | null } | null;
}

const today = () => new Date().toLocaleDateString('en-CA');
const nowLocal = () => {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/**
 * Adds a lead by hand: who they are, the course and place they are looking at, the university they
 * liked (it goes straight onto the recommended list), and when to call back. Every list in the form
 * comes from the API.
 */
export function AddLeadModal({ sources, people, onClose, onCreated }: { sources: SourceOption[]; people: UserOption[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { can } = useAuth();
  const [form, setForm] = useState({ name: '', phone: '', email: '', sourceId: '', studyMode: '', intent: '', courseId: '', collegeId: '', expectedClosureOn: '', followUpAt: '', followUpNote: '', assignTo: '', note: '' });
  const [place, setPlace] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const on = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const existingId = (error?.details?.existing as { id?: string } | undefined)?.id;
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;

  const courses = useApi<Page<{ id: string; name: string; level: string }>>(can('master.read') ? '/courses' : null, { limit: 100 });
  // The universities that offer what the student asked for: online ones when the study mode is online.
  const collegeQuery = useMemo(
    () => ({ limit: 50, courseId: form.courseId || undefined, locationId: place[0]?.id, mode: form.studyMode || undefined }),
    [form.courseId, form.studyMode, place],
  );
  const colleges = useApi<Page<CollegeItem>>(can('master.read') ? '/colleges' : null, collegeQuery);

  async function submit(e: React.FormEvent, anyway = false) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), phone: form.phone.trim(), sourceId: form.sourceId };
      if (form.email.trim()) body.email = form.email.trim();
      if (form.studyMode) body.studyMode = form.studyMode;
      if (form.intent) body.intent = form.intent;
      if (form.courseId) body.interestedCourseId = form.courseId;
      if (place[0]) body.interestedLocationId = place[0].id;
      if (form.expectedClosureOn) body.expectedClosureOn = form.expectedClosureOn;
      if (form.followUpAt) body.followUp = { dueAt: new Date(form.followUpAt).toISOString(), ...(form.followUpNote.trim() && { note: form.followUpNote.trim() }) };
      if (form.note.trim()) body.note = form.note.trim();
      if (can('lead.assign') && form.assignTo) body.assignTo = form.assignTo === 'none' ? null : form.assignTo;
      if (anyway) body.allowUnavailable = true;
      const created = await api<{ id: string }>('/leads', { method: 'POST', body });
      // The university the student liked becomes the first recommendation. The lead is saved either way.
      if (form.collegeId && can('shortlist.manage')) await api(`/leads/${created.id}/recommendations`, { method: 'POST', body: { collegeId: form.collegeId } }).catch(() => undefined);
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server.'));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a lead" onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <Notice tone="bad">
            {error.message}
            {error.code === 'ASSIGNEE_UNAVAILABLE' && <> <button type="button" className="font-semibold underline" onClick={(e) => void submit(e, true)}>Add and assign anyway</button></>}
            {error.code === 'DUPLICATE_LEAD' && existingId && (
              <> <a className="font-semibold underline" href={`/leads/${existingId}`}>Open the existing lead</a></>
            )}
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="n" required error={fe('name')}><Input id="n" value={form.name} onChange={on('name')} required minLength={2} /></Field>
          <Field label="Mobile number" htmlFor="p" required error={fe('phone')}><Input id="p" inputMode="tel" value={form.phone} onChange={on('phone')} placeholder="98765 43210" required /></Field>
          <Field label="Email (optional)" htmlFor="e" error={fe('email')}><Input id="e" type="email" value={form.email} onChange={on('email')} /></Field>
          <Field label="Source" htmlFor="s" required error={fe('sourceId')}>
            <Select id="s" value={form.sourceId} onChange={on('sourceId')} required>
              <option value="">Choose a source</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>

        <p className="border-t border-line pt-4 text-xs font-semibold uppercase tracking-wide text-muted">What the student is looking for</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Study mode" htmlFor="m" hint="Online shows only the universities that offer online courses">
            <Select id="m" value={form.studyMode} onChange={(e) => setForm((f) => ({ ...f, studyMode: e.target.value, collegeId: '' }))}>
              <option value="">Not sure yet</option><option value="online">Online</option><option value="regular">Regular</option>
            </Select>
          </Field>
          <Field label="Course" htmlFor="c" error={fe('interestedCourseId')}>
            <Select id="c" value={form.courseId} onChange={(e) => setForm((f) => ({ ...f, courseId: e.target.value, collegeId: '' }))}>
              <option value="">Not chosen yet</option>
              {courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Location the student is searching in" htmlFor="l" error={fe('interestedLocationId')}><LocationPicker id="l" value={place} onChange={(p) => { setPlace(p); setForm((f) => ({ ...f, collegeId: '' })); }} /></Field>
          <Field label="University" htmlFor="u" hint={colleges.data && colleges.data.items.length === 0 ? 'No university matches. You can add one later from the lead.' : 'Added to the lead as recommended'}>
            <Select id="u" value={form.collegeId} onChange={on('collegeId')} disabled={!can('shortlist.manage')}>
              <option value="">Not chosen yet</option>
              {colleges.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}{c.location ? `, ${c.location.name}` : ''}</option>)}
            </Select>
          </Field>
        </div>

        <p className="border-t border-line pt-4 text-xs font-semibold uppercase tracking-wide text-muted">Follow-up</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Intent" htmlFor="i">
            <Select id="i" value={form.intent} onChange={on('intent')}>
              <option value="">Not set</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
            </Select>
          </Field>
          <Field label="Expected closure date" htmlFor="x" error={fe('expectedClosureOn')}><Input id="x" type="date" min={today()} value={form.expectedClosureOn} onChange={on('expectedClosureOn')} /></Field>
          <Field label="Call back on" htmlFor="f" hint="Date and time of the next follow-up" error={fe('followUp.dueAt')}><Input id="f" type="datetime-local" min={nowLocal().slice(0, 10) + 'T00:00'} value={form.followUpAt} onChange={on('followUpAt')} /></Field>
          <Field label="What to talk about" htmlFor="fn"><Input id="fn" value={form.followUpNote} onChange={on('followUpNote')} maxLength={500} disabled={!form.followUpAt} /></Field>
        </div>

        {can('lead.assign') && (
          <Field label="Assign to" htmlFor="a" hint="Leave as it is to give it to the next counsellor in line.">
            <Select id="a" value={form.assignTo} onChange={on('assignTo')}>
              <option value="">Next in line</option>
              <option value="none">Leave unassigned</option>
              {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Remarks (optional)" htmlFor="t"><Textarea id="t" value={form.note} onChange={on('note')} maxLength={2000} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Add lead</Button>
        </div>
      </form>
    </Modal>
  );
}
