'use client';

import { Download, FileText, FileUp, ImageIcon, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, Card, Empty, Notice, Spinner } from '@/components/ui';
import { api, apiRaw, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import type { LeadDetail } from './lead-panels';
import type { Shortlist } from './admissions-tabs';

interface Doc {
  id: string;
  docType: string;
  shortlist: { id: string; college: string } | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
}

interface Limits {
  maxBytes: number;
  accepts: string[];
  imageOnly: string[];
}

const BASIC = [
  { type: 'aadhaar', label: 'Aadhaar card' },
  { type: 'tenth', label: "10th certificate" },
  { type: 'twelfth', label: "12th certificate" },
  { type: 'graduation', label: 'Graduation sheet' },
  { type: 'photo', label: 'Passport photo' },
  { type: 'signature', label: 'Student signature' },
] as const;

const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

async function open(leadId: string, d: Doc) {
  const res = await apiRaw(`/leads/${leadId}/documents/${d.id}/file`);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** One slot: shows what is uploaded for a kind of document, and lets those who may upload add or remove files. */
function Slot({ lead, title, docType, shortlistId, docs, limits, manage, onChanged, onError }: {
  lead: LeadDetail; title: string; docType: string; shortlistId?: string; docs: Doc[]; limits: Limits; manage: boolean; onChanged: () => void; onError: (m: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const imageOnly = limits.imageOnly.includes(docType);
  const accept = (imageOnly ? ['jpg', 'jpeg', 'png'] : limits.accepts).map((x) => `.${x}`).join(',');

  async function upload(file: File) {
    onError(null);
    if (file.size > limits.maxBytes) return onError(`${file.name} is larger than ${size(limits.maxBytes)}.`);
    setBusy(true);
    try {
      const form = new FormData();
      form.set('docType', docType);
      if (shortlistId) form.set('shortlistId', shortlistId);
      form.set('file', file);
      await apiRaw(`/leads/${lead.id}/documents`, { method: 'POST', body: form });
      onChanged();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(d: Doc) {
    onError(null);
    try {
      await api(`/leads/${lead.id}/documents/${d.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  }

  const Icon = imageOnly ? ImageIcon : FileText;
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-3 border-b border-line bg-head px-3.5 py-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface text-brand"><Icon className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="text-xs text-subtle">{imageOnly ? 'JPG or PNG' : 'JPG, PNG or PDF'} · up to {size(limits.maxBytes)}</p>
        </div>
      </div>
      <div className="flex-1 px-3.5 py-3">
        {docs.length === 0 ? <p className="text-xs text-subtle">Nothing uploaded yet.</p> : (
          <ul className="space-y-2">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                <button onClick={() => void open(lead.id, d).catch((e) => onError(errorText(e)))} className="flex min-w-0 items-center gap-2 text-left text-info hover:underline">
                  <Download className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">{d.name}</span>
                </button>
                <span className="flex shrink-0 items-center gap-2 text-xs text-subtle">
                  <span title={`${d.uploadedBy ?? ''} ${fmtDateTime(d.createdAt)}`}>{size(d.sizeBytes)}</span>
                  {manage && <button onClick={() => void remove(d)} aria-label={`Remove ${d.name}`} className="text-bad hover:opacity-70"><Trash2 className="h-3.5 w-3.5" /></button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {manage && (
        <div className="px-3.5 pb-3.5">
          <input ref={input} type="file" accept={accept} className="sr-only" aria-label={`Upload ${title}`} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <Button variant="secondary" size="sm" className="w-full" loading={busy} onClick={() => input.current?.click()}><FileUp className="h-3.5 w-3.5" aria-hidden /> Upload</Button>
        </div>
      )}
    </div>
  );
}

export function DocumentsTab({ lead }: { lead: LeadDetail }) {
  const { can } = useAuth();
  const docs = useApi<Doc[]>(`/leads/${lead.id}/documents`);
  const limits = useApi<Limits>('/documents/limits');
  const shortlists = useApi<Shortlist[]>(`/leads/${lead.id}/shortlists`, { view: 'active' });
  const [error, setError] = useState<string | null>(null);
  const manage = can('document.manage');

  if ((docs.loading && !docs.data) || !limits.data) return limits.error ? <Notice tone="bad">{limits.error.message}</Notice> : <Spinner />;
  if (docs.error) return <Notice tone="bad">{docs.error.message}</Notice>;
  const all = docs.data ?? [];
  const lim = limits.data;
  const of = (type: string, sid?: string) => all.filter((d) => d.docType === type && (d.shortlist?.id ?? undefined) === sid);

  return (
    <div className="space-y-6">
      {error && <Notice tone="bad">{error}</Notice>}

      <section>
        <div className="mb-3"><h2 className="text-sm font-semibold">Basic documents</h2><p className="text-xs text-muted">Documents of the student.</p></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {BASIC.map((b) => <Slot key={b.type} lead={lead} title={b.label} docType={b.type} docs={of(b.type)} limits={lim} manage={manage} onChanged={docs.reload} onError={setError} />)}
          <Slot lead={lead} title="Other documents" docType="other" docs={of('other')} limits={lim} manage={manage} onChanged={docs.reload} onError={setError} />
        </div>
      </section>

      <section>
        <div className="mb-3"><h2 className="text-sm font-semibold">Admission documents</h2><p className="text-xs text-muted">Kept with the college the student shortlisted.</p></div>
        {(shortlists.data?.length ?? 0) === 0 ? (
          <Card><Empty title="Shortlist a college first">Admission documents belong to a shortlisted college.</Empty></Card>
        ) : (
          <div className="space-y-4">
            {shortlists.data!.map((s) => (
              <Card key={s.id}>
                <div className="flex items-center gap-2 border-b border-line px-4 py-2.5"><p className="text-sm font-semibold text-info">{s.college.name}</p>{s.college.location && <Badge>{s.college.location}</Badge>}</div>
                <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Slot lead={lead} title="Admission documents" docType="admission" shortlistId={s.id} docs={of('admission', s.id)} limits={lim} manage={manage} onChanged={docs.reload} onError={setError} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
