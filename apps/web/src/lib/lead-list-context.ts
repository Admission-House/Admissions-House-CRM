/**
 * Remembers the leads list a person was working from (its section, filters, sort and page), so that a lead opened from
 * it can go back to exactly that list, and "Save & next" can open the next lead of that list. Kept in this browser
 * (localStorage, so a lead opened in a new tab knows it too); only the last list is kept. A lead that is not in the
 * remembered list (opened from a notification or search) simply goes back to the leads page, with no "next".
 */
import { api } from './api';
import type { LeadListItem, Page } from './types';

const KEY = 'ah-lead-list';

export interface LeadListContext {
  /** The list's address, e.g. /leads?queue=fresh&orderBy=name. */
  url: string;
  /** The question the list asks the server, without the page cursor. */
  query: Record<string, string | number>;
  /** The cursor each page passed so far starts from (null = first page); the last one is the page on screen. */
  cursors: (string | null)[];
  /** The leads on the page on screen, in order, and then any fetched after it for "next". */
  ids: string[];
  /** Where the list continues after `ids`, or null at its end. */
  nextCursor: string | null;
}

export function readListContext(): LeadListContext | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as LeadListContext;
    return typeof c?.url === 'string' && Array.isArray(c.ids) && Array.isArray(c.cursors) ? c : null;
  } catch {
    return null;
  }
}

export function saveListContext(c: LeadListContext): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage blocked: going back still works, to the plain leads page */
  }
}

/** Where "Back to leads" goes from this lead. */
export function backToListUrl(leadId: string): string {
  const c = readListContext();
  return c && c.ids.includes(leadId) ? c.url : '/leads';
}

/** Whether this lead was opened from the remembered list (so "Save & next" makes sense). */
export function inListContext(leadId: string): boolean {
  return !!readListContext()?.ids.includes(leadId);
}

/**
 * The lead after this one in the remembered list, fetching the next page of the list when this was the last one shown.
 * Null at the end of the list.
 */
export async function nextLeadId(leadId: string): Promise<string | null> {
  const c = readListContext();
  if (!c) return null;
  const at = c.ids.indexOf(leadId);
  if (at < 0) return null;
  if (at + 1 < c.ids.length) return c.ids[at + 1]!;
  if (!c.nextCursor) return null;
  const page = await api<Page<LeadListItem>>('/leads', { query: { ...c.query, cursor: c.nextCursor } });
  const fresh = page.items.map((l) => l.id).filter((id) => !c.ids.includes(id));
  saveListContext({ ...c, cursors: [...c.cursors, c.nextCursor], ids: [...c.ids, ...fresh], nextCursor: page.nextCursor });
  return fresh[0] ?? null;
}
