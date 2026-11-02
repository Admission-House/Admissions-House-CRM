/**
 * What a phone alert says. The wording matches the in-app notification list (the web CRM and the
 * mobile app both word them the same way), so a person sees one story in both places.
 *
 * Only events worth interrupting someone for are sent as alerts. "A file was downloaded" and "someone
 * was signed out for inactivity" stay in the bell: they would be noise on a phone.
 */
export interface PushText {
  title: string;
  body?: string;
  /** What the app opens when the alert is tapped. Values are strings because the phone carries them as such. */
  data: { leadId?: string; screen?: string };
}

const REFUSED_REASON: Record<string, string> = {
  network: 'wrong network', gps_missing: 'no location', gps_mocked: 'fake location', gps_inaccurate: 'location not exact', gps_far: 'too far from the office', not_configured: 'office not set up',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const text = (v: unknown, fallback: string): string => str(v) ?? fallback;
const num = (v: unknown): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : '0');

/** The alert for a notification, or null when it is not one that goes to phones. */
export function pushText(payload: Record<string, unknown>): PushText | null {
  const leadId = str(payload.leadId);
  const lead = leadId ? { leadId } : {};
  const name = text(payload.name, 'a lead');
  const who = text(payload.userName, 'Someone');

  switch (payload.event) {
    case 'lead_assigned':
      return { title: `New lead assigned: ${name}`, body: str(payload.source) && `From ${str(payload.source)}`, data: lead };
    case 'lead_unassigned':
      return { title: `Nobody was available for ${name}`, body: 'It is waiting in the unassigned pool', data: lead };
    case 'resource_download':
      return { title: `${name} asked to download: ${text(payload.resource, 'a resource')}`, body: str(payload.phone), data: lead };
    case 'repeat_enquiry':
      return { title: `${name} enquired again`, data: lead };
    case 'followup_due':
      return { title: `Follow-up due: ${name}`, body: str(payload.note), data: lead };
    case 'missed_call':
      return { title: `Missed call from ${name}`, data: lead };
    case 'leads_imported':
      return { title: `${num(payload.count)} leads were added for you`, body: str(payload.fileName), data: {} };
    case 'leads_assigned':
      return { title: `${num(payload.count)} leads were given to you`, body: str(payload.by) && `By ${str(payload.by)}`, data: {} };
    case 'leave_requested': {
      const to = str(payload.toDate);
      const range = `${text(payload.leaveType, 'Leave')}, ${text(payload.fromDate, '')}${to && to !== payload.fromDate ? ` to ${to}` : ''}`;
      return { title: `${who} asked for leave`, body: range, data: { screen: 'leave' } };
    }
    case 'leave_decided':
      return {
        title: `Your leave was ${payload.decision === 'approved' ? 'approved' : 'turned down'}`,
        body: [str(payload.decidedBy) && `By ${str(payload.decidedBy)}`, str(payload.note)].filter(Boolean).join('. ') || undefined,
        data: { screen: 'leave' },
      };
    case 'login_refused':
      return { title: `${who} was refused at sign-in`, body: payload.reason === 'device_rooted' ? 'This phone is rooted or jailbroken' : `Not at the office (${REFUSED_REASON[String(payload.reason)] ?? text(payload.reason, 'outside the office')})`, data: {} };
    case 'forced_logout':
      return { title: `${who} was signed out by an admin`, data: {} };
    case 'attendance_exception':
      return { title: `Attendance marked by hand for ${text(payload.userName, 'someone')}`, body: [str(payload.date), str(payload.reason)].filter(Boolean).join(': ') || undefined, data: {} };
    default:
      return null;
  }
}
