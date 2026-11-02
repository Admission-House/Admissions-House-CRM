import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { chooseDocument, chooseImage, takePhoto, type PickedFile } from '@/core/pick-file';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { Badge, Button, Card, Empty, Muted, Notice, Spinner, Title } from '@/core/ui';
import type { LeadDocument } from '@/models/types';
import { BASIC_DOCUMENTS, fileSize, useDocumentsViewModel } from '@/viewmodels/documents';

type Vm = ReturnType<typeof useDocumentsViewModel>;

/** One kind of document: what is uploaded, and, for people who may, a way to add or remove files. */
function Slot({ vm, title, docType, shortlistId, manage }: { vm: Vm; title: string; docType: string; shortlistId?: string; manage: boolean }) {
  const [choosing, setChoosing] = useState(false);
  const key = `up${docType}${shortlistId ?? ''}`;
  const docs: LeadDocument[] = vm.of(docType, shortlistId);
  const imageOnly = vm.limits.data?.imageOnly.includes(docType) ?? false;

  /** Runs a picker, then uploads what was chosen. A person backing out is not an error. */
  async function pick(picker: () => Promise<PickedFile | null>) {
    setChoosing(false);
    vm.setError(null);
    try {
      const file = await picker();
      if (file) await vm.upload(key, docType, file, shortlistId);
    } catch (e) {
      vm.setError(e instanceof Error ? e.message : 'Could not get that file.');
    }
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ionicons name={imageOnly ? 'image-outline' : 'document-text-outline'} size={22} color={color.brand600} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: '700', color: color.ink }}>{title}</Text>
          <Muted>{imageOnly ? 'JPG or PNG' : 'JPG, PNG or PDF'}{vm.limits.data ? ` · up to ${fileSize(vm.limits.data.maxBytes)}` : ''}</Muted>
        </View>
      </View>
      {docs.length === 0 ? <Muted>Nothing uploaded yet.</Muted> : docs.map((d) => (
        <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
          <Pressable accessibilityRole="button" style={{ flex: 1 }} onPress={() => void vm.open(d)}>
            <Text style={{ color: color.info, fontWeight: '600' }} numberOfLines={1}>{vm.busy === `open${d.id}` ? 'Opening…' : d.name}</Text>
            <Muted>{fileSize(d.sizeBytes)}{d.uploadedBy ? ` · ${d.uploadedBy}` : ''}</Muted>
          </Pressable>
          {manage && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${d.name}`} hitSlop={10} onPress={() => void vm.remove(d)}>
              <Ionicons name="trash-outline" size={20} color={color.bad} />
            </Pressable>
          )}
        </View>
      ))}
      {manage && (choosing ? (
        <View style={{ gap: 8 }}>
          <Button title="Take a photo" icon="camera" onPress={() => void pick(takePhoto)} />
          <Button title="Choose from gallery" variant="secondary" icon="images" onPress={() => void pick(chooseImage)} />
          {!imageOnly && <Button title="Choose a PDF or file" variant="secondary" icon="document" onPress={() => void pick(chooseDocument)} />}
          <Button title="Cancel" variant="secondary" onPress={() => setChoosing(false)} />
        </View>
      ) : (
        <Button title="Upload" variant="secondary" icon="cloud-upload-outline" loading={vm.busy === key} onPress={() => setChoosing(true)} />
      ))}
    </Card>
  );
}

/** The student's documents: the basic ones, and the admission documents kept with each shortlisted college. */
export function DocumentsTab({ leadId }: { leadId: string }) {
  const { can } = useSession();
  const vm = useDocumentsViewModel(leadId);
  const manage = can('document.manage');
  if ((vm.docs.loading && !vm.docs.data) || !vm.limits.data) return vm.limits.error ? <Notice tone="bad">{vm.limits.error.message}</Notice> : <Spinner />;
  if (vm.docs.error) return <Notice tone="bad">{vm.docs.error.message}</Notice>;
  const shortlists = vm.shortlists.data ?? [];

  return (
    <>
      {vm.error && <Notice tone="bad">{vm.error}</Notice>}
      <Title>Basic documents</Title>
      {BASIC_DOCUMENTS.map((b) => <Slot key={b.type} vm={vm} title={b.label} docType={b.type} manage={manage} />)}

      <Title>Admission documents</Title>
      <Muted>Kept with the college the student shortlisted.</Muted>
      {shortlists.length === 0 ? (
        <Card><Empty title="Shortlist a college first" hint="Admission documents belong to a shortlisted college." /></Card>
      ) : shortlists.map((s) => (
        <View key={s.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontWeight: '700', color: color.info }}>{s.college.name}</Text>
            {!!s.college.location && <Badge>{s.college.location}</Badge>}
          </View>
          <Slot vm={vm} title="Admission documents" docType="admission" shortlistId={s.id} manage={manage} />
        </View>
      ))}
    </>
  );
}
