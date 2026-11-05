/** Page text lives here, away from the layout, so the wording can change without touching a component. */
export interface Feature {
  title: string;
  text: string;
}

export const FEATURE_GROUPS: { heading: string; intro: string; items: Feature[] }[] = [
  {
    heading: 'Leads',
    intro: 'Every enquiry lands in one place and reaches the right counsellor.',
    items: [
      { title: 'One inbox for every source', text: 'Website forms, Meta and Google ads, calls and uploaded sheets all create leads automatically, with duplicates caught.' },
      { title: 'Automatic assignment', text: 'Rules by source, course or city share leads between counsellors fairly.' },
      { title: 'Queues and statuses', text: 'New, follow-up, missed call and your own statuses, each with a live count.' },
      { title: 'Student profile', text: 'Course, city, budget, shortlisted colleges, documents and payment on one screen.' },
      { title: 'Import and export', text: 'Bring leads in from CSV or Excel with a preview, and get a problems file for rows that need fixing.' },
    ],
  },
  {
    heading: 'Calling',
    intro: 'Call from the CRM and never lose a conversation.',
    items: [
      { title: 'Click to call', text: 'Dial from the lead page. The call, its length and the recording are saved against the lead.' },
      { title: 'Missed calls become leads', text: 'A missed call from a new number creates a lead for follow-up.' },
      { title: 'Auto dialer', text: 'Work a queue one lead after another, with a short after-call form each time.' },
      { title: 'Follow-up reminders', text: 'Set the next call once and get a reminder, with a calendar view for the team.' },
    ],
  },
  {
    heading: 'Your team',
    intro: 'See who is working, and pay them correctly.',
    items: [
      { title: 'Attendance', text: 'Sign-in from the office with a location and network check, breaks, and a day-by-day matrix.' },
      { title: 'Leave and holidays', text: 'Request, approve and track leave types and company holidays.' },
      { title: 'Payroll', text: 'Salary structures, a monthly run from attendance and leave, approval, and payslip PDFs.' },
      { title: 'Roles and branches', text: 'Decide what each role can see and do, and keep branches separate.' },
    ],
  },
  {
    heading: 'Control and safety',
    intro: 'Built so that one mistake or one bad actor cannot hurt the company.',
    items: [
      { title: 'Two-step sign-in', text: 'Optional or required for admins, with recovery codes.' },
      { title: 'Audit log', text: 'Who changed what and when, kept for Super Admins to review.' },
      { title: 'Live updates', text: 'Notifications and counts update on screen without refreshing.' },
      { title: 'Reports', text: 'Leads, calls, attendance and conversions, with CSV and Excel download.' },
    ],
  },
];

export const HIGHLIGHTS: Feature[] = [
  { title: 'Never lose a lead', text: 'Website, ads and calls all feed one list, and every lead has an owner.' },
  { title: 'Calls inside the CRM', text: 'Call, record and log the outcome without leaving the lead.' },
  { title: 'Team and payroll included', text: 'Attendance, leave and salary sit beside the leads, not in another tool.' },
];

export const STEPS: Feature[] = [
  { title: 'Tell us about your team', text: 'A short call to understand your sources, courses and roles.' },
  { title: 'We set it up', text: 'Your company, branches, statuses and logins, ready before you start.' },
  { title: 'Your team starts working', text: 'Leads begin arriving and counsellors start calling the same day.' },
];
