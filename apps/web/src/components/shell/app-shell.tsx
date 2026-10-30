'use client';

import { ChevronDown, ChevronsLeft, ChevronsRight, KeyRound, LogOut, Menu, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Avatar, Spinner, cx } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { NAV, type NavItem } from '@/lib/nav';
import { themeStyle } from '@/lib/brand-theme';
import { CompanyLogo } from '@/components/company-logo';
import { SidebarSearch } from './sidebar-search';
import { NotificationBell } from './notifications';
import { WorkStatus } from './work-status';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '';
const COLLAPSE_KEY = 'ah.sidebar';

/** Whether the person chose the narrow, icons-only menu on this device. */
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'narrow';
  } catch {
    return false;
  }
};
const subscribeCollapsed = (onChange: () => void) => {
  window.addEventListener('ah-sidebar', onChange);
  return () => window.removeEventListener('ah-sidebar', onChange);
};
const setCollapsed = (narrow: boolean) => {
  try {
    localStorage.setItem(COLLAPSE_KEY, narrow ? 'narrow' : 'wide');
  } catch {
    /* only a convenience */
  }
  window.dispatchEvent(new Event('ah-sidebar'));
};

function NavLink({ item, active, narrow, nested, onNavigate }: { item: NavItem; active: boolean; narrow: boolean; nested?: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={item.href!}
      onClick={onNavigate}
      title={narrow ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'group flex items-center rounded-lg text-[15px] font-medium transition-colors',
        nested ? 'h-10 gap-3 pl-[2.625rem] pr-3' : 'h-10 gap-3 px-3',
        narrow && 'justify-center px-0',
        active ? 'bg-white/14 text-white shadow-[inset_3px_0_0_var(--color-teal)]' : 'text-mint/80 hover:bg-white/8 hover:text-white',
      )}
    >
      {!nested && <item.icon className={cx('h-[18px] w-[18px] shrink-0', active ? 'text-teal' : 'text-mint/65 group-hover:text-mint')} aria-hidden />}
      {!narrow && <span className="flex-1 truncate">{item.label}</span>}
    </Link>
  );
}

