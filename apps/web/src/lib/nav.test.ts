import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV } from './nav';

const hrefs = NAV.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)]).filter((h): h is string => !!h);

/** Screens that are reached some other way than the sidebar: the bell, the person's own menu, a call room opened from a link. */
const NOT_IN_THE_SIDEBAR = new Set(['account', 'notifications', 'video']);

describe('the sidebar', () => {
  it('has an entry for every screen that exists, so none is built and then cannot be reached', () => {
    const screens = readdirSync(join(__dirname, '..', 'app', '(app)'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const missing = screens.filter((name) => !NOT_IN_THE_SIDEBAR.has(name) && !hrefs.some((h) => h === `/${name}` || h.startsWith(`/${name}/`) || h.startsWith(`/${name}?`)));
    expect(missing).toEqual([]);
  });

  it('lists calls and meetings for people who may host them', () => {
    const item = NAV.find((i) => i.href === '/communications');
    expect(item?.any).toContain('video.host');
  });

  it('keeps the phone screens for when a calling provider is connected', () => {
    const calling = NAV.find((i) => i.label === 'Calling');
    expect(calling?.needsPhone).toBe(true);
    expect(NAV.filter((i) => i.needsPhone).map((i) => i.label)).toEqual(['Calling']);
  });
});
