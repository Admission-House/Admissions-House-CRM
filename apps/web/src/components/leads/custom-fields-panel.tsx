'use client';

import { useState } from 'react';
import { Button, Field, Input, Notice, Panel, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';
import type { LeadDetail } from './lead-panels';

interface CustomField {
  id: string;
  key: string;
  label: string;
  dataType: 'text' | 'number' | 'date' | 'select';
  isRequired: boolean;
  options: { value: string; label: string }[];
  value: string | null;
}

/** The extra fields this company added to its leads. Shown only when there are some. */
export function CustomFieldsPanel({ lead }: { lead: LeadDetail }) {
  const { can } = useAuth();
  const fields = useApi<CustomField[]>(`/leads/${lead.id}/custom-fields`);
  if (!fields.data || fields.data.length === 0) return null;
  return <FieldsForm key={fields.data.map((f) => `${f.key}:${f.value ?? ''}`).join('|')} lead={lead} fields={fields.data} editable={can('lead.update')} onSaved={fields.reload} />;
}

function FieldsForm({ lead, fields, editable, onSaved }: { lead: LeadDetail; fields: CustomField[]; editable: boolean; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.value ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = fields.some((f) => (f.value ?? '') !== values[f.key]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const changed = Object.fromEntries(fields.filter((f) => (f.value ?? '') !== values[f.key]).map((f) => [f.key, values[f.key] === '' ? null : values[f.key]]));
      await api(`/leads/${lead.id}/custom-fields`, { method: 'PUT', body: { values: changed } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="More details">
      <form onSubmit={save} className="space-y-3">
        {error && <Notice tone="bad">{error.message}</Notice>}
        {saved && <Notice tone="ok">Saved.</Notice>}
        {fields.map((f) => {
          const err = error?.fieldErrors.find((x) => x.field === f.key)?.message;
          const set = (v: string) => setValues((s) => ({ ...s, [f.key]: v }));
          return (
            <Field key={f.id} label={f.label} htmlFor={`cf-${f.key}`} required={f.isRequired} error={err}>
              {f.dataType === 'select' ? (
                <Select id={`cf-${f.key}`} value={values[f.key]} onChange={(e) => set(e.target.value)} disabled={!editable}><option value="">Select</option>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
              ) : (
                <Input id={`cf-${f.key}`} type={f.dataType === 'number' ? 'number' : f.dataType === 'date' ? 'date' : 'text'} step="any" value={values[f.key]} onChange={(e) => set(e.target.value)} disabled={!editable} />
              )}
            </Field>
          );
        })}
        {editable && <Button type="submit" size="sm" loading={busy} disabled={!dirty}>Save details</Button>}
      </form>
    </Panel>
  );
}
