import { useState } from 'react';
import { View } from 'react-native';
import { DateField } from '@/core/date-field';
import { fmtDateTime, ymd } from '@/core/format';
import { useSession } from '@/core/session';
import { PlacePicker } from '@/core/place-picker';
import { Button, Card, Chips, Field, Muted, Notice, Row, Spinner, Title } from '@/core/ui';
import type { Place, Profile } from '@/models/types';
import { LEVELS, RELATIONS, num, str, text, useProfileViewModel } from '@/viewmodels/profile';

type Vm = ReturnType<typeof useProfileViewModel>;

const GENDERS = [{ key: '', label: 'Not set' }, { key: 'female', label: 'Female' }, { key: 'male', label: 'Male' }, { key: 'other', label: 'Other' }];
const CATEGORIES = [{ key: '', label: 'Not set' }, { key: 'general', label: 'General' }, { key: 'obc', label: 'OBC' }, { key: 'sc', label: 'SC' }, { key: 'st', label: 'ST' }, { key: 'ews', label: 'EWS' }, { key: 'other', label: 'Other' }];
const PREF_LEVELS = [{ key: '', label: 'Not set' }, { key: 'UG', label: 'UG' }, { key: 'PG', label: 'PG' }, { key: 'Diploma', label: 'Diploma' }];
const LOAN = [{ key: '', label: 'Not set' }, { key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }];
const MARKS = [{ key: 'percentage', label: '%' }, { key: 'cgpa', label: 'CGPA' }];

/** The student's profile in the order a counsellor asks the questions: the student, what they want, family, marks and exams. */
export function ProfileTab({ lead }: { lead: { id: string; name: string; phone: string; email: string | null } }) {
  const vm = useProfileViewModel(lead.id);
  if (vm.profile.loading && !vm.profile.data) return <Spinner />;
  if (vm.profile.error) return <Notice tone="bad">{vm.profile.error.message}</Notice>;
  if (!vm.profile.data) return null;
  // Keyed by the last save, so the boxes start from what the server now holds.
  return <ProfileForm key={vm.profile.data.updatedAt ?? 'new'} lead={lead} p={vm.profile.data} vm={vm} />;
}

