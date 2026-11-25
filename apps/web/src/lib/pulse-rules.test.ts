import { describe, expect, it } from 'vitest';
import { changedTopics, nextWaitMs, type Pace, type Pulse } from './pulse-rules';

const pace: Pace = { activeMs: 15_000, quietMs: 60_000, ringingMs: 3_000, maxBackoffMs: 120_000 };
const state = { failures: 0, ringing: false, hidden: false, untouchedMs: 0 };
const QUIET_AFTER = 120_000;
const pulse = (stamps: Record<string, string>, ringing = false): Pulse => ({ stamps, ringing });

describe('how long to wait before asking again', () => {
  it('asks at the normal pace while someone is working with the screen', () => {
    expect(nextWaitMs(pace, state, QUIET_AFTER)).toBe(15_000);
  });
  it('asks quickly only while a call is ringing', () => {
    expect(nextWaitMs(pace, { ...state, ringing: true }, QUIET_AFTER)).toBe(3_000);
  });
  it('asks slowly when the tab is hidden, or when nobody has touched the screen for a while', () => {
    expect(nextWaitMs(pace, { ...state, hidden: true }, QUIET_AFTER)).toBe(60_000);
    expect(nextWaitMs(pace, { ...state, untouchedMs: 130_000 }, QUIET_AFTER)).toBe(60_000);
    expect(nextWaitMs(pace, { ...state, untouchedMs: 100_000 }, QUIET_AFTER)).toBe(15_000);
  });
  it('waits longer and longer while the server does not answer, up to a limit, even if something rings', () => {
    expect(nextWaitMs(pace, { ...state, failures: 1 }, QUIET_AFTER)).toBe(30_000);
    expect(nextWaitMs(pace, { ...state, failures: 2 }, QUIET_AFTER)).toBe(60_000);
    expect(nextWaitMs(pace, { ...state, failures: 3, ringing: true }, QUIET_AFTER)).toBe(120_000);
    expect(nextWaitMs(pace, { ...state, failures: 9 }, QUIET_AFTER)).toBe(120_000);
  });
});

describe('what changed since the last answer', () => {
  const a = pulse({ lead: '2026-11-14T10:00:00.000Z', team: '2026-11-14T10:00:00.000Z' });

  it('says nothing for the first answer: the screens loaded their own data', () => {
    expect(changedTopics(null, a, false)).toEqual([]);
    expect(changedTopics(null, pulse({}, true), true)).toEqual([]);
  });
  it('says nothing when nothing moved', () => {
    expect(changedTopics(a, pulse({ ...a.stamps }), false)).toEqual([]);
  });
  it('names only the topics whose time moved', () => {
    expect(
      changedTopics(a, pulse({ ...a.stamps, lead: '2026-11-14T10:05:00.000Z' }), false),
    ).toEqual(['lead']);
  });
  it('counts a topic that appears for the first time as a change', () => {
    expect(
      changedTopics(a, pulse({ ...a.stamps, notification: '2026-11-14T10:06:00.000Z' }), false),
    ).toEqual(['notification']);
  });
  it('keeps the ring screen fresh while it rings, without repeating the topic', () => {
    expect(changedTopics(a, pulse({ ...a.stamps }, true), false)).toEqual(['call']);
    expect(
      changedTopics(a, pulse({ ...a.stamps, call: '2026-11-14T10:07:00.000Z' }, true), false),
    ).toEqual(['call']);
  });
  it('adds a "look at everything again" when the safety net is due', () => {
    expect(changedTopics(a, pulse({ ...a.stamps }), true)).toEqual(['resync']);
  });
});

describe('topicsForPath', () => {
  it('refreshes a screen when what it shows can change, and leaves static lists alone', async () => {
    const { topicsForPath } = await import('./pulse-rules');
    expect(topicsForPath('/leads')).toEqual(['lead']);
    expect(topicsForPath('/leads/abc/followups')).toEqual(['lead']);
    expect(topicsForPath('/attendance/me/today')).toEqual(['work', 'team']);
    expect(topicsForPath('/users?limit=5')).toEqual(['admin']);
    expect(topicsForPath('/lead-statuses')).toEqual(['admin']);
    expect(topicsForPath('/auth/me')).toEqual([]);
    expect(topicsForPath(null)).toEqual([]);
  });

  it('refreshes call lists and call reports when any call in the company starts, connects or ends', async () => {
    const { topicsForPath } = await import('./pulse-rules');
    expect(topicsForPath('/calls?from=2026-11-24')).toEqual(['call', 'calllog']);
    expect(topicsForPath('/leads/abc/calls')).toEqual(['lead', 'calllog']);
    expect(topicsForPath('/reports/calls')).toContain('calllog');
    expect(topicsForPath('/reports/tat')).toContain('calllog');
  });
});
