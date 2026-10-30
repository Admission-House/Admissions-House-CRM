'use client';

import { CornerDownLeft, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtPhone } from '@/lib/format';
import { NAV } from '@/lib/nav';
import type { LeadListItem, Page } from '@/lib/types';

interface Result {
  key: string;
  label: string;
  hint?: string;
  href: string;
  kind: 'page' | 'lead';
  name?: string;
}

/**
 * The search box at the top of the menu. You type right there, and what matches appears under it:
 * the screens you may open, and leads by name, phone or number. Ctrl+K jumps to it from anywhere.
 * When the menu is narrow it is only an icon; pressing it widens the menu and puts you in the box.
 */
export function SidebarSearch({ narrow, onExpand, onNavigate }: { narrow: boolean; onExpand?: () => void; onNavigate?: () => void }) {
  const router = useRouter();
  const { canAny } = useAuth();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);

  const pages = useMemo<Result[]>(
    () => NAV.flatMap((i) => (i.children ? i.children.map((c) => ({ ...c, label: `${i.label}: ${c.label}` })) : [i])).filter((i) => i.href && canAny(...i.any)).map((i) => ({ key: i.href!, label: i.label, href: i.href!, kind: 'page' as const })),
    [canAny],
  );

  // Ctrl+K from anywhere. A narrow menu is widened first, and the box is focused once it exists.
  const focusBox = useCallback(() => {
    if (narrow) {
      wantFocus.current = true;
      onExpand?.();
    } else {
      input.current?.focus();
      input.current?.select();
    }
  }, [narrow, onExpand]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusBox();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [focusBox]);

  useEffect(() => {
    if (!narrow && wantFocus.current) {
      wantFocus.current = false;
      input.current?.focus();
    }
  }, [narrow]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 2 || !canAny('lead.read')) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<Page<LeadListItem>>('/leads', { query: { q, limit: 6 }, signal: ctl.signal }).then((p) => setLeads(p.items)).catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, open, canAny]);

  const q = text.trim().toLowerCase();
  const results: Result[] = [
    ...pages.filter((p) => q && p.label.toLowerCase().includes(q)),
    ...(q.length >= 2 ? leads.map((l) => ({ key: l.id, label: l.name, hint: `${fmtPhone(l.phone)} · #${l.leadNo} · ${l.status.name}`, href: `/leads/${l.id}`, kind: 'lead' as const, name: l.name })) : []),
  ];

  function go(r: Result | undefined) {
    if (!r) return;
    setOpen(false);
    setText('');
    setLeads([]);
    input.current?.blur();
    onNavigate?.();
    router.push(r.href);
  }

  if (narrow) {
    return (
      <button type="button" aria-label="Search (Ctrl K)" title="Search (Ctrl K)" onClick={focusBox} className="flex h-10 w-full items-center justify-center rounded-lg border border-white/15 bg-white/8 text-mint/70 transition hover:bg-white/12">
        <Search className="h-4 w-4" aria-hidden />
      </button>
    );
  }

  return (
    <div ref={box} className="relative">
      <div className={cx('flex h-10 items-center gap-2.5 rounded-lg border bg-white/8 px-3 text-[13px] transition', open ? 'border-teal bg-white/12' : 'border-white/15 hover:bg-white/12')}>
        <Search className="h-4 w-4 shrink-0 text-mint/70" aria-hidden />
        <input
          ref={input}
          value={text}
          onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
          }}
          placeholder="Search…"
          aria-label="Search screens and leads"
          aria-expanded={open}
          aria-controls="sidebar-search-results"
          role="combobox"
          aria-autocomplete="list"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-mint/70"
        />
        {text ? (
          <button type="button" aria-label="Clear search" onClick={() => { setText(''); setLeads([]); input.current?.focus(); }} className="text-mint/70 hover:text-white"><X className="h-4 w-4" /></button>
        ) : (
          <kbd className="rounded border border-white/20 px-1.5 text-[10px] text-mint/70">Ctrl K</kbd>
        )}
      </div>

      {open && q.length > 0 && (
        <div id="sidebar-search-results" role="listbox" className="absolute left-0 top-full z-50 mt-2 max-h-96 w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-line bg-surface py-1.5 text-ink shadow-2xl">
          {results.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">{q.length < 2 ? 'Keep typing…' : 'Nothing found'}</p>}
          {results.map((r, i) => (
            <button
              key={`${r.kind}${r.key}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={cx('flex w-full items-center gap-3 px-3.5 py-2 text-left', i === active && 'bg-mint-soft')}
            >
              {r.kind === 'lead' ? <Avatar name={r.name ?? r.label} size={28} tone="soft" /> : <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-head text-[11px] font-semibold uppercase text-muted">Go</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.label}</span>
                {r.hint && <span className="block truncate text-xs text-muted">{r.hint}</span>}
              </span>
              {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
