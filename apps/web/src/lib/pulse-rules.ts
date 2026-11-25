/** What the question "what changed?" answers: when each topic last changed for this person, and whether a call is ringing. */
export interface Pulse {
  stamps: Record<string, string>;
  /** Someone is calling this person right now. */
  ringing: boolean;
}

export interface Pace {
  /** The gap between questions while someone is working with the screen. */
  activeMs: number;
  /** The gap while the tab is hidden or untouched. */
  quietMs: number;
  /** The gap while a call is ringing. */
  ringingMs: number;
  maxBackoffMs: number;
}

/**
 * How long to wait before asking again. Fast only while something is ringing, slow when nobody is looking
 * (so a hidden tab costs almost nothing), and longer and longer while the server does not answer.
 */
export function nextWaitMs(
  pace: Pace,
  state: { failures: number; ringing: boolean; hidden: boolean; untouchedMs: number },
  quietAfterMs: number,
): number {
  if (state.failures > 0) return Math.min(pace.activeMs * 2 ** state.failures, pace.maxBackoffMs);
  if (state.ringing) return pace.ringingMs;
  return state.hidden || state.untouchedMs > quietAfterMs ? pace.quietMs : pace.activeMs;
}

/**
 * The topics whose time moved since the last answer. The very first answer changes nothing: the screens
 * loaded their own data, and only need to hear about what happens after. A ring always counts, so the ring
 * screen stays fresh while it rings; `resyncDue` adds a "look at everything again" as a safety net.
 */
export function changedTopics(last: Pulse | null, now: Pulse, resyncDue: boolean): string[] {
  if (!last) return [];
  const changed = Object.entries(now.stamps)
    .filter(([topic, at]) => last.stamps[topic] !== at)
    .map(([topic]) => topic);
  if (now.ringing && !changed.includes('call')) changed.push('call');
  if (resyncDue) changed.push('resync');
  return changed;
}

/**
 * Which topics a screen's data depends on, read from the address it loads, so that every screen refreshes by
 * itself when someone else changes what it shows. Things that rarely change (the lists in a drop-down) are left out.
 */
export function topicsForPath(path: string | null): string[] {
  if (!path) return [];
  const p = path.split('?')[0]!.replace(/^\/+/, '');
  const head = p.split('/')[0]!;
  if (head === 'leads' && p.endsWith('/calls')) return ['lead', 'calllog']; // a lead's Calls tab
  if (head === 'leads' || head === 'followups' || head === 'imports') return ['lead'];
  if (head === 'attendance' || head === 'leave' || head === 'salaries' || head === 'payroll')
    return ['work', 'team'];
  if (head === 'reports') return ['lead', 'work', 'team', 'calllog'];
  if (
    head === 'users' ||
    head === 'roles' ||
    head === 'branches' ||
    head === 'lead-statuses' ||
    head === 'lead-sources' ||
    head === 'lead-policies'
  )
    return ['admin'];
  if (head === 'communications' || head === 'calls') return ['call', 'calllog'];
  return [];
}
