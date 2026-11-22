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

describe('permissionsForPath', () => {
  it('asks for the permission of the menu entry a page falls under, including pages inside it', async () => {
    const { permissionsForPath } = await import('./nav');
    expect(permissionsForPath('/settings/roles')).toEqual(['role.manage']);
    expect(permissionsForPath('/settings/users/abc-123')).toEqual(['user.read', 'user.manage']);
    expect(permissionsForPath('/leads/abc-123')).toEqual(['lead.read']);
    expect(permissionsForPath('/imports')).toEqual(['lead.import', 'lead.export', 'master.manage']);
    expect(permissionsForPath('/colleges')).toEqual(['master.read']);
    expect(permissionsForPath('/settings')).toContain('settings.manage');
  });

  it('asks for nothing for a person\'s own pages', async () => {
    const { permissionsForPath } = await import('./nav');
    expect(permissionsForPath('/account')).toBeNull();
    expect(permissionsForPath('/notifications')).toBeNull();
    expect(permissionsForPath('/video/some-room')).toBeNull();
  });
});
