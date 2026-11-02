import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { sql } from 'kysely';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthContext } from '../auth/auth-context.js';
import { AuthService } from '../auth/auth.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { LiveBus } from './live-bus.js';
import { RealtimeHub, type Subscriber } from './realtime.hub.js';

export const WS_PATH = '/api/v1/ws';

/** Most browser tabs one person can have connected at once. The oldest are closed beyond this. */
const MAX_PER_USER = 5;
/** A connection that has not signed in within this time is closed. */
const AUTH_TIMEOUT_MS = 5_000;
/** Connections from one address that have not signed in yet. */
const MAX_UNSIGNED_PER_IP = 20;
/** Messages a connection may send in ten seconds. It only ever needs to send a ping now and then. */
const MAX_MESSAGES_PER_10S = 20;
const HEARTBEAT_MS = 30_000;

/** Close codes the browser understands (4xxx is for applications). */
export const CLOSE = { badRequest: 4400, signIn: 4401, timeout: 4408, replaced: 4409, tooMany: 4429, stopping: 1001 } as const;

/** A browser sends its origin; one that is not on the list is refused. A tool with no origin is not a browser and passes to the sign-in. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

/** The address of the person, trusting only as many proxies as are configured. */
export function clientIp(req: Pick<IncomingMessage, 'socket' | 'headers'>, proxyHops: number): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (proxyHops <= 0 || typeof forwarded !== 'string') return direct;
  const chain = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  return chain[Math.max(0, chain.length - proxyHops)] ?? direct;
}

type Live = WebSocket & { isAlive?: boolean };

/**
 * The WebSocket address /api/v1/ws. The first thing a connection sends is {"type":"auth","token":...}:
 * the access token is not put in the address, because addresses end up in logs. After that the server
 * sends {"type":"event","topics":[...]} hints and the browser asks the normal API for the new numbers.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  readonly hub = new RealtimeHub();
  private wss?: WebSocketServer;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly unsigned = new Map<string, number>();
  private stopListening?: () => void;
  private upgradeHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly auth: AuthService,
    private readonly db: DatabaseService,
    private readonly bus: LiveBus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.REALTIME_ENABLED) return;
    const server = this.adapter.httpAdapter.getHttpServer() as import('node:http').Server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    this.upgradeHandler = (req, socket, head) => this.onUpgrade(req, socket, head);
    server.on('upgrade', this.upgradeHandler);
    this.stopListening = this.bus.on((event) => this.hub.dispatch(event));

    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS), setInterval(() => void this.recheck(), this.env.REALTIME_RECHECK_SEC * 1000));
    for (const t of this.timers) t.unref();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.stopListening?.();
    if (this.upgradeHandler) this.adapter.httpAdapter.getHttpServer().off('upgrade', this.upgradeHandler);
    this.hub.closeAll(CLOSE.stopping, 'server stopping');
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
  }

  private refuse(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH || !this.wss) return void socket.destroy();
    if (!originAllowed(req.headers.origin, this.env.CORS_ORIGINS)) return this.refuse(socket, '403 Forbidden');

    const ip = clientIp(req, this.env.TRUST_PROXY_HOPS);
    if ((this.unsigned.get(ip) ?? 0) >= MAX_UNSIGNED_PER_IP) return this.refuse(socket, '429 Too Many Requests');

    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws as Live, ip, req.headers['user-agent'] ?? null));
  }

  private accept(ws: Live, ip: string, userAgent: string | null): void {
    ws.isAlive = true;
    this.unsigned.set(ip, (this.unsigned.get(ip) ?? 0) + 1);
    let counted = true;
    const signedOrGone = () => {
      if (!counted) return;
      counted = false;
      const n = (this.unsigned.get(ip) ?? 1) - 1;
      if (n <= 0) this.unsigned.delete(ip);
      else this.unsigned.set(ip, n);
    };

    let sub: Subscriber | null = null;
    let signingIn = false;
    let windowStart = Date.now();
    let messages = 0;
    const authTimer = setTimeout(() => ws.close(CLOSE.timeout, 'sign-in timeout'), AUTH_TIMEOUT_MS);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(authTimer);
      signedOrGone();
      if (sub) this.hub.remove(sub);
    });

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - windowStart > 10_000) { windowStart = now; messages = 0; }
      if (++messages > MAX_MESSAGES_PER_10S) return ws.close(CLOSE.tooMany, 'too many messages');

      let msg: { type?: unknown; token?: unknown };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return ws.close(CLOSE.badRequest, 'not JSON');
      }

      if (sub) {
        if (msg.type === 'ping') ws.send('{"type":"pong"}');
        return;
      }
      if (signingIn) return;
      if (msg.type !== 'auth' || typeof msg.token !== 'string') return ws.close(CLOSE.badRequest, 'sign in first');

      signingIn = true;
      // Not counted as activity: a connection that keeps reconnecting must not keep an idle session open.
      this.auth.authenticate(msg.token, { ip, userAgent, requestId: 'ws' }, { touch: false })
        .then((auth) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          clearTimeout(authTimer);
          sub = this.subscriberFor(ws, auth);
          for (const old of this.hub.add(sub, MAX_PER_USER)) old.socket.close(CLOSE.replaced, 'another window was opened');
          signedOrGone();
          ws.send('{"type":"ready"}');
        })
        .catch(() => ws.close(CLOSE.signIn, 'sign in again'));
    });
  }

  private subscriberFor(ws: Live, auth: AuthContext): Subscriber {
    return {
      socket: ws,
      tenantId: auth.tenantId,
      userId: auth.userId,
      sessionId: auth.sessionId,
      canSeeTeam: auth.permissions.has('report.read') && auth.dataScope !== 'own',
    };
  }

  /** Closes a connection that has stopped answering, so a closed laptop does not stay on the list. */
  private heartbeat(): void {
    for (const ws of (this.wss?.clients ?? []) as Set<Live>) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }

  /**
   * Signing out, being signed out, an idle logout or a deactivated account end a session. Connections
   * of ended sessions are closed here, within one check, so nobody keeps listening after they are out.
   */
  async recheck(): Promise<void> {
    const byTenant = new Map<string, Subscriber[]>();
    for (const s of this.hub.all()) byTenant.set(s.tenantId, [...(byTenant.get(s.tenantId) ?? []), s]);
    for (const [tenantId, subs] of byTenant) {
      try {
        const live = await this.db.withTenant(tenantId, async (trx) => {
          const { rows } = await sql<{ id: string }>`
            SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id AND u.status = 'active'
            WHERE s.id = ANY(${[...new Set(subs.map((x) => x.sessionId))]}::uuid[]) AND s.ended_at IS NULL AND s.expires_at > now()`.execute(trx);
          return new Set(rows.map((r) => r.id));
        });
        for (const s of subs) if (!live.has(s.sessionId)) s.socket.close(CLOSE.signIn, 'signed out');
      } catch (e) {
        this.logger.warn(`could not check live sessions: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
