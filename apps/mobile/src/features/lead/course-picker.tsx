import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { color } from '@/core/theme';
import { Button, Card, Empty, Muted, Notice, Sheet, Spinner } from '@/core/ui';
import type { Shortlist } from '@/models/types';
import { rupees, useCoursePickerViewModel } from '@/viewmodels/colleges';

/** Pick the courses a student wants at one college. Fees come from the college. */
export function CoursePicker({ leadId, college, existing, onClose, onDone }: {
  leadId: string;
  college: { id: string; name: string };
  existing?: Shortlist;
  onClose: () => void;
  onDone: () => void;
}) {
  const vm = useCoursePickerViewModel(leadId, college.id, existing, onDone);

  return (
    <Sheet title={existing ? `Courses at ${college.name}` : `Shortlist ${college.name}`} onClose={onClose}>
      {vm.error && <Notice tone="bad">{vm.error}</Notice>}
      {vm.detail.error && <Notice tone="bad">{vm.detail.error.message}</Notice>}
      {vm.detail.loading && !vm.detail.data ? <Spinner /> : vm.courses.length === 0 ? <Empty title="This college has no courses listed yet" /> : vm.courses.map((c) => {
        const on = vm.chosen.has(c.id);
        return (
          <Pressable key={c.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => vm.toggle(c.id)}>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? color.brand600 : color.subtle} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: color.ink }}>{c.course.name} <Text style={{ fontWeight: '400', color: color.muted }}>{c.course.level}</Text></Text>
                  <Muted>{c.deliveryMode} · CAF {rupees(c.cafFee)} · Fee {rupees(c.annualFee)} a year{c.durationYears ? ` · ${c.durationYears} yr` : ''}</Muted>
                </View>
              </View>
            </Card>
          </Pressable>
        );
      })}
      <Button title={existing ? 'Save courses' : 'Shortlist'} loading={vm.busy} onPress={() => void vm.save()} />
    </Sheet>
  );
}
