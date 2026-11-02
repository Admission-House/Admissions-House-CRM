import { useState } from 'react';
import { Text, View } from 'react-native';
import { fmtDateTime } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { PlacePicker } from '@/core/place-picker';
import { Badge, Button, Card, Chips, Empty, Field, Muted, Notice, Spinner, Title } from '@/core/ui';
import type { CollegeItem } from '@/models/types';
import { MODES, useCollegesViewModel } from '@/viewmodels/colleges';
import { CoursePicker } from './course-picker';

/** Find colleges, recommend them to the student, or shortlist them with chosen courses. */
export function CollegesTab({ lead, onChanged }: { lead: { id: string; name: string; studyMode: string | null }; onChanged: () => void }) {
  const { can } = useSession();
  const manage = can('shortlist.manage');
  const vm = useCollegesViewModel(lead.id, onChanged);
  const [picking, setPicking] = useState<{ id: string; name: string } | null>(null);
  const found = vm.colleges.data?.items ?? [];
  const courseOptions = [{ key: '', label: 'Any course' }, ...(vm.courses.data?.items ?? []).map((c) => ({ key: c.id, label: `${c.name} (${c.level})` }))];

  const modes = (c: CollegeItem) => (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {c.offersOnline && <Badge tone="info">Online</Badge>}
      {c.offersRegular && <Badge tone="neutral">Regular</Badge>}
    </View>
  );

  return (
    <>
      {vm.error && <Notice tone="bad">{vm.error}</Notice>}
      <Card>
        <Title>Find colleges</Title>
        <Field label="Name" value={vm.typed} onChangeText={vm.setTyped} placeholder="Search a college" autoCorrect={false} />
        <PlacePicker title="City or state" value={vm.place} onChange={vm.setPlace} />
        <Muted>Study mode{lead.studyMode ? ` (this student prefers ${lead.studyMode})` : ''}</Muted>
        <Chips options={MODES} value={vm.mode} onChange={vm.setMode} />
        <Muted>Course</Muted>
        <Chips options={courseOptions} value={vm.courseId} onChange={vm.setCourseId} />
      </Card>

      {vm.colleges.error && <Notice tone="bad">{vm.colleges.error.message}</Notice>}
      {vm.colleges.loading && !vm.colleges.data ? <Spinner /> : found.length === 0 ? <Empty title="No colleges match" hint="Change a filter, or ask an admin to add the college." /> : found.map((c) => {
        const isRec = vm.recommendedIds.has(c.id);
        return (
          <Card key={c.id}>
            <Text style={{ fontWeight: '700', color: color.info, fontSize: 15 }}>{c.name}</Text>
            <Muted>{c.location ? `${c.location.name}${c.location.state ? `, ${c.location.state}` : ''} · ` : ''}{c.courseCount} course{c.courseCount === 1 ? '' : 's'}</Muted>
            {modes(c)}
            {manage && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}><Button title={isRec ? 'Recommended' : 'Recommend'} variant="secondary" icon={isRec ? 'checkmark' : undefined} disabled={isRec} onPress={() => void vm.recommend(c.id)} /></View>
                <View style={{ flex: 1 }}><Button title="Shortlist" onPress={() => setPicking({ id: c.id, name: c.name })} /></View>
              </View>
            )}
          </Card>
        );
      })}

      <Card>
        <Title>Recommended to {lead.name}</Title>
        {vm.recommended.loading && !vm.recommended.data ? <Spinner /> : (vm.recommended.data?.length ?? 0) === 0 ? <Empty title="Nothing recommended yet" hint="Pick colleges above to suggest them." /> : vm.recommended.data!.map((r) => (
          <View key={r.college.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.line, gap: 4 }}>
            <Text style={{ fontWeight: '700', color: color.info }}>{r.college.name}</Text>
            <Muted>{r.college.location ?? ''}{r.recommendedBy ? ` · by ${r.recommendedBy}` : ''} · {fmtDateTime(r.at)}</Muted>
            {r.shortlisted ? <Badge tone="ok">Shortlisted</Badge> : manage && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}><Button title="Shortlist" onPress={() => setPicking({ id: r.college.id, name: r.college.name })} /></View>
                <View style={{ flex: 1 }}><Button title="Remove" variant="secondary" onPress={() => void vm.unrecommend(r.college.id)} /></View>
              </View>
            )}
          </View>
        ))}
      </Card>

      {picking && <CoursePicker leadId={lead.id} college={picking} onClose={() => setPicking(null)} onDone={() => { setPicking(null); vm.reloadRecommended(); onChanged(); }} />}
    </>
  );
}