function Sidebar({ narrow, onNavigate, onToggle }: { narrow: boolean; onNavigate?: () => void; onToggle?: () => void }) {
  const { me, canAny } = useAuth();
  const path = usePathname();
  const params = useSearchParams();
  const current = `${path}${params.get('queue') ? `?queue=${params.get('queue')}` : ''}`;
  // Only one group is open at a time. What the person picked holds until they go to another page, then the group holding that page opens.
  const [pick, setPick] = useState<{ at: string; label: string | null } | null>(null);
  const picked = pick && pick.at === current ? pick : null;
  const isActive = (href: string) => (href.includes('?') ? current === href : path === href && !params.get('queue'));

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-brand text-white">
      <div className={cx('flex h-16 shrink-0 items-center border-b border-white/10', narrow ? 'justify-center' : 'justify-between pl-5 pr-3')}>
        {!narrow && <p className="truncate text-[17px] font-bold tracking-tight">{me?.company.name}</p>}
        {onToggle && (
          <button onClick={onToggle} aria-label={narrow ? 'Expand menu' : 'Collapse menu'} className="grid h-8 w-8 place-items-center rounded-md text-mint/70 hover:bg-white/10 hover:text-white">
            {narrow ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      <div className={cx('shrink-0 pt-4', narrow ? 'px-2.5' : 'px-4')}>
        <SidebarSearch narrow={narrow} onExpand={() => onToggle?.()} onNavigate={onNavigate} />
      </div>

      <div className={cx('flex-1 overflow-y-auto py-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', narrow ? 'px-2.5' : 'px-3')}>
        {!narrow && <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-[0.1em] text-mint/50">Navigation</p>}
        <ul className="space-y-1">
          {NAV.filter((i) => canAny(...i.any)).map((item) => {
            if (!item.children) return <li key={item.label}><NavLink item={item} active={isActive(item.href!)} narrow={narrow} onNavigate={onNavigate} /></li>;

            const kids = item.children.filter((c) => canAny(...c.any));
            if (kids.length === 0) return null;
            const holdsCurrent = kids.some((c) => isActive(c.href!));
            const open = picked ? picked.label === item.label : holdsCurrent;

            if (narrow) {
              return (
                <li key={item.label}>
                  <Link href={kids[0]!.href!} onClick={onNavigate} title={item.label} className={cx('grid h-10 place-items-center rounded-lg transition-colors', holdsCurrent ? 'bg-white/14 shadow-[inset_3px_0_0_var(--color-teal)]' : 'hover:bg-white/8')}>
                    <item.icon className={cx('h-[18px] w-[18px]', holdsCurrent ? 'text-teal' : 'text-mint/65')} aria-hidden />
                  </Link>
                </li>
              );
            }
            return (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => setPick({ at: current, label: open ? null : item.label })}
                  aria-expanded={open}
                  className={cx('group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[15px] font-medium transition-colors', holdsCurrent && !open ? 'bg-white/10 text-white' : 'text-mint/80 hover:bg-white/8 hover:text-white')}
                >
                  <item.icon className={cx('h-[18px] w-[18px] shrink-0', holdsCurrent ? 'text-teal' : 'text-mint/65 group-hover:text-mint')} aria-hidden />
                  <span className="flex-1 truncate text-left">{item.label}</span>
                  <ChevronDown className={cx('h-4 w-4 shrink-0 text-mint/60 transition-transform', open && 'rotate-180')} aria-hidden />
                </button>
                {open && (
                  <ul className="mt-1 space-y-1">
                    {kids.map((c) => <li key={c.href}><NavLink item={c} nested active={isActive(c.href!)} narrow={false} onNavigate={onNavigate} /></li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/** The date and time, kept right to the minute. */
function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <span className="h-4 w-40" />;
  const d = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const t = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  return <span className="tabular hidden text-sm text-muted md:block">{d} {t}</span>;
}

function UserMenu() {
  const { me, logout } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!me) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 hover:bg-head">
        <Avatar name={me.user.name} size={34} />
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-[15px] font-semibold text-ink">{me.user.name}</span>
          <span className="block text-xs capitalize text-muted">{me.user.role.key?.replace(/_/g, ' ')}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-subtle" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-sm font-semibold">{me.user.name}</p>
            <p className="truncate text-xs text-muted">{me.user.email}</p>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); router.push('/account'); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-head">
            <UserRound className="h-4 w-4 text-muted" aria-hidden /> My account
          </button>
          <button type="button" role="menuitem" onClick={() => router.push('/change-password')} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-head">
            <KeyRound className="h-4 w-4 text-muted" aria-hidden /> Change password
          </button>
          <button type="button" role="menuitem" onClick={() => void logout().then(() => router.replace('/login'))} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-bad hover:bg-bad-50">
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The frame around every signed-in screen. Sends people who are not signed in (or must change their password) elsewhere. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, me } = useAuth();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const narrow = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
    else if (status === 'authenticated' && me?.user.mustChangePassword) router.replace('/change-password');
  }, [status, me, router]);

  if (status !== 'authenticated' || !me || me.user.mustChangePassword) {
    return <div className="grid min-h-dvh place-items-center"><Spinner label="Opening your workspace" /></div>;
  }

  return (
    <div style={themeStyle(me.company)} className={cx('min-h-dvh lg:grid', narrow ? 'lg:grid-cols-[4.5rem_minmax(0,1fr)]' : 'lg:grid-cols-[16rem_minmax(0,1fr)]')}>
      <aside className="sticky top-0 z-30 hidden h-dvh lg:block">
        <Suspense><Sidebar narrow={narrow} onToggle={() => setCollapsed(!narrow)} /></Suspense>
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label="Close menu" className="absolute inset-0 bg-ink/50" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">
            <button aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute right-3 top-4 z-10 grid h-8 w-8 place-items-center rounded-md text-mint hover:bg-white/10"><X className="h-4 w-4" /></button>
            <Suspense><Sidebar narrow={false} onNavigate={() => setDrawer(false)} /></Suspense>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-line bg-surface px-3 sm:px-6">
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Open menu" onClick={() => setDrawer(true)} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-head lg:hidden"><Menu className="h-5 w-5" /></button>
            <Clock />
          </div>
          <div className="flex items-center gap-3">
            <CompanyLogo size={36} />
            <span className="hidden max-w-[40vw] truncate text-[18px] font-semibold tracking-tight text-brand sm:block">{me.company.productName}</span>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <WorkStatus />
            <NotificationBell />
            <span className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden />
            <UserMenu />
          </div>
        </header>
        <main id="content" className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-8">{children}</main>
        <footer className="border-t border-line bg-surface px-6 py-3 text-center text-xs text-muted">
          © {new Date().getFullYear()} <span className="font-semibold text-ink">{me.company.name}</span>{VERSION && <> · Version {VERSION}</>}
        </footer>
      </div>

    </div>
  );
}
