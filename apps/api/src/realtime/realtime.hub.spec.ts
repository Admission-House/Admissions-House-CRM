import { RealtimeHub, wants, type LiveEvent, type LiveSocket, type Subscriber } from './realtime.hub.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

class FakeSocket implements LiveSocket {
  sent: unknown[] = [];
  closed: [number, string] | null = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close(code: number, reason: string) { this.closed = [code, reason]; }
}

const sub = (userId: string, over: Partial<Omit<Subscriber, 'socket'>> = {}): Subscriber & { socket: FakeSocket } => ({
  socket: new FakeSocket(), tenantId: T1, userId, sessionId: `s-${userId}`, canSeeTeam: false, ...over,
});
const ev = (topic: LiveEvent['topic'], u: string | null = null, t = T1): LiveEvent => ({ t, topic, u });

describe('who hears about what', () => {
  const counsellor = { tenantId: T1, userId: 'c1', canSeeTeam: false };
  const admin = { tenantId: T1, userId: 'a1', canSeeTeam: true };

  it('tells a person about their own notifications and nobody else\'s', () => {
    expect(wants(counsellor, ev('notification', 'c1'))).toBe(true);
    expect(wants(counsellor, ev('notification', 'c2'))).toBe(false);
    expect(wants(admin, ev('notification', 'c1'))).toBe(false);
  });

  it('tells only people who oversee the team about team changes', () => {
    expect(wants(admin, ev('team'))).toBe(true);
    expect(wants(counsellor, ev('team'))).toBe(false);
  });

  it('tells the holder of a lead, and whoever oversees the team, about it', () => {
    expect(wants(counsellor, ev('lead', 'c1'))).toBe(true);
    expect(wants(counsellor, ev('lead', 'c2'))).toBe(false);
    expect(wants(counsellor, ev('lead', null))).toBe(false);
    expect(wants(admin, ev('lead', 'c2'))).toBe(true);
  });

  it('tells only the person concerned about a call or meeting invitation, not even an Admin', () => {
    expect(wants(counsellor, ev('call', 'c1'))).toBe(true);
    expect(wants(counsellor, ev('call', 'c2'))).toBe(false);
    expect(wants(admin, ev('call', 'c1'))).toBe(false);
    expect(wants(admin, ev('call', 'c1', T2))).toBe(false);
  });

  it('never crosses from one company to another', () => {
    expect(wants(admin, ev('team', null, T2))).toBe(false);
    expect(wants(counsellor, ev('notification', 'c1', T2))).toBe(false);
    expect(wants(admin, ev('lead', 'c1', T2))).toBe(false);
  });

  it('tells everyone to ask again after a gap', () => {
    expect(wants(counsellor, ev('resync', null, T2))).toBe(true);
  });
});

describe('RealtimeHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a hint after a short pause, and carries no data beyond the topic', () => {
    const hub = new RealtimeHub(500);
    const a = sub('c1');
    hub.add(a, 5);
    hub.dispatch(ev('notification', 'c1'));
    expect(a.socket.sent).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(a.socket.sent).toEqual([{ type: 'event', topics: ['notification'] }]);
  });

  it('sends a burst as one message with each topic once', () => {
    const hub = new RealtimeHub(500);
    const a = sub('a1', { canSeeTeam: true });
    hub.add(a, 5);
    for (let i = 0; i < 50; i++) hub.dispatch(ev('team'));
    hub.dispatch(ev('lead', 'c9'));
    hub.dispatch(ev('team'));
    vi.advanceTimersByTime(500);
    expect(a.socket.sent).toEqual([{ type: 'event', topics: ['team', 'lead'] }]);
    // Then it is quiet until something new happens.
    vi.advanceTimersByTime(5_000);
    expect(a.socket.sent).toHaveLength(1);
    hub.dispatch(ev('team'));
    vi.advanceTimersByTime(500);
    expect(a.socket.sent).toHaveLength(2);
  });

  it('sends nothing to a person who is not meant to hear', () => {
    const hub = new RealtimeHub(100);
    const c = sub('c1');
    const other = sub('c2');
    hub.add(c, 5); hub.add(other, 5);
    hub.dispatch(ev('notification', 'c1'));
    hub.dispatch(ev('team'));
    vi.advanceTimersByTime(100);
    expect(c.socket.sent).toEqual([{ type: 'event', topics: ['notification'] }]);
    expect(other.socket.sent).toEqual([]);
  });

  it('sends to every connection of the same person', () => {
    const hub = new RealtimeHub(100);
    const a = sub('c1'); const b = sub('c1');
    hub.add(a, 5); hub.add(b, 5);
    hub.dispatch(ev('notification', 'c1'));
    vi.advanceTimersByTime(100);
    expect(a.socket.sent).toHaveLength(1);
    expect(b.socket.sent).toHaveLength(1);
  });

  it('hands back the oldest connections when a person has too many', () => {
    const hub = new RealtimeHub();
    const all = Array.from({ length: 4 }, () => sub('c1'));
    const evicted: Subscriber[] = [];
    for (const s of all) evicted.push(...hub.add(s, 3));
    expect(evicted).toEqual([all[0]]);
    expect(hub.add(sub('c2'), 3)).toEqual([]);
  });

  it('forgets a connection that is removed, and stops a message that was waiting for it', () => {
    const hub = new RealtimeHub(500);
    const a = sub('c1');
    hub.add(a, 5);
    hub.dispatch(ev('notification', 'c1'));
    hub.remove(a);
    vi.advanceTimersByTime(1_000);
    expect(a.socket.sent).toEqual([]);
    expect(hub.size).toBe(0);
  });

  it('keeps going when one connection cannot be written to', () => {
    const hub = new RealtimeHub(100);
    const broken = sub('c1');
    broken.socket.send = () => { throw new Error('closed'); };
    const fine = sub('c2');
    hub.add(broken, 5); hub.add(fine, 5);
    hub.dispatch({ t: T1, topic: 'resync', u: null });
    vi.advanceTimersByTime(100);
    expect(fine.socket.sent).toEqual([{ type: 'event', topics: ['resync'] }]);
  });

  it('closes everything on shutdown', () => {
    const hub = new RealtimeHub();
    const a = sub('c1'); const b = sub('c2');
    hub.add(a, 5); hub.add(b, 5);
    hub.closeAll(1001, 'server stopping');
    expect(a.socket.closed).toEqual([1001, 'server stopping']);
    expect(b.socket.closed).toEqual([1001, 'server stopping']);
    expect(hub.size).toBe(0);
  });
});
