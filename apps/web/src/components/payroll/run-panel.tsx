'use client';

import { CheckCircle2, RefreshCw, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Spinner, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';
import { PayslipModal } from './payslip-modal';
import { errorText, lastMonth, monthName, RunDetail, RunSummary, rupees } from './payroll-types';

/**
 * The monthly payroll: calculate a finished month, look at every payslip and how it came about, adjust
 * what needs it (always with a reason), then approve. Approving locks the month; reopening unlocks it
 * and is recorded.
 */
export function RunPanel() {
  const { can } = useAuth();
  const [month, setMonth] = useState(lastMonth());
  const runs = useApi<RunSummary[]>('/payroll/runs');
  const run = useMemo(() => runs.data?.find((r) => r.month === month) ?? null, [runs.data, month]);
  const detail = useApi<RunDetail>(run ? `/payroll/runs/${run.id}` : null);
  const [open, setOpen] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);

  const reload = (): void => {
    runs.reload();
    detail.reload();
  };

  async function act(what: string, path: string, body?: unknown, okText?: string): Promise<void> {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      if (okText) setNotice(okText);
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (runs.error) return <Notice tone="bad">{runs.error.message}</Notice>;
  if (!runs.data) return <Spinner />;
  const d = detail.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          Month
          <Input type="month" value={month} max={lastMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-40" />
        </label>
        {run && <Badge tone={run.status === 'approved' ? 'ok' : 'warn'}>{run.status === 'approved' ? `Approved${run.approvedBy ? ` by ${run.approvedBy}` : ''}` : 'Draft: not approved yet'}</Badge>}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}

      {!run && (
        <Panel title={`Payroll for ${monthName(month)}`}>
          <Empty title="Not calculated yet">
            <p className="mx-auto max-w-md text-sm text-muted">
              Payroll works out each person&apos;s pay from their salary structure, their attendance, leaves and breaks, under the rules in the Policy tab. Give everyone a structure first.
            </p>
            {can('payroll.manage') ? (
              <Button className="mt-4" loading={busy === 'create'} onClick={() => void act('create', '/payroll/runs', { month }, `Payroll for ${monthName(month)} is calculated. Check it, then approve.`)}>
                Calculate payroll for {monthName(month)}
              </Button>
            ) : <p className="mt-3 text-sm text-muted">The Super Admin calculates it once the month has ended.</p>}
          </Empty>
        </Panel>
      )}

      {run && !d && !detail.error && <Spinner />}
      {detail.error && <Notice tone="bad">{detail.error.message}</Notice>}

      {run && d && (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['People', d.people], ['Total earnings', rupees(d.gross)], ['Total deductions', rupees(d.deductions)], ['Net pay', rupees(d.netPay)]].map(([k, v]) => (
              <li key={k as string} className="glass rounded-xl px-4 py-3"><p className="tabular text-lg font-semibold">{v}</p><p className="text-xs text-muted">{k}</p></li>
            ))}
          </ul>

          {d.missingStructure.length > 0 && (
            <Notice tone="warn">
              {d.missingStructure.length === 1 ? '1 person has' : `${d.missingStructure.length} people have`} no salary structure and {d.missingStructure.length === 1 ? 'is' : 'are'} not in this run:{' '}
              {d.missingStructure.slice(0, 6).map((p) => p.name).join(', ')}{d.missingStructure.length > 6 ? ` and ${d.missingStructure.length - 6} more` : ''}. Add a structure in the Structures tab, then calculate again.
            </Notice>
          )}

          <Panel
            title="Payslips"
            actions={d.status === 'draft' ? (
              <>
                {can('payroll.manage') && (
                  <>
                    <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} /> Also discard adjustments</label>
                    <Button variant="secondary" loading={busy === 'recalculate'} onClick={() => void act('recalculate', `/payroll/runs/${d.id}/recalculate`, { discardAdjustments: discard }, 'Calculated again.')}>
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Calculate again
                    </Button>
                  </>
                )}
                {can('payroll.approve') && (
                  <Button loading={busy === 'approve'} onClick={() => void act('approve', `/payroll/runs/${d.id}/approve`, undefined, 'Approved. People can now see their payslips.')}>
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Approve payroll
                  </Button>
                )}
              </>
            ) : can('payroll.approve') ? <Button variant="secondary" onClick={() => setReopening(true)}><Undo2 className="h-3.5 w-3.5" aria-hidden /> Reopen</Button> : undefined}
            flush
          >
            {d.payslips.length === 0 ? <Empty title="No payslips in your view" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                    <tr><th className="px-4 py-2.5 font-semibold">Person</th><th className="px-3 py-2.5 text-right font-semibold">Present</th><th className="px-3 py-2.5 text-right font-semibold">Absent</th><th className="px-3 py-2.5 text-right font-semibold">Late</th><th className="px-3 py-2.5 text-right font-semibold">Earnings</th><th className="px-3 py-2.5 text-right font-semibold">Deductions</th><th className="px-3 py-2.5 text-right font-semibold">Net pay</th><th className="px-4 py-2.5" /></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.payslips.map((p) => (
                      <tr key={p.id} className="hover:bg-mint-50">
                        <td className="px-4 py-3 font-medium">{p.user.name}{p.adjusted && <Badge tone="warn" className="ml-2">Adjusted</Badge>}<span className="block text-xs font-normal text-muted">{p.user.role}</span></td>
                        <td className="tabular px-3 py-3 text-right">{p.presentDays}</td>
                        <td className="tabular px-3 py-3 text-right">{p.absentDays}</td>
                        <td className="tabular px-3 py-3 text-right">{p.lateCount}</td>
                        <td className="tabular px-3 py-3 text-right">{rupees(p.gross)}</td>
                        <td className="tabular px-3 py-3 text-right">{rupees(p.deductions)}</td>
                        <td className={`tabular px-3 py-3 text-right font-semibold ${p.netPay < 0 ? 'text-bad' : 'text-brand'}`}>{rupees(p.netPay)}</td>
                        <td className="px-4 py-3 text-right"><Button size="sm" variant="secondary" onClick={() => setOpen(p.id)}>Open</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <p className="text-xs text-subtle">
            Calculated {new Date(d.generatedAt).toLocaleString('en-IN')} by {d.generatedBy}{d.reopenedCount > 0 ? `. Reopened ${d.reopenedCount} ${d.reopenedCount === 1 ? 'time' : 'times'}` : ''}.
          </p>
        </>
      )}

      {open && <PayslipModal id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {reopening && run && <ReopenModal onClose={() => setReopening(false)} onDone={() => { setReopening(false); reload(); }} runId={run.id} month={run.month} />}
    </div>
  );
}

function ReopenModal({ runId, month, onClose, onDone }: { runId: string; month: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (reason.trim().length < 3) return setError('Say why, in a few words');
    setBusy(true);
    try {
      await api(`/payroll/runs/${runId}/reopen`, { method: 'POST', body: { reason: reason.trim() } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reopen payroll for ${monthName(month)}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Notice tone="warn">People will stop seeing their payslips for this month until it is approved again. The reopening is written to the audit log with your reason.</Notice>
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Reason" htmlFor="reopen-why" required><Textarea id="reopen-why" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Reopen payroll</Button></div>
      </form>
    </Modal>
  );
}
