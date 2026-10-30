import { Building2, KeyRound, ListChecks, Laptop, Palette, Phone, ScrollText, ShieldCheck, Smartphone, Users, type LucideIcon } from 'lucide-react';

export interface SettingsItem {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  /** Shown when the person has any of these permissions. */
  any: string[];
}

export interface SettingsGroup {
  title: string;
  items: SettingsItem[];
}

/** The pages of the admin area. A page is listed once it exists, and shown only to people whose role allows it. */
export const SETTINGS: SettingsGroup[] = [
  {
    title: 'People and access',
    items: [
      { label: 'Company and logo', href: '/settings/company', icon: Palette, description: 'Name, logo and colours of your CRM', any: ['settings.manage'] },
      { label: 'Users', href: '/settings/users', icon: Users, description: 'Add people, change their role or team, and reset passwords', any: ['user.read', 'user.manage'] },
      { label: 'Roles', href: '/settings/roles', icon: ShieldCheck, description: 'What each role can see and do', any: ['role.manage'] },
      { label: 'Branches', href: '/settings/branches', icon: Building2, description: 'Office location and networks used for the office sign-in check', any: ['branch.read', 'branch.manage'] },
      { label: 'Lead settings', href: '/settings/leads', icon: ListChecks, description: 'Statuses, sources, extra fields, how new leads are given out, and repeat enquiries', any: ['settings.manage'] },
      { label: 'Integrations', href: '/settings/integrations', icon: KeyRound, description: 'API keys for your website and forms, and the leads they sent', any: ['integration.manage'] },
      { label: 'Telephony', href: '/settings/telephony', icon: Phone, description: 'Connect your calling provider', any: ['integration.manage'] },
      { label: 'Sign-ins', href: '/settings/sessions', icon: Laptop, description: 'Where people are signed in, and sign them out', any: ['user.manage'] },
      { label: 'Audit log', href: '/settings/audit', icon: ScrollText, description: 'Who changed what, and when', any: ['audit.read'] },
      { label: 'Mobile devices', href: '/settings/devices', icon: Smartphone, description: 'Approve or remove phones that can sign in', any: ['device.approve'] },
    ],
  },
];

const BUILT = new Set(['/settings/users', '/settings/roles', '/settings/branches', '/settings/leads', '/settings/devices', '/settings/integrations', '/settings/telephony', '/settings/sessions', '/settings/audit', '/settings/company']);
export const SETTINGS_BUILT = SETTINGS.map((g) => ({ ...g, items: g.items.filter((i) => BUILT.has(i.href)) })).filter((g) => g.items.length > 0);

