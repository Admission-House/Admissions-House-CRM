import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tests run without a browser: a small stand-in for localStorage, shared like the real one is between tabs.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.mock('./api', () => ({ api: vi.fn() }));

const { backToListUrl, inListContext, nextLeadId, saveListContext } =
  await import('./lead-list-context');
const { api } = await import('./api');

/** What a leads list open in another tab writes when it refreshes (it does not go through this page's memory). */
const otherTabWrites = (ids: string[]) =>
  store.set(
    'ah-lead-list',
    JSON.stringify({
      url: '/leads?queue=fresh',
      query: {},
      cursors: [null],
      ids,
      nextCursor: null,
    }),
  );

describe('the list a lead was opened from', () => {
  beforeEach(() => {
    store.clear();
    saveListContext({
      url: '/leads?queue=fresh',
      query: { queue: 'fresh' },
      cursors: [null],
      ids: ['a', 'b', 'c'],
      nextCursor: 'cur2',
    });
  });

  it('stays the same while the lead is open, even when another tab refreshes the list without it', () => {
    expect(inListContext('b')).toBe(true);
    otherTabWrites(['x', 'y']); // the lead was disposed and left the Fresh list in the other tab
    expect(inListContext('b')).toBe(true);
    expect(backToListUrl('b')).toBe('/leads?queue=fresh');
  });

  it('is none for a lead opened from somewhere else, and stays none', () => {
    expect(inListContext('zzz')).toBe(false);
    otherTabWrites(['zzz']);
    expect(inListContext('zzz')).toBe(false);
    expect(backToListUrl('zzz')).toBe('/leads');
  });

  it('"Save & next" walks the list it was opened from, into the next page, and the next lead keeps that list', async () => {
    expect(await nextLeadId('a')).toBe('b');
    otherTabWrites(['x']);
    expect(inListContext('b')).toBe(true); // carried on from 'a', not read again
    expect(await nextLeadId('b')).toBe('c');
    vi.mocked(api).mockResolvedValueOnce({
      items: [{ id: 'c' }, { id: 'd' }],
      nextCursor: null,
    } as never);
    expect(await nextLeadId('c')).toBe('d');
    expect(inListContext('d')).toBe(true);
    expect(await nextLeadId('d')).toBeNull(); // the end of the list
  });
});
