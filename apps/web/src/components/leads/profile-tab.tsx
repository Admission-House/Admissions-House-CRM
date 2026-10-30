'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, Field, Input, Notice, SectionBand, Select, Spinner } from '@/components/ui';
import { LocationPicker, type Place } from '@/components/ui/location-picker';
import { SuggestInput } from '@/components/ui/suggest-input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import type { LeadDetail } from './lead-panels';

interface Profile {
  personal: {
    alternateEmail: string | null; dateOfBirth: string | null; gender: string | null; category: string | null;
    currentLocation: Place | null; extraPhones: { phone: string; label: string }[];
  };
  preferences: {
    studyMode: string | null; preferredYear: number | null; preferredLevel: string | null; preferredStream: { id: string; name: string } | null;
    budgetMin: number | null; budgetMax: number | null; loanRequired: boolean | null; preferredLocations: Place[];
  };
  guardians: { relation: string; name: string | null; phone: string | null; occupation: string | null }[];
  education: { level: string; marksType: string | null; marks: number | null; institution: string | null; board: string | null; passingYear: number | null }[];
  exams: { examName: string; marksType: string | null; score: number | null; examYear: number | null }[];
  updatedAt: string | null;
  updatedBy: string | null;
}

const LEVELS = [
  { key: '10th', label: '10th' },
  { key: '12th', label: '12th' },
  { key: 'diploma', label: 'Diploma' },
  { key: 'graduation', label: 'Graduation' },
  { key: 'post_graduation', label: 'Post graduation' },
] as const;
const RELATIONS = [
  { key: 'father', label: 'Father' },
  { key: 'mother', label: 'Mother' },
  { key: 'guardian', label: 'Guardian' },
] as const;

