import { Injectable } from '@nestjs/common';
import type { LiveEvent } from './realtime.hub.js';

/**
 * Where hints from the database are handed out inside this server. The WebSocket connections listen
 * to it, and so do the few places that keep a short-lived copy of something (such as the queue
 * counts) and must drop it the moment it is known to be out of date, on whichever server the change
 * was made.
 */
@Injectable()
export class LiveBus {
  private readonly listeners = new Set<(event: LiveEvent) => void>();

  /** Returns a function that stops listening. */
  on(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(event: LiveEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // One listener's trouble must not stop the others hearing.
      }
    }
  }
}
