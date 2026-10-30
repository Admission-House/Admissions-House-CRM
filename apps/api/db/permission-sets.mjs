// Starting permissions of the three standard roles, from the SRS permission summary (Appendix B).
// What a role can see (all / team / own) is the role's data_scope, not a permission.
// A company can change any role afterwards; these are only the starting point.

// Super Admin gets every permission in the master list.
export const SUPER_ADMIN = 'ALL';

export const ADMIN = [
  'lead.read', 'lead.create', 'lead.update', 'lead.assign',
  'followup.manage', 'document.manage', 'shortlist.manage',
  'call.place', 'call.read', 'call.listen', 'dialer.use',
  'master.read', 'master.create', 'master.review',
  'user.read', 'branch.read', 'device.approve',
  'attendance.self', 'attendance.read', 'attendance.exception',
  'leave.request', 'leave.read', 'leave.approve',
  'salary.read_own', 'salary.read', 'salary.write', 'salary.import',
  'dashboard.read', 'report.read',
];

export const COUNSELLOR = [
  'lead.read', 'lead.create', 'lead.update',
  'followup.manage', 'document.manage', 'shortlist.manage',
  'call.place', 'call.read', 'call.listen', 'dialer.use',
  'master.read', 'master.create',
  'attendance.self', 'leave.request',
  'salary.read_own',
  'dashboard.read', 'report.read',
];
