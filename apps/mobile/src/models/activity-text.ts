import { fmtDateTime } from '@/core/format';
import type { Activity } from '@/models/types';

/** Names for the student-profile details the history records, so nobody reads "profile.preferred_stream_id". */
const FIELD_LABEL: Record<string, string> = {
  'profile.alternate_email': 'Alternate email',
  'profile.date_of_birth': 'Date of birth',
  'profile.gender': 'Gender',
  'profile.category': 'Category',
  'profile.current_location_id': 'Current city',
  'profile.preferred_year': 'Preferred year',
  'profile.preferred_level': 'Level',
  'profile.preferred_stream_id': 'Stream',
  'profile.budget_min': 'Budget from',
  'profile.budget_max': 'Budget up to',
  'profile.loan_required': 'Loan required',
  'profile.extra_phones': 'Extra phone numbers',
  'profile.preferred_locations': 'Preferred places',
  'profile.guardians': 'Parent or guardian details',
  'profile.education': 'Academic details',
  'profile.exams': 'Exam scores',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value fit to show: ids are hidden, and yes/no values are written as words. */
function shown(v: string | null): string | null {
  if (v === null || v === '' || UUID.test(v)) return null;
  if (v === 'true') return 'Yes';
  if (v === 'false') return 'No';
  return v;
}

/** One line of plain words for a history entry. */
export function describeActivity(a: Activity): string {
  switch (a.type) {
    case 'status_change':
      return `Status changed${a.oldValue ? ` from ${a.oldValue}` : ''}${a.newValue ? ` to ${a.newValue}` : ''}`;
    case 'followup':
      return a.newValue ? `Follow-up set for ${fmtDateTime(a.newValue)}` : 'Follow-up updated';
    case 'field_change': {
      const label = (a.field && FIELD_LABEL[a.field]) ?? a.field ?? 'A detail';
      const from = shown(a.oldValue);
      const to = shown(a.newValue);
      return `${label} ${a.remark === 'Updated' ? 'updated' : 'changed'}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`;
    }
    case 'document':
      return `${a.remark ?? 'Document'}: ${a.field ?? ''} ${a.newValue ?? a.oldValue ?? ''}`.trim();
    case 'shortlist':
      return a.remark ?? 'College shortlist updated';
    default:
      return a.remark ?? a.type;
  }
}
