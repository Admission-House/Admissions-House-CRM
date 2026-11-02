import type { AppNotification } from './types';

const REFUSED_REASON: Record<string, string> = {
  network: 'wrong network', gps_missing: 'no location', gps_mocked: 'fake location', gps_inaccurate: 'location not exact', gps_far: 'too far from the office', not_configured: 'office not set up',
};

/** One line of text for each kind of notification the API sends (same wording as the web CRM). */
export function describeNotification(n: AppNotification): { title: string; detail?: string; leadId?: string; screen?: '/leave' } {
  const p = n.payload;
  const leadId = typeof p.leadId === 'string' ? p.leadId : undefined;
  const name = typeof p.name === 'string' ? p.name : 'a lead';
  switch (p.event) {
    case 'lead_assigned': return { title: `New lead assigned: ${name}`, detail: typeof p.source === 'string' ? `From ${p.source}` : undefined, leadId };
    case 'lead_unassigned': return { title: `Nobody was available for ${name}`, detail: 'It is waiting in the unassigned pool', leadId };
    case 'resource_download': return { title: `${name} asked to download: ${String(p.resource ?? 'a resource')}`, detail: typeof p.phone === 'string' ? p.phone : undefined, leadId };
    case 'repeat_enquiry': return { title: `${name} enquired again`, leadId };
    case 'followup_due': return { title: `Follow-up due: ${name}`, detail: typeof p.note === 'string' ? p.note : undefined, leadId };
    case 'missed_call': return { title: `Missed call from ${name}`, leadId };
    case 'import_finished': return { title: `Import finished: ${String(p.fileName ?? '')}`, detail: `${String(p.created ?? 0)} new, ${String(p.attached ?? 0)} repeats, ${String(p.failed ?? 0)} failed` };
    case 'leads_imported': return { title: `${String(p.count ?? 0)} leads were added for you`, detail: typeof p.fileName === 'string' ? p.fileName : undefined };
    case 'leads_assigned': return { title: `${String(p.count ?? 0)} leads were given to you`, detail: typeof p.by === 'string' ? `By ${p.by}` : undefined };
    case 'leave_requested': return { title: `${String(p.userName ?? 'Someone')} asked for leave`, detail: `${String(p.leaveType ?? '')}, ${String(p.fromDate ?? '')}${p.toDate && p.toDate !== p.fromDate ? ` to ${String(p.toDate)}` : ''}`, screen: '/leave' };
    case 'leave_decided': return { title: `Your leave was ${p.decision === 'approved' ? 'approved' : 'turned down'}`, detail: [typeof p.decidedBy === 'string' ? `By ${p.decidedBy}` : '', typeof p.note === 'string' ? p.note : ''].filter(Boolean).join('. ') || undefined, screen: '/leave' };
    case 'idle_logout': return { title: `${String(p.userName ?? 'Someone')} was signed out for inactivity`, detail: `No activity for ${String(p.idleMinutes ?? 30)} minutes` };
    case 'login_refused': return { title: `${String(p.userName ?? 'Someone')} was refused at sign-in`, detail: `Not at the office (${REFUSED_REASON[String(p.reason)] ?? String(p.reason ?? 'outside the office')})` };
    case 'forced_logout': return { title: `${String(p.userName ?? 'Someone')} was signed out by an admin` };
    case 'attendance_exception': return { title: `Attendance marked by hand for ${String(p.userName ?? 'someone')}`, detail: [typeof p.date === 'string' ? p.date : '', typeof p.reason === 'string' ? p.reason : ''].filter(Boolean).join(': ') || undefined };
    case 'download': return { title: `${String(p.userName ?? 'Someone')} downloaded ${String(p.what ?? 'a file')}`, detail: typeof p.fileName === 'string' ? p.fileName : undefined };
    default: return { title: n.type.replace(/_/g, ' ') };
  }
}
