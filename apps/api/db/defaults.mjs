// Starting configuration given to every new company. Everything here is data in the database
// afterwards, so each company can change it from settings without a code change.

export const ROLES = [
  { systemKey: 'super_admin', name: 'Super Admin', dataScope: 'all', requiresOffice: false },
  { systemKey: 'admin', name: 'Admin', dataScope: 'team', requiresOffice: true },
  { systemKey: 'counsellor', name: 'Counsellor', dataScope: 'own', requiresOffice: true },
];

// queue: which work queue the status belongs to. followup: ask for a follow-up date on save.
export const LEAD_STATUSES = [
  // Working
  { name: 'New', queue: 'fresh', open: true, followup: false },
  { name: 'Pulled', queue: 'fresh', open: true, followup: false },
  { name: 'Pending', queue: 'followup', open: true, followup: true },
  { name: 'Contacted', queue: 'followup', open: true, followup: true },
  { name: 'Follow-up', queue: 'followup', open: true, followup: true },
  { name: 'Missed Call', queue: 'missed', open: true, followup: false },
  { name: 'Important', queue: 'followup', open: true, followup: true },
  // Admissions
  { name: 'Qualified', queue: 'followup', open: true, followup: true },
  { name: 'Counselled (Prospect)', queue: 'counselled', open: true, followup: true },
  { name: 'Application Fee Paid (Registered)', queue: 'fee_paid', open: true, followup: false },
  { name: 'Admitted', queue: 'closed', open: false, followup: false },
  // Closed
  { name: 'Won', queue: 'closed', open: false, followup: false },
  { name: 'Lost', queue: 'closed', open: false, followup: false },
  { name: 'Not Interested', queue: 'closed', open: false, followup: false },
  { name: 'DNP', queue: 'closed', open: false, followup: false },
  { name: 'Irrelevant', queue: 'closed', open: false, followup: false },
  { name: 'Junk', queue: 'closed', open: false, followup: false },
];

export const LEAD_SOURCES = [
  { name: 'Website', channel: 'website' },
  { name: 'Meta Ads', channel: 'ads' },
  { name: 'Google Ads', channel: 'ads' },
  { name: 'Inbound Call', channel: 'call' },
  { name: 'Walk-in', channel: 'walk_in' },
  { name: 'Referral', channel: 'referral' },
  { name: 'Import', channel: 'import' },
];

// Proposed starting values; the Super Admin changes them in settings.
export const BREAK_TYPES = [
  { name: 'Lunch', minutes: 45 },
  { name: 'Tea', minutes: 15 },
  { name: 'Other', minutes: 15 },
];

export const LEAVE_TYPES = [
  { name: 'Casual Leave', paid: true, quota: 12 },
  { name: 'Sick Leave', paid: true, quota: 6 },
  { name: 'Unpaid Leave', paid: false, quota: 0 },
];

export const ATTENDANCE_SETTINGS = {
  shiftStart: '10:00',
  shiftEnd: '19:00',
  graceMinutes: 10,
  halfDayBelowHours: 4.5,
  idleTimeoutMin: 30,
  weeklyOffDays: [0],
};

export const LEAD_POLICY = { duplicateAction: 'attach', autoAssign: true };


/** Fields of study counsellors choose from. A company adds or renames its own later. */
export const STREAMS = [
  'Engineering', 'Management', 'Medical and Health Sciences', 'Nursing', 'Pharmacy', 'Law', 'Commerce', 'Science', 'Arts and Humanities',
  'Computer Applications', 'Design', 'Education', 'Hotel Management', 'Agriculture', 'Journalism and Mass Communication',
];
