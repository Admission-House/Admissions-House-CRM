import { useState } from 'react';
import { ApiError } from '@/core/api';
import { sharePdf } from '@/core/share-file';

/** The payslip PDF of one salary record: downloads it and opens the share sheet. */
export function usePayslip(salaryId: string, month: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      await sharePdf(`/salaries/${salaryId}/payslip.pdf`, `payslip-${month.slice(0, 7)}.pdf`, 'Payslip');
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not open the payslip. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, open };
}
