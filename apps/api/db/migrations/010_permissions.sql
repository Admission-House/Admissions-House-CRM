-- Master list of permission codes, shared by every company. A role is a set of these codes.
-- Which rows a person can see (all, their team, or their own) comes from the role's data_scope,
-- so the codes below only say what a person may do, not whose data it applies to.

INSERT INTO permissions (code, module, description) VALUES
  -- Leads
  ('lead.read',         'leads', 'View leads and their profile'),
  ('lead.create',       'leads', 'Add a lead by hand'),
  ('lead.update',       'leads', 'Edit lead details, status and profile'),
  ('lead.delete',       'leads', 'Delete a lead (soft delete)'),
  ('lead.assign',       'leads', 'Assign or reassign leads to counsellors'),
  ('lead.import',       'leads', 'Import leads from a file'),
  ('lead.export',       'leads', 'Export leads to a file'),
  ('followup.manage',   'leads', 'Create and complete follow-ups'),
  ('document.manage',   'leads', 'Upload and remove lead documents'),
  ('shortlist.manage',  'leads', 'Recommend and shortlist colleges, record NI / DNP and payments'),

  -- Calling
  ('call.place',        'calling', 'Place calls from the CRM'),
  ('call.read',         'calling', 'View call history'),
  ('call.listen',       'calling', 'Listen to call recordings'),
  ('dialer.use',        'calling', 'Use the auto-dialer'),

  -- Colleges and courses
  ('master.read',       'masters', 'View colleges, courses and fees'),
  ('master.create',     'masters', 'Add a college by hand (waits for review)'),
  ('master.manage',     'masters', 'Create and edit colleges, courses and fees'),
  ('master.review',     'masters', 'Approve colleges added by counsellors'),

  -- People and organisation
  ('user.read',         'people', 'View users'),
  ('user.manage',       'people', 'Create and edit users, reset passwords, deactivate'),
  ('role.manage',       'people', 'Create and edit roles and their permissions'),
  ('branch.read',       'people', 'View branches'),
  ('branch.manage',     'people', 'Edit branches, networks and office location'),
  ('device.approve',    'people', 'Approve a new mobile device'),
  ('session.manage',    'people', 'View and end other people''s sessions'),

  -- Attendance and leave
  ('attendance.self',      'attendance', 'Check in, check out and take breaks'),
  ('attendance.read',      'attendance', 'View attendance of people in scope'),
  ('attendance.exception', 'attendance', 'Mark attendance by exception with a reason'),
  ('attendance.settings',  'attendance', 'Change shift, grace, break and idle-logout settings'),
  ('leave.request',        'attendance', 'Apply for leave'),
  ('leave.read',           'attendance', 'View leave requests of people in scope'),
  ('leave.approve',        'attendance', 'Approve or reject leave'),
  ('leave.settings',       'attendance', 'Manage leave types, quotas and holidays'),

  -- Salary
  ('salary.read_own',   'salary', 'View own salary and payslips'),
  ('salary.read',       'salary', 'View salary records of people in scope'),
  ('salary.write',      'salary', 'Enter and edit salary records'),
  ('salary.import',     'salary', 'Upload salaries in bulk'),

  -- Reports
  ('dashboard.read',    'reports', 'View the dashboard'),
  ('report.read',       'reports', 'View reports'),
  ('report.export',     'reports', 'Export reports'),

  -- Settings
  ('settings.manage',    'settings', 'Manage statuses, sources, custom fields and assignment rules'),
  ('integration.manage', 'settings', 'Manage API keys, webhooks and telephony'),
  ('audit.read',         'settings', 'View the audit log');