const str = (v: string) => (v.trim() === '' ? null : v.trim());
const num = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function Cols({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

/**
 * The student's profile, laid out in the order a counsellor asks the questions: the student, what
 * they want, their family, their marks and their exams. Every list in it (streams, places) comes
 * from the company's own settings and the shared places list.
 */
export function ProfileTab({ lead }: { lead: LeadDetail }) {
  const { can } = useAuth();
  const profile = useApi<Profile>(`/leads/${lead.id}/profile`);
  const streams = useApi<{ id: string; name: string }[]>('/streams');

  if (profile.loading && !profile.data) return <Spinner />;
  if (profile.error) return <Notice tone="bad">{profile.error.message}</Notice>;
  if (!profile.data) return null;
  return <ProfileForm key={profile.data.updatedAt ?? 'new'} lead={lead} p={profile.data} streams={streams.data ?? []} editable={can('lead.update')} onSaved={profile.reload} />;
}

function ProfileForm({ lead, p, streams, editable, onSaved }: { lead: LeadDetail; p: Profile; streams: { id: string; name: string }[]; editable: boolean; onSaved: () => void }) {
  const [alternateEmail, setAlternateEmail] = useState(text(p.personal.alternateEmail));
  const [dob, setDob] = useState(text(p.personal.dateOfBirth));
  const [gender, setGender] = useState(text(p.personal.gender));
  const [category, setCategory] = useState(text(p.personal.category));
  const [location, setLocation] = useState<Place[]>(p.personal.currentLocation ? [p.personal.currentLocation] : []);
  const [altPhone, setAltPhone] = useState(text(p.personal.extraPhones.find((x) => x.label === 'alternate')?.phone));

  const [year, setYear] = useState(text(p.preferences.preferredYear));
  const [level, setLevel] = useState(text(p.preferences.preferredLevel));
  const [streamId, setStreamId] = useState(p.preferences.preferredStream?.id ?? '');
  const [budgetMin, setBudgetMin] = useState(text(p.preferences.budgetMin));
  const [budgetMax, setBudgetMax] = useState(text(p.preferences.budgetMax));
  const [loan, setLoan] = useState(p.preferences.loanRequired === null ? '' : p.preferences.loanRequired ? 'yes' : 'no');
  const [wanted, setWanted] = useState<Place[]>(p.preferences.preferredLocations);

  const [guardians, setGuardians] = useState(RELATIONS.map((r) => ({ name: null, phone: null, occupation: null, ...p.guardians.find((g) => g.relation === r.key), relation: r.key as string })));
  const [education, setEducation] = useState(LEVELS.map((l) => ({ marksType: null as string | null, marks: null as number | null, institution: null as string | null, board: null as string | null, passingYear: null as number | null, ...p.education.find((e) => e.level === l.key), level: l.key as string })));
  const [exams, setExams] = useState(p.exams.map((e) => ({ ...e })));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  // Extra numbers other than the "alternate" one are kept as they are.
  const otherPhones = p.personal.extraPhones.filter((x) => x.label !== 'alternate');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/leads/${lead.id}/profile`, {
        method: 'PATCH',
        body: {
          personal: {
            alternateEmail: str(alternateEmail), dateOfBirth: str(dob), gender: gender || null, category: category || null,
            currentLocationId: location[0]?.id ?? null,
            extraPhones: [...otherPhones.map((x) => ({ phone: x.phone, label: x.label })), ...(str(altPhone) ? [{ phone: altPhone.trim(), label: 'alternate' }] : [])],
          },
          preferences: {
            preferredYear: num(year), preferredLevel: level || null, preferredStreamId: streamId || null, budgetMin: num(budgetMin), budgetMax: num(budgetMax),
            loanRequired: loan === '' ? null : loan === 'yes', preferredLocationIds: wanted.map((w) => w.id),
          },
          guardians: guardians.filter((g) => g.name || g.phone || g.occupation).map((g) => ({ relation: g.relation, name: g.name, phone: g.phone, occupation: g.occupation })),
          education: education
            .filter((x) => x.marks !== null || x.institution || x.board || x.passingYear)
            .map((x) => ({ ...x, marksType: x.marks !== null ? (x.marksType ?? 'percentage') : x.marksType })),
          exams: exams.filter((x) => x.examName.trim()),
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server.'));
    } finally {
      setBusy(false);
    }
  }

  const fe = (name: string) => error?.fieldErrors.find((f) => f.field.endsWith(name))?.message;
  const dis = !editable;

  return (
    <form onSubmit={save}>
      <Card className="overflow-hidden">
        <SectionBand>Student details</SectionBand>
        <Cols>
          <Field label="Name"><Input value={lead.name} disabled /></Field>
          <Field label="Mobile"><Input value={lead.phone} disabled /></Field>
          <Field label="Email"><Input value={lead.email ?? ''} disabled /></Field>
          <Field label="Alternate email" htmlFor="ae" error={fe('alternateEmail')}><Input id="ae" type="email" value={alternateEmail} onChange={(e) => setAlternateEmail(e.target.value)} disabled={dis} /></Field>
          <Field label="Alternate phone number" htmlFor="ap" error={fe('phone')}><Input id="ap" inputMode="tel" value={altPhone} onChange={(e) => setAltPhone(e.target.value)} disabled={dis} /></Field>
          <Field label="Date of birth" htmlFor="dob" error={fe('dateOfBirth')}><Input id="dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} disabled={dis} /></Field>
          <Field label="Gender" htmlFor="g">
            <Select id="g" value={gender} onChange={(e) => setGender(e.target.value)} disabled={dis}><option value="">Select</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></Select>
          </Field>
          <Field label="Category" htmlFor="cat">
            <Select id="cat" value={category} onChange={(e) => setCategory(e.target.value)} disabled={dis}>
              <option value="">Select</option><option value="general">General</option><option value="obc">OBC</option><option value="sc">SC</option><option value="st">ST</option><option value="ews">EWS</option><option value="other">Other</option>
            </Select>
          </Field>
          <div className="sm:col-span-2"><Field label="Current city or state" htmlFor="loc"><LocationPicker id="loc" value={location} onChange={setLocation} /></Field></div>
        </Cols>

        <SectionBand>Preference</SectionBand>
        <Cols>
          <Field label="Level" htmlFor="lv">
            <Select id="lv" value={level} onChange={(e) => setLevel(e.target.value)} disabled={dis}><option value="">Select</option><option value="UG">UG</option><option value="PG">PG</option><option value="Diploma">Diploma</option></Select>
          </Field>
          <Field label="Stream" htmlFor="sm">
            <Select id="sm" value={streamId} onChange={(e) => setStreamId(e.target.value)} disabled={dis}><option value="">Select</option>{streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
          <Field label="Preferred year" htmlFor="py" error={fe('preferredYear')}><Input id="py" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2027" disabled={dis} /></Field>
          <Field label="Loan required" htmlFor="ln">
            <Select id="ln" value={loan} onChange={(e) => setLoan(e.target.value)} disabled={dis}><option value="">Not asked</option><option value="yes">Yes</option><option value="no">No</option></Select>
          </Field>
          <Field label="Budget from (₹ a year)" htmlFor="b1" error={fe('budgetMin')}><Input id="b1" inputMode="numeric" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} disabled={dis} /></Field>
          <Field label="Budget up to (₹ a year)" htmlFor="b2" error={fe('budgetMax')}><Input id="b2" inputMode="numeric" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} disabled={dis} /></Field>
          <div className="sm:col-span-2"><Field label="Where do they want to study" htmlFor="pl" hint="Cities or states. Used to match colleges."><LocationPicker id="pl" multiple value={wanted} onChange={setWanted} /></Field></div>
        </Cols>

        <SectionBand>Parent / guardian details</SectionBand>
        <div className="divide-y divide-line">
          {guardians.map((g, i) => (
            <Cols key={g.relation}>
              <Field label={`${RELATIONS[i]!.label}'s name`}><Input value={text(g.name)} onChange={(e) => setGuardians((l) => l.map((x, k) => (k === i ? { ...x, name: e.target.value || null } : x)))} disabled={dis} /></Field>
              <Field label="Phone number" error={i === 0 ? fe('phone') : undefined}><Input inputMode="tel" value={text(g.phone)} onChange={(e) => setGuardians((l) => l.map((x, k) => (k === i ? { ...x, phone: e.target.value || null } : x)))} disabled={dis} /></Field>
              <Field label="Occupation"><SuggestInput field="occupation" value={text(g.occupation)} onChange={(e) => setGuardians((l) => l.map((x, k) => (k === i ? { ...x, occupation: e.target.value || null } : x)))} disabled={dis} /></Field>
            </Cols>
          ))}
        </div>

        <SectionBand>Academic details</SectionBand>
        <div className="divide-y divide-line">
          {education.map((ed, i) => (
            <Cols key={ed.level}>
              <Field label={`${LEVELS[i]!.label} marks`} error={fe('marks')}>
                <div className="flex gap-2">
                  <Input inputMode="decimal" value={text(ed.marks)} onChange={(e) => setEducation((l) => l.map((x, k) => (k === i ? { ...x, marks: num(e.target.value) } : x)))} disabled={dis} />
                  <Select aria-label={`${LEVELS[i]!.label} marks type`} value={ed.marksType ?? 'percentage'} onChange={(e) => setEducation((l) => l.map((x, k) => (k === i ? { ...x, marksType: e.target.value } : x)))} disabled={dis} className="w-28"><option value="percentage">%</option><option value="cgpa">CGPA</option></Select>
                </div>
              </Field>
              <Field label="School or college"><SuggestInput field="institution" value={text(ed.institution)} onChange={(e) => setEducation((l) => l.map((x, k) => (k === i ? { ...x, institution: e.target.value || null } : x)))} disabled={dis} /></Field>
              <Field label="Board or university"><SuggestInput field="board" value={text(ed.board)} onChange={(e) => setEducation((l) => l.map((x, k) => (k === i ? { ...x, board: e.target.value || null } : x)))} disabled={dis} /></Field>
              <Field label="Passing year" error={fe('passingYear')}><Input inputMode="numeric" value={text(ed.passingYear)} onChange={(e) => setEducation((l) => l.map((x, k) => (k === i ? { ...x, passingYear: num(e.target.value) } : x)))} disabled={dis} /></Field>
            </Cols>
          ))}
        </div>

        <SectionBand>Exams</SectionBand>
        <div className="space-y-3 px-4 py-4">
          {exams.length === 0 && <p className="text-xs text-subtle">No exams added.</p>}
          {exams.map((x, i) => (
            <div key={i} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
              <Field label="Exam name"><SuggestInput field="exam" value={x.examName} onChange={(e) => setExams((l) => l.map((y, k) => (k === i ? { ...y, examName: e.target.value } : y)))} disabled={dis} placeholder="JEE Main, CAT, NEET…" /></Field>
              <Field label="Marks type">
                <Select value={x.marksType ?? ''} onChange={(e) => setExams((l) => l.map((y, k) => (k === i ? { ...y, marksType: e.target.value || null } : y)))} disabled={dis}><option value="">Select</option><option value="score">Score</option><option value="rank">Rank</option><option value="percentile">Percentile</option></Select>
              </Field>
              <Field label="Exam score" error={fe('score')}><Input inputMode="decimal" value={text(x.score)} onChange={(e) => setExams((l) => l.map((y, k) => (k === i ? { ...y, score: num(e.target.value) } : y)))} disabled={dis} /></Field>
              <Field label="Year"><Input inputMode="numeric" value={text(x.examYear)} onChange={(e) => setExams((l) => l.map((y, k) => (k === i ? { ...y, examYear: num(e.target.value) } : y)))} disabled={dis} /></Field>
              {!dis && <Button type="button" variant="ghost" aria-label="Remove exam" onClick={() => setExams((l) => l.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4 text-bad" aria-hidden /></Button>}
            </div>
          ))}
          {!dis && exams.length < 10 && <Button type="button" variant="secondary" size="sm" onClick={() => setExams((l) => [...l, { examName: '', marksType: null, score: null, examYear: null }])}><Plus className="h-3.5 w-3.5" aria-hidden /> Add an exam</Button>}
        </div>
      </Card>

      {error && <div className="mt-3"><Notice tone="bad">{error.message}</Notice></div>}
      {saved && <div className="mt-3"><Notice tone="ok">Profile saved.</Notice></div>}
      <div className="sticky bottom-0 mt-4 flex items-center justify-between gap-3 border-t border-line bg-canvas/95 py-3 backdrop-blur">
        <p className="text-xs text-subtle">{p.updatedAt ? `Last saved ${fmtDateTime(p.updatedAt)}${p.updatedBy ? ` by ${p.updatedBy}` : ''}` : 'Not saved yet'}</p>
        {editable && <Button type="submit" variant="accent" loading={busy}>Save changes</Button>}
      </div>
    </form>
  );
}
