import { useState } from 'react';
import { View } from 'react-native';
import type { StatusOption } from '@/models/types';
import type { WrapUpInput } from '@/viewmodels/lead-calls';
import { DateField } from './date-field';
import { useSession } from './session';
import { Button, Card, Chips, Field, Muted, Notice, Title } from './ui';

/** The after-call form: what the lead's status is now, when to follow up, and a remark. */
export function WrapUpForm({ statuses, loadError, busy, error, hint, onSave, onCancel }: {
  statuses: StatusOption[];
  loadError?: string;
  busy: boolean;
  error?: string | null;
  hint?: string;
  onSave: (input: WrapUpInput) => void;
  onCancel: () => void;
}) {
  const { can } = useSession();
  const [statusId, setStatusId] = useState('');
  const [substatusId, setSubstatusId] = useState('');
  const [remark, setRemark] = useState('');
  const [due, setDue] = useState<Date | null>(null);
  const options = statuses.filter((s) => s.isActive !== false);
  const chosen = options.find((s) => s.id === statusId);
  const needsDate = !!chosen?.isOpen && !!chosen.requiresFollowup;

  return (
    <Card>
      <Title>After the call</Title>
      <Muted>{hint ?? "Choose what the lead's status is now."}</Muted>
      {loadError && <Notice tone="bad">{loadError}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      <Chips options={options.map((s) => ({ key: s.id, label: s.name }))} value={statusId} onChange={(v) => { setStatusId(v); setSubstatusId(''); }} />
      {chosen?.substatuses && chosen.substatuses.length > 0 && (
        <Chips options={[{ key: '', label: 'No sub-status' }, ...chosen.substatuses.map((s) => ({ key: s.id, label: s.name }))]} value={substatusId} onChange={setSubstatusId} />
      )}
      {can('followup.manage') && chosen?.isOpen && (
        <DateField label={needsDate ? 'Next follow-up (required)' : 'Next follow-up (optional)'} withTime value={due} onChange={setDue} minimum={new Date()} />
      )}
      <Field label="Remark" value={remark} onChangeText={setRemark} placeholder="What was discussed?" multiline maxLength={1000} style={{ minHeight: 80, textAlignVertical: 'top' }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button title="Later" variant="secondary" onPress={onCancel} /></View>
        <View style={{ flex: 1 }}>
          <Button title="Save" loading={busy} disabled={!statusId || (needsDate && !due)} onPress={() => onSave({ statusId, substatusId: substatusId || undefined, remark, followUpAt: due ?? undefined })} />
        </View>
      </View>
    </Card>
  );
}
