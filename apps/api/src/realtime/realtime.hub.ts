/**
 * Who hears about what, kept apart from the network so it can be tested on its own.
 *
 * An event is only a hint that something changed: a company, a topic and sometimes a person. It
 * carries no data. A browser that gets one asks the normal API for the new numbers, so it can never
 * be told more than its own permissions allow.
 */
export const TOPICS = ['notification', 'team', 'lead', 'call'] as const;
export type Topic = (typeof TOPICS)[number];

export interface LiveEvent {
  /** The company the change happened in. */
  t: string;
  /** What changed. `resync` means events may have been missed, so everything should be asked for again. */
  topic: Topic | 'resync';
  /** The person it concerns, for the topics that are about one person. */
  u: string | null;
}

/** Just what the hub needs from a connection, so a test can use a stand-in. */
export interface LiveSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface Subscriber {
  socket: LiveSocket;
  tenantId: string;
  userId: string;
  sessionId: string;
  /** May see the whole team's work (an Admin or Super Admin who may read reports). */
  canSeeTeam: boolean;
}

/** Whether this person should hear about this event. */
export function wants(sub: Pick<Subscriber, 'tenantId' | 'userId' | 'canSeeTeam'>, e: LiveEvent): boolean {
  if (e.topic === 'resync') return true;
  if (sub.tenantId !== e.t) return false;
  switch (e.topic) {
    case 'notification':
      return e.u === sub.userId;
    case 'team':
      return sub.canSeeTeam;
    case 'lead':
      // The person who holds the lead, and whoever oversees the team.
      return e.u === sub.userId || sub.canSeeTeam;
    case 'call':
      // A call or meeting invitation changed: the person invited and the person who started it.
      return e.u === sub.userId;
  }
}

interface Entry extends Subscriber {
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
}

export class RealtimeHub {
  private readonly entries = new Map<Subscriber, Entry>();

  /** `coalesceMs`: events that arrive close together are sent as one message, so a busy minute does not make a flood. */
  constructor(private readonly coalesceMs = 500) {}

  get size(): number {
    return this.entries.size;
  }

  all(): Subscriber[] {
    return [...this.entries.keys()];
  }

  /** Adds a connection. If the person already has `maxPerUser`, the oldest ones are returned so they can be closed. */
  add(sub: Subscriber, maxPerUser: number): Subscriber[] {
    this.entries.set(sub, { ...sub, pending: new Set(), timer: null });
    const mine = [...this.entries.keys()].filter((s) => s.userId === sub.userId && s.tenantId === sub.tenantId);
    return mine.slice(0, Math.max(0, mine.length - maxPerUser));
  }

  remove(sub: Subscriber): void {
    const entry = this.entries.get(sub);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(sub);
  }

  dispatch(e: LiveEvent): void {
    for (const [sub, entry] of this.entries) {
      if (!wants(sub, e)) continue;
      entry.pending.add(e.topic);
      entry.timer ??= setTimeout(() => this.flush(sub, entry), this.coalesceMs);
    }
  }

  private flush(sub: Subscriber, entry: Entry): void {
    entry.timer = null;
    const topics = [...entry.pending];
    entry.pending.clear();
    if (topics.length === 0) return;
    try {
      sub.socket.send(JSON.stringify({ type: 'event', topics }));
    } catch {
      // A connection that cannot be written to is closed by its own error handling.
    }
  }

  /** Closes every connection (shutting down). */
  closeAll(code: number, reason: string): void {
    for (const sub of [...this.entries.keys()]) {
      try {
        sub.socket.close(code, reason);
      } catch {
        // already gone
      }
      this.remove(sub);
    }
  }
}
