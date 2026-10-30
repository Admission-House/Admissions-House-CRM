import {
  BarChart3, CalendarCheck, CalendarClock, CheckCircle2, Clock3, FileSpreadsheet, LayoutDashboard, PhoneCall, PhoneMissed, Settings, Sparkles, Users, Wallet,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  /** A group has no address of its own; it opens to show its children. */
  href?: string;
  icon: LucideIcon;
  /** The item shows when the person has any of these permissions. */
  any: string[];
  /** Which count from /leads/queues to show beside it. */
  count?: 'total' | 'fresh' | 'missed' | 'followup' | 'counselled' | 'fee_paid';
  children?: NavItem[];
}

/**
 * The menu. Lead queues sit under "Leads" as a drop-down, the way the team works: fresh leads, missed
 * leads, follow-up (call-backs), counselled leads (prospects) and application fee paid
 * (registrations). What each person sees is decided by the permissions the API gives them, so a new
 * role needs no change here. An entry appears only once its screen exists.
 */
const ALL: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, any: ['dashboard.read'] },
  {
    label: 'Leads',
    icon: Users,
    any: ['lead.read'],
    children: [
      { label: 'Fresh leads', href: '/leads?queue=fresh', icon: Sparkles, any: ['lead.read'], count: 'fresh' },
      { label: 'Missed leads', href: '/leads?queue=missed', icon: PhoneMissed, any: ['lead.read'], count: 'missed' },
      { label: 'Follow-up leads', href: '/leads?queue=followup', icon: CalendarClock, any: ['lead.read'], count: 'followup' },
      { label: 'Counselled leads', href: '/leads?queue=counselled', icon: Clock3, any: ['lead.read'], count: 'counselled' },
      { label: 'Application fee paid', href: '/leads?queue=fee_paid', icon: CheckCircle2, any: ['lead.read'], count: 'fee_paid' },
      { label: 'All leads', href: '/leads', icon: Users, any: ['lead.read'], count: 'total' },
    ],
  },
  { label: 'Follow-ups', href: '/followups', icon: CalendarClock, any: ['followup.manage'] },
  {
    label: 'Calling',
    icon: PhoneCall,
    any: ['call.read', 'call.place'],
    children: [
      { label: 'Call history', href: '/calls', icon: PhoneCall, any: ['call.read'] },
      { label: 'Auto dialer', href: '/dialer', icon: PhoneCall, any: ['dialer.use'] },
    ],
  },
  {
    label: 'People',
    icon: CalendarCheck,
    any: ['attendance.self', 'attendance.read', 'leave.request', 'leave.read', 'leave.settings', 'salary.read', 'salary.read_own'],
    children: [
      { label: 'Attendance', href: '/attendance', icon: CalendarCheck, any: ['attendance.self', 'attendance.read'] },
      { label: 'Leave', href: '/leave', icon: CalendarCheck, any: ['leave.request', 'leave.read', 'leave.settings'] },
      { label: 'Salary', href: '/salary', icon: Wallet, any: ['salary.read', 'salary.read_own'] },
    ],
  },
  { label: 'Reports', href: '/reports', icon: BarChart3, any: ['report.read'] },
  { label: 'Import and export', href: '/imports', icon: FileSpreadsheet, any: ['lead.import', 'lead.export', 'master.manage'] },
  {
    label: 'Settings',
    icon: Settings,
    any: ['settings.manage', 'user.read', 'user.manage', 'role.manage', 'branch.read', 'device.approve', 'integration.manage', 'audit.read'],
    children: [
      { label: 'Company and logo', href: '/settings/company', icon: Settings, any: ['settings.manage'] },
      { label: 'Users', href: '/settings/users', icon: Users, any: ['user.read', 'user.manage'] },
      { label: 'Roles', href: '/settings/roles', icon: Settings, any: ['role.manage'] },
      { label: 'Branches', href: '/settings/branches', icon: Settings, any: ['branch.read', 'branch.manage'] },
      { label: 'Lead settings', href: '/settings/leads', icon: Settings, any: ['settings.manage'] },
      { label: 'Integrations', href: '/settings/integrations', icon: Settings, any: ['integration.manage'] },
      { label: 'Telephony', href: '/settings/telephony', icon: Settings, any: ['integration.manage'] },
      { label: 'Sign-ins', href: '/settings/sessions', icon: Settings, any: ['user.manage'] },
      { label: 'Audit log', href: '/settings/audit', icon: Settings, any: ['audit.read'] },
      { label: 'Mobile devices', href: '/settings/devices', icon: Settings, any: ['device.approve'] },
    ],
  },
];

/** Screens that exist so far (the part of the address before "?"). */
const BUILT = new Set(['/dashboard', '/imports', '/settings/integrations', '/settings/telephony', '/settings/sessions', '/settings/audit', '/settings/company', '/account', '/notifications', '/settings/devices', '/salary', '/leave', '/attendance', '/reports', '/calls', '/dialer', '/followups', '/leads', '/settings/users', '/settings/roles', '/settings/branches', '/settings/leads']);

const built = (href?: string) => !!href && BUILT.has(href.split('?')[0]!);

export const NAV: NavItem[] = ALL.map((item) => (item.children ? { ...item, children: item.children.filter((c) => built(c.href)) } : item)).filter((item) =>
  item.children ? item.children.length > 0 : built(item.href),
);