function ProfileForm({ lead, p, vm }: { lead: { id: string; name: string; phone: string; email: string | null }; p: Profile; vm: Vm }) {
  const { can } = useSession();
  const editable = can('lead.update');

  const [alternateEmail, setAlternateEmail] = useState(text(p.personal.alternateEmail));
  const [altPhone, setAltPhone] = useState(text(p.personal.extraPhones.find((x) => x.label === 'alternate')?.phone));
  const [dob, setDob] = useState<Date | null>(p.personal.dateOfBirth ? new Date(`${p.personal.dateOfBirth}T00:00:00`) : null);
  const [gender, setGender] = useState(text(p.personal.gender));
  const [category, setCategory] = useState(text(p.personal.category));

  const [location, setLocation] = useState<Place[]>(p.personal.currentLocation ? [p.personal.currentLocation] : []);
  const [wanted, setWanted] = useState<Place[]>(p.preferences.preferredLocations);
  const [year, setYear] = useState(text(p.preferences.preferredYear));
  const [level, setLevel] = useState(text(p.preferences.preferredLevel));
  const [streamId, setStreamId] = useState(p.preferences.preferredStream?.id ?? '');
  const [budgetMin, setBudgetMin] = useState(text(p.preferences.budgetMin));
  const [budgetMax, setBudgetMax] = useState(text(p.preferences.budgetMax));
  const [loan, setLoan] = useState(p.preferences.loanRequired === null ? '' : p.preferences.loanRequired ? 'yes' : 'no');

  const [guardians, setGuardians] = useState(RELATIONS.map((r) => ({ name: null as string | null, phone: null as string | null, occupation: null as string | null, ...p.guardians.find((g) => g.relation === r.key), relation: r.key as string })));
  const [education, setEducation] = useState(LEVELS.map((l) => ({ marksType: null as string | null, marks: null as number | null, institution: null as string | null, board: null as string | null, passingYear: null as number | null, ...p.education.find((e) => e.level === l.key), level: l.key as string })));
  const [exams, setExams] = useState(p.exams.map((e) => ({ ...e })));

  // Extra numbers other than the "alternate" one are kept as they are.
  const otherPhones = p.personal.extraPhones.filter((x) => x.label !== 'alternate');
  const fieldErrors = vm.error?.fieldErrors ?? [];
  const streams = [{ key: '', label: 'Not set' }, ...(vm.streams.data ?? []).map((s) => ({ key: s.id, label: s.name }))];

  const setGuardian = (i: number, patch: Partial<(typeof guardians)[number]>) => setGuardians((g) => g.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const setEdu = (i: number, patch: Partial<(typeof education)[number]>) => setEducation((g) => g.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const setExam = (i: number, patch: Partial<(typeof exams)[number]>) => setExams((g) => g.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  function save() {
    void vm.save({
      personal: {
        alternateEmail: str(alternateEmail), dateOfBirth: dob ? ymd(dob) : null, gender: gender || null, category: category || null, currentLocationId: location[0]?.id ?? null,
        extraPhones: [...otherPhones.map((x) => ({ phone: x.phone, label: x.label })), ...(str(altPhone) ? [{ phone: altPhone.trim(), label: 'alternate' }] : [])],
      },
      preferences: {
        preferredYear: num(year), preferredLevel: level || null, preferredStreamId: streamId || null,
        budgetMin: num(budgetMin), budgetMax: num(budgetMax), loanRequired: loan === '' ? null : loan === 'yes', preferredLocationIds: wanted.map((w) => w.id),
      },
      guardians: guardians.filter((g) => g.name || g.phone || g.occupation).map((g) => ({ relation: g.relation, name: g.name, phone: g.phone, occupation: g.occupation })),
      education: education
        .filter((x) => x.marks !== null || x.institution || x.board || x.passingYear)
        .map((x) => ({ ...x, marksType: x.marks !== null ? (x.marksType ?? 'percentage') : x.marksType })),
      exams: exams.filter((x) => x.examName.trim()),
    });
  }

  return (
    <>
      {vm.error && <Notice tone="bad">{[vm.error.message, ...fieldErrors.map((f) => f.message)].join(' ')}</Notice>}
      {vm.saved && <Notice tone="ok">Saved.</Notice>}

      <Card>
        <Title>Student details</Title>
        <Row label="Name" value={lead.name} />
        <Row label="Mobile" value={lead.phone} />
        <Row label="Email" value={lead.email} />
        <Field label="Alternate email" value={alternateEmail} onChangeText={setAlternateEmail} editable={editable} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
        <Field label="Alternate phone number" value={altPhone} onChangeText={setAltPhone} editable={editable} keyboardType="phone-pad" />
        {editable ? <DateField label="Date of birth" value={dob} onChange={setDob} /> : <Row label="Date of birth" value={dob ? ymd(dob) : ''} />}
        <Muted>Gender</Muted>
        <Chips options={GENDERS} value={gender} onChange={(v) => editable && setGender(v)} />
        <Muted>Category</Muted>
        <Chips options={CATEGORIES} value={category} onChange={(v) => editable && setCategory(v)} />
        <PlacePicker title="Current city or state" value={location} onChange={setLocation} disabled={!editable} />
      </Card>

      <Card>
        <Title>Preference</Title>
        <Muted>Level</Muted>
        <Chips options={PREF_LEVELS} value={level} onChange={(v) => editable && setLevel(v)} />
        <Muted>Stream</Muted>
        <Chips options={streams} value={streamId} onChange={(v) => editable && setStreamId(v)} />
        <Field label="Preferred year" value={year} onChangeText={setYear} editable={editable} keyboardType="number-pad" maxLength={4} />
        <Field label="Budget from (₹ a year)" value={budgetMin} onChangeText={setBudgetMin} editable={editable} keyboardType="decimal-pad" />
        <Field label="Budget up to (₹ a year)" value={budgetMax} onChangeText={setBudgetMax} editable={editable} keyboardType="decimal-pad" />
        <Muted>Loan required</Muted>
        <Chips options={LOAN} value={loan} onChange={(v) => editable && setLoan(v)} />
        <PlacePicker title="Where they want to study" value={wanted} onChange={setWanted} multiple disabled={!editable} />
      </Card>

      <Card>
        <Title>Parent or guardian</Title>
        {guardians.map((g, i) => (
          <View key={g.relation} style={{ gap: 8 }}>
            <Muted>{RELATIONS[i]!.label}</Muted>
            <Field label="Name" value={text(g.name)} onChangeText={(v) => setGuardian(i, { name: str(v) })} editable={editable} />
            <Field label="Phone number" value={text(g.phone)} onChangeText={(v) => setGuardian(i, { phone: str(v) })} editable={editable} keyboardType="phone-pad" />
            <Field label="Occupation" value={text(g.occupation)} onChangeText={(v) => setGuardian(i, { occupation: str(v) })} editable={editable} />
          </View>
        ))}
      </Card>

      <Card>
        <Title>Academic details</Title>
        {education.map((e, i) => (
          <View key={e.level} style={{ gap: 8 }}>
            <Muted>{LEVELS[i]!.label}</Muted>
            <Field label="Marks" value={text(e.marks)} onChangeText={(v) => setEdu(i, { marks: num(v) })} editable={editable} keyboardType="decimal-pad" />
            <Chips options={MARKS} value={e.marksType ?? 'percentage'} onChange={(v) => editable && setEdu(i, { marksType: v })} />
            <Field label="School or college" value={text(e.institution)} onChangeText={(v) => setEdu(i, { institution: str(v) })} editable={editable} />
            <Field label="Board or university" value={text(e.board)} onChangeText={(v) => setEdu(i, { board: str(v) })} editable={editable} />
            <Field label="Passing year" value={text(e.passingYear)} onChangeText={(v) => setEdu(i, { passingYear: num(v) })} editable={editable} keyboardType="number-pad" maxLength={4} />
          </View>
        ))}
      </Card>

      <Card>
        <Title>Exams</Title>
        {exams.length === 0 && <Muted>No exam scores yet.</Muted>}
        {exams.map((x, i) => (
          <View key={i} style={{ gap: 8 }}>
            <Field label="Exam name" value={x.examName} onChangeText={(v) => setExam(i, { examName: v })} editable={editable} maxLength={80} />
            <Chips options={[{ key: 'score', label: 'Score' }, { key: 'rank', label: 'Rank' }, { key: 'percentile', label: 'Percentile' }]} value={x.marksType ?? 'score'} onChange={(v) => editable && setExam(i, { marksType: v })} />
            <Field label="Exam score" value={text(x.score)} onChangeText={(v) => setExam(i, { score: num(v) })} editable={editable} keyboardType="decimal-pad" />
            <Field label="Year" value={text(x.examYear)} onChangeText={(v) => setExam(i, { examYear: num(v) })} editable={editable} keyboardType="number-pad" maxLength={4} />
            {editable && <Button title="Remove this exam" variant="secondary" onPress={() => setExams((l) => l.filter((_, k) => k !== i))} />}
          </View>
        ))}
        {editable && exams.length < 10 && <Button title="Add an exam" variant="secondary" icon="add" onPress={() => setExams((l) => [...l, { examName: '', marksType: null, score: null, examYear: null }])} />}
      </Card>

      {editable && <Button title="Save changes" loading={vm.busy} onPress={save} />}
      {p.updatedAt && <Muted>Last saved {fmtDateTime(p.updatedAt)}{p.updatedBy ? ` by ${p.updatedBy}` : ''}</Muted>}
    </>
  );
}
