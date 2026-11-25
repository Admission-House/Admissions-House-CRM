/**
 * Remembers the leads list a person was working from (its section, filters, sort and page), so that a lead opened from
 * it can go back to exactly that list, and "Save & next" can open the next lead of that list. Kept in this browser
 * (localStorage, so a lead opened in a new tab knows it too); only the last list is kept. A lead that is not in the
 * remembered list (opened from a notification or search) simply goes back to the leads page, with no "next".
 */
import { useSyncExternalStore } from 'react';
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
    return typeof c?.url === 'string' && Array.isArray(c.ids) && Array.isArray(c.cursors)
      ? c
      : null;
  } catch {
    return null;
  }
}

/**
 * The list each open lead belongs to, taken once when the lead is first shown and kept while this page lives. The
 * remembered list itself keeps changing: a leads list open in another tab refreshes every few seconds, and a lead that
 * was just disposed leaves its section. Reading it afresh on every render made "Save & next" come and go while a
 * person was filling the form; the copy taken when the lead opened does not move.
 */
const opened = new Map<string, LeadListContext | null>();

function contextFor(leadId: string): LeadListContext | null {
  if (!opened.has(leadId)) {
    const c = readListContext();
    opened.set(leadId, c && c.ids.includes(leadId) ? c : null);
  }
  return opened.get(leadId) ?? null;
}

export function saveListContext(c: LeadListContext): void {
  // Back on a list: the leads opened from now on belong to this one.
  opened.clear();
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage blocked: going back still works, to the plain leads page */
  }
}

/** Where "Back to leads" goes from this lead. */
export function backToListUrl(leadId: string): string {
  return contextFor(leadId)?.url ?? '/leads';
}

/** Whether this lead was opened from a leads list (so "Save & next" makes sense). */
export function inListContext(leadId: string): boolean {
  return contextFor(leadId) !== null;
}

// localStorage has no change event for the same tab; the value is read when the page renders, which is all these need.
const noSubscribe = () => () => undefined;

/** Where "Back to leads" goes from this lead (the plain leads page on the server and in a new browser). */
export const useBackToList = (leadId: string): string =>
  useSyncExternalStore(
    noSubscribe,
    () => backToListUrl(leadId),
    () => '/leads',
  );

/** Whether this lead came from the remembered list, so "Save & next" and "Save, back to the list" apply. */
export const useInListContext = (leadId: string): boolean =>
  useSyncExternalStore(
    noSubscribe,
    () => inListContext(leadId),
    () => false,
  );

/**
 * The lead after this one in the remembered list, fetching the next page of the list when this was the last one shown.
 * Null at the end of the list.
 */
export async function nextLeadId(leadId: string): Promise<string | null> {
  const c = contextFor(leadId);
  if (!c) return null;
  const at = c.ids.indexOf(leadId);
  let list = c;
  let next: string | null = at + 1 < c.ids.length ? c.ids[at + 1]! : null;
  if (!next && c.nextCursor) {
    const page = await api<Page<LeadListItem>>('/leads', {
      query: { ...c.query, cursor: c.nextCursor },
    });
    const fresh = page.items.map((l) => l.id).filter((id) => !c.ids.includes(id));
    list = {
      ...c,
      cursors: [...c.cursors, c.nextCursor],
      ids: [...c.ids, ...fresh],
      nextCursor: page.nextCursor,
    };
    saveListContext(list);
    next = fresh[0] ?? null;
  }
  // The next lead continues in the same list, so "Save & next" and "Back to leads" carry on from it.
  if (next) opened.set(next, list);
  return next;
}
