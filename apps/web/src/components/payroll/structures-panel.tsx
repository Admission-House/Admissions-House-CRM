'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Spinner, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';
import { errorText, monthName, parseMoney, Person, rupees, Structure, StructureLine } from './payroll-types';

interface StructureList {
  month: string;
  people: { user: Person; structure: Structure | null }[];
}

const thisMonth = (): string => new Date().toLocaleDateString('en-CA').slice(0, 7);
const total = (lines: StructureLine[]): number => lines.reduce((n, l) => n + l.amount, 0);

/** What each person is paid before attendance is looked at: base pay, allowances and fixed deductions. */
export function StructuresPanel() {
  const { can } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const list = useApi<StructureList>('/salary-structures', { month });
  const [editing, setEditing] = useState<{ user: Person; structure: Structure | null } | null>(null);

  if (list.error) return <Notice tone="bad">{list.error.message}</Notice>;
  if (!list.data) return <Spinner />;
  const missing = list.data.people.filter((p) => !p.structure).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">Structure in force in <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-40" /></label>
        {missing > 0 && <Badge tone="warn">{missing} without a structure</Badge>}
      </div>
      <Panel title="Salary structures" flush>
        {list.data.people.length === 0 ? <Empty title="No people" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2.5 font-semibold">Person</th><th className="px-3 py-2.5 text-right font-semibold">Base pay</th><th className="px-3 py-2.5 text-right font-semibold">Allowances</th><th className="px-3 py-2.5 text-right font-semibold">Fixed deductions</th><th className="px-3 py-2.5 font-semibold">From</th><th className="px-4 py-2.5" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.people.map(({ user, structure }) => (
                  <tr key={user.id} className="hover:bg-mint-50">
                    <td className="px-4 py-3 font-medium">{user.name}<span className="block text-xs font-normal text-muted">{user.role}</span></td>
                    {structure ? (
                      <>
                        <td className="tabular px-3 py-3 text-right">{rupees(structure.basePay)}</td>
                        <td className="tabular px-3 py-3 text-right" title={structure.allowances.map((l) => `${l.label} ${rupees(l.amount)}`).join(', ')}>{rupees(total(structure.allowances))}</td>
                        <td className="tabular px-3 py-3 text-right" title={structure.deductions.map((l) => `${l.label} ${rupees(l.amount)}`).join(', ')}>{rupees(total(structure.deductions))}</td>
                        <td className="px-3 py-3">{monthName(structure.effectiveFrom)}</td>
                      </>
                    ) : <td colSpan={4} className="px-3 py-3 text-muted">No structure yet</td>}
                    <td className="px-4 py-3 text-right">{can('salary.write') && <Button size="sm" variant="secondary" onClick={() => setEditing({ user, structure })}>{structure ? 'Change' : 'Set'}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="text-xs text-subtle">A new structure applies from the month you choose and the old one is kept as history. You cannot set your own.</p>
      {editing && <StructureModal {...editing} month={month} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

interface Row { label: string; amount: string }

function StructureModal({ user, structure, month, onClose, onSaved }: { user: Person; structure: Structure | null; month: string; onClose: () => void; onSaved: () => void }) {
  const [from, setFrom] = useState(structure && structure.effectiveFrom === month ? structure.effectiveFrom : month);
  const [base, setBase] = useState(structure ? String(structure.basePay) : '');
  const [allow, setAllow] = useState<Row[]>((structure?.allowances ?? []).map((l) => ({ label: l.label, amount: String(l.amount) })));
  const [cut, setCut] = useState<Row[]>((structure?.deductions ?? []).map((l) => ({ label: l.label, amount: String(l.amount) })));
  const [notes, setNotes] = useState(structure?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toLines = (rows: Row[], what: string): StructureLine[] | null => {
    const out: StructureLine[] = [];
    for (const r of rows) {
      if (!r.label.trim() && !r.amount.trim()) continue;
      const n = parseMoney(r.amount);
      if (!r.label.trim() || n === null || n <= 0) {
        setError(`Each ${what} needs a name and an amount above 0`);
        return null;
      }
      out.push({ label: r.label.trim(), amount: n });
    }
    return out;
  };

  async function save(): Promise<void> {
    setError(null);
    const basePay = parseMoney(base);
    if (basePay === null) return setError('Enter the base pay in rupees, with at most two decimals');
    const allowances = toLines(allow, 'allowance');
    const deductions = toLines(cut, 'deduction');
    if (!allowances || !deductions) return;
    setBusy(true);
    try {
      await api('/salary-structures', { method: 'PUT', body: { userId: user.id, effectiveFrom: from, basePay, allowances, deductions, notes: notes.trim() || null } });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError && e.fieldErrors[0] ? e.fieldErrors[0].message : errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Salary structure: ${user.name}`} onClose={onClose} width="max-w-xl">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applies from" htmlFor="st-from" required><Input id="st-from" type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="Base pay per month (₹)" htmlFor="st-base" required><Input id="st-base" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} /></Field>
        </div>
        <Lines title="Allowances" hint="Added to base pay, for example HRA" rows={allow} onChange={setAllow} />
        <Lines title="Fixed deductions" hint="Taken every month, for example PF or TDS" rows={cut} onChange={setCut} />
        <Field label="Notes" htmlFor="st-notes"><Textarea id="st-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save structure</Button></div>
      </form>
    </Modal>
  );
}

function Lines({ title, hint, rows, onChange }: { title: string; hint: string; rows: Row[]; onChange: (rows: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">{title} <span className="text-xs font-normal text-subtle">{hint}</span></legend>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_8rem_2.25rem] gap-2">
          <Input aria-label={`${title} name ${i + 1}`} placeholder="Name" value={r.label} onChange={(e) => set(i, { label: e.target.value })} />
          <Input aria-label={`${title} amount ${i + 1}`} placeholder="Amount" inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} />
          <Button type="button" variant="ghost" aria-label={`Remove ${title} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...rows, { label: '', amount: '' }])}><Plus className="h-3.5 w-3.5" aria-hidden /> Add</Button>
    </fieldset>
  );
}
