'use client';

import { ArrowLeft, Mail, MessageCircle, MessageSquareText, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { RecommendedTab, ShortlistTab } from '@/components/leads/admissions-tabs';
import { CallsTab } from '@/components/leads/calls-tab';
import { CustomFieldsPanel } from '@/components/leads/custom-fields-panel';
import { DocumentsTab } from '@/components/leads/documents-tab';
import { AssignPanel, FollowUpsPanel, StatusPanel, Timeline, type LeadDetail } from '@/components/leads/lead-panels';
import { ProfileTab } from '@/components/leads/profile-tab';
import { Avatar, Badge, Button, Card, Notice, Panel, Spinner, Tabs } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtPhone, fromNow } from '@/lib/format';
import { useApi } from '@/lib/use-api';

const INTENT_TONE = { hot: 'bad', warm: 'warn', cold: 'info' } as const;

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'profile', label: 'Profile' },
  { key: 'recommended', label: 'Recommended' },
  { key: 'shortlisted', label: 'Shortlisted' },
  { key: 'nidnp', label: 'NI / DNP' },
  { key: 'documents', label: 'Documents' },
  { key: 'reconciled', label: 'Reconciled colleges' },
  { key: 'calls', label: 'Calls' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children || <span className="font-normal text-subtle">Not set</span>}</dd>
    </div>
  );
}

function Workspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const lead = useApi<LeadDetail>(`/leads/${id}`);
  const [version, setVersion] = useState(0);
  const [calling, setCalling] = useState(false);
  const [callMessage, setCallMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const requested = params.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : 'activity';
  const setTab = (key: TabKey) => router.replace(`/leads/${id}${key === 'activity' ? '' : `?tab=${key}`}`, { scroll: false });

  const changed = () => {
    lead.reload();
    setVersion((v) => v + 1);
  };

  async function call() {
    setCalling(true);
    setCallMessage(null);
    try {
      await api(`/leads/${id}/call`, { method: 'POST', body: {} });
      setCallMessage({ tone: 'ok', text: 'Calling your phone now. Pick it up and the student will be connected.' });
    } catch (e) {
      setCallMessage({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Cannot reach the server.' });
    } finally {
      setCalling(false);
    }
  }

  if (lead.loading && !lead.data) return <Spinner />;
  if (lead.error && !lead.data) {
    return (
      <div className="space-y-4">
        <Notice tone="bad">{lead.error.status === 404 ? 'This lead does not exist, or it is not one you can see.' : lead.error.message}</Notice>
        <Link href="/leads" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"><ArrowLeft className="h-4 w-4" /> Back to leads</Link>
      </div>
    );
  }
  const l = lead.data;
  if (!l) return null;

  return (
    <>
      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/leads" aria-label="Back to leads" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-head hover:text-ink"><ArrowLeft className="h-4 w-4" /></Link>
            <Avatar name={l.name} size={40} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold text-ink">{l.name}</h1>
                <Badge tone={l.status.queue === 'missed' ? 'bad' : l.status.isOpen ? 'brand' : 'neutral'}>{l.status.name}{l.substatus ? ` · ${l.substatus.name}` : ''}</Badge>
                {l.intent && <Badge tone={INTENT_TONE[l.intent]}>{l.intent}</Badge>}
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                <span>LEAD ID: <span className="tabular font-medium text-ink">{l.leadNo}</span></span>
                <span className="tabular font-medium text-ink">{fmtPhone(l.phone)}</span>
                {l.email && <a href={`mailto:${l.email}`} className="inline-flex items-center gap-1 hover:text-brand"><Mail className="h-3 w-3" aria-hidden />{l.email}</a>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Opened on the person's own phone or computer, so no calling provider is needed. */}
            <a href={`https://wa.me/${l.phone.replace(/D/g, '')}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-head"><MessageCircle className="h-4 w-4 text-ok" aria-hidden /> WhatsApp</a>
            <a href={`sms:+${l.phone.replace(/D/g, '')}`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-head"><MessageSquareText className="h-4 w-4 text-info" aria-hidden /> SMS</a>
            {l.email && <a href={`mailto:${l.email}`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-head"><Mail className="h-4 w-4 text-muted" aria-hidden /> Email</a>}
            {can('call.place') && l.status.isOpen && <Button variant="accent" onClick={() => void call()} loading={calling}><PhoneCall className="h-4 w-4" aria-hidden /> Call</Button>}
          </div>
        </div>
        {callMessage && <div className="border-t border-line px-4 py-2.5"><Notice tone={callMessage.tone}>{callMessage.text}</Notice></div>}
        <Tabs label="Lead sections" tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={setTab} />
      </Card>

      {tab === 'activity' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="space-y-4">
            <FollowUpsPanel key={`f${version}`} lead={l} onChanged={changed} />
            <Timeline key={`t${version}`} lead={l} />
          </div>
          <div className="space-y-4">
            <StatusPanel key={`s${l.status.id}${version}`} lead={l} onChanged={changed} />
            <AssignPanel lead={l} onChanged={changed} />
            <Panel title="Details">
              <dl className="-my-2 divide-y divide-line">
                <Row label="Source">{l.source.name}</Row>
                <Row label="Study mode">{l.studyMode ? l.studyMode[0]!.toUpperCase() + l.studyMode.slice(1) : ''}</Row>
                <Row label="Expected closure">{fmtDate(l.expectedClosureOn)}</Row>
                <Row label="Next follow-up">{l.nextFollowupAt ? `${fmtDateTime(l.nextFollowupAt)} (${fromNow(l.nextFollowupAt)})` : ''}</Row>
                <Row label="First called">{l.firstCalledAt ? fromNow(l.firstCalledAt) : ''}</Row>
                <Row label="Added">{`${fmtDate(l.createdAt)}${l.createdBy ? ` by ${l.createdBy}` : ''}`}</Row>
                {l.extraPhones.map((p) => <Row key={p.phone} label={p.label[0]!.toUpperCase() + p.label.slice(1)}>{fmtPhone(p.phone)}</Row>)}
              </dl>
              {l.interestNote && <p className="mt-3 rounded-md bg-head px-3 py-2 text-xs text-muted">{l.interestNote}</p>}
            </Panel>
            <CustomFieldsPanel lead={l} />
          </div>
        </div>
      )}
      {tab === 'profile' && <ProfileTab lead={l} />}
      {tab === 'recommended' && <RecommendedTab key={version} lead={l} onChanged={changed} />}
      {tab === 'shortlisted' && <ShortlistTab key={`a${version}`} lead={l} view="active" onChanged={changed} empty="No college shortlisted yet" />}
      {tab === 'nidnp' && <ShortlistTab key={`n${version}`} lead={l} view="ni_dnp" onChanged={changed} empty="No college found" />}
      {tab === 'documents' && <DocumentsTab key={`d${version}`} lead={l} />}
      {tab === 'reconciled' && <ShortlistTab key={`r${version}`} lead={l} view="reconciled" onChanged={changed} empty="No reconciled colleges yet" />}
      {tab === 'calls' && <CallsTab key={`c${version}`} lead={l} onChanged={changed} />}
    </>
  );
}

export default function LeadPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Workspace />
    </Suspense>
  );
}
