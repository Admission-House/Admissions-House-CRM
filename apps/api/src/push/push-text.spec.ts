import { pushText } from './push-text.js';

describe('pushText', () => {
  it('words a lead alert and sends the lead along so the app can open it', () => {
    expect(pushText({ event: 'followup_due', name: 'Riya Sharma', leadId: 'lead-1', note: 'Ask about fees' })).toEqual({
      title: 'Follow-up due: Riya Sharma', body: 'Ask about fees', data: { leadId: 'lead-1' },
    });
    expect(pushText({ event: 'lead_assigned', name: 'Aman', leadId: 'l2', source: 'Google Ads' })).toMatchObject({ title: 'New lead assigned: Aman', body: 'From Google Ads', data: { leadId: 'l2' } });
    expect(pushText({ event: 'missed_call', name: 'Kabir', leadId: 'l3' })).toEqual({ title: 'Missed call from Kabir', data: { leadId: 'l3' } });
  });

  it('has no body when there is nothing to add, rather than the word "undefined"', () => {
    const t = pushText({ event: 'followup_due', name: 'Riya', leadId: 'l1' })!;
    expect(t.body).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain('undefined');
    expect(pushText({ event: 'lead_assigned', name: 'Aman', leadId: 'l2' })!.body).toBeUndefined();
  });

  it('falls back to plain words when the name is missing', () => {
    expect(pushText({ event: 'repeat_enquiry' })!.title).toBe('a lead enquired again');
    expect(pushText({ event: 'leave_requested', fromDate: '2026-11-10' })!.title).toBe('Someone asked for leave');
  });

  it('opens the leave screen for leave alerts, and words the decision both ways', () => {
    expect(pushText({ event: 'leave_decided', decision: 'approved', decidedBy: 'Asha', note: 'Enjoy' })).toEqual({ title: 'Your leave was approved', body: 'By Asha. Enjoy', data: { screen: 'leave' } });
    expect(pushText({ event: 'leave_decided', decision: 'rejected' })!.title).toBe('Your leave was turned down');
    expect(pushText({ event: 'leave_requested', userName: 'Neha', leaveType: 'Casual', fromDate: '2026-11-10', toDate: '2026-11-12' })).toEqual({
      title: 'Neha asked for leave', body: 'Casual, 2026-11-10 to 2026-11-12', data: { screen: 'leave' },
    });
    expect(pushText({ event: 'leave_requested', userName: 'Neha', leaveType: 'Casual', fromDate: '2026-11-10', toDate: '2026-11-10' })!.body).toBe('Casual, 2026-11-10');
  });

  it('words security alerts, naming the reason a sign-in was refused', () => {
    expect(pushText({ event: 'login_refused', userName: 'Ravi', reason: 'gps_far' })).toEqual({ title: 'Ravi was refused at sign-in', body: 'Not at the office (too far from the office)', data: {} });
    expect(pushText({ event: 'login_refused', userName: 'Ravi', reason: 'device_rooted' })).toEqual({ title: 'Ravi was refused at sign-in', body: 'This phone is rooted or jailbroken', data: {} });
    expect(pushText({ event: 'forced_logout', userName: 'Ravi' })!.title).toBe('Ravi was signed out by an admin');
  });

  it('does not send noisy events to phones, or events it does not know', () => {
    for (const event of ['download', 'idle_logout', 'import_finished', 'something_new']) expect(pushText({ event })).toBeNull();
    expect(pushText({})).toBeNull();
  });

  it('never carries anything but strings in the data a phone receives', () => {
    const t = pushText({ event: 'followup_due', name: 'X', leadId: 42 as unknown as string })!;
    expect(t.data).toEqual({});
  });

  it('words calls and meetings, in the same words as the bell', () => {
    expect(pushText({ event: 'comm_incoming', kind: 'voice', fromName: 'Anita', leadName: 'Riya Sharma', leadId: 'l1' })).toEqual({
      title: 'Incoming voice call from Anita', body: 'About Riya Sharma', data: { screen: 'communications', leadId: 'l1' },
    });
    expect(pushText({ event: 'comm_incoming', kind: 'video', fromName: 'Anita' })!.title).toBe('Incoming video call from Anita');
    expect(pushText({ event: 'comm_missed', kind: 'video', fromName: 'Anita' })!.title).toBe('Missed video call from Anita');
    expect(pushText({ event: 'comm_declined', fromName: 'Rahul' })!.title).toBe('Rahul turned down your call');
    expect(pushText({ event: 'comm_meeting_invite', title: 'Drive review', fromName: 'Anita', scheduledFor: '2026-11-20T10:00:00Z' })).toMatchObject({ title: 'Meeting invitation: Drive review', body: 'From Anita, 2026-11-20T10:00:00Z' });
    expect(pushText({ event: 'comm_meeting_reminder', title: 'Drive review' })!.title).toBe('Meeting soon: Drive review');
    expect(pushText({ event: 'comm_meeting_started', title: 'Drive review', fromName: 'Anita' })).toMatchObject({ title: 'Drive review has started', body: 'Hosted by Anita' });
    expect(pushText({ event: 'comm_ended', title: 'Drive review', cancelled: true })!.title).toBe('Drive review was cancelled');
    expect(JSON.stringify(pushText({ event: 'comm_meeting_invite' }))).not.toContain('undefined');
  });
});
