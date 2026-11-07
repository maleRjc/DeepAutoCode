import { sanitizeObjectForLog } from '../security.js';
import { EventMessageSchema, type EventMessage } from '../types.js';

export type UIEventListener = (event: EventMessage) => void;

/**
 * Section 4.2 & 6.2: Event Bridge
 * - Subscribes to SDK/Runtime events and maps them to stable, serializable UI EventMessages.
 * - Enforces monotonic per-session sequence numbers.
 * - Redacts sensitive fields before exposing to Webview.
 * - Buffers event history per session to support reconnect/attach replay (lastSequence cursor).
 * - Deduplicates events by eventKey when provided.
 */
export class EventBridge {
  private readonly sequenceCounters = new Map<string, number>();
  private readonly sessionEventHistory = new Map<string, EventMessage[]>();
  private readonly seenEventKeys = new Map<string, Set<string>>();
  private readonly listeners = new Map<string, UIEventListener>();
  private readonly maxHistoryPerSession: number;

  constructor(options?: { maxHistoryPerSession?: number }) {
    this.maxHistoryPerSession = options?.maxHistoryPerSession ?? 1000;
  }

  /**
   * Register or replace a named Webview/UI subscriber.
   * Using a stable subscriberId (e.g., "primary-webview") prevents duplicate subscriptions on Webview reopen.
   */
  subscribeUI(subscriberId: string, listener: UIEventListener): () => void {
    this.listeners.set(subscriberId, listener);
    return () => {
      if (this.listeners.get(subscriberId) === listener) {
        this.listeners.delete(subscriberId);
      }
    };
  }

  unsubscribeUI(subscriberId: string): void {
    this.listeners.delete(subscriberId);
  }

  getActiveSubscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Seed sequence counter when restoring a persisted session (PoC-L2)
   */
  seedSessionSequence(sessionId: string, lastSequence: number): void {
    const current = this.sequenceCounters.get(sessionId) ?? 0;
    if (lastSequence > current) {
      this.sequenceCounters.set(sessionId, lastSequence);
    }
  }

  /**
   * Emit a sanitized, sequenced UI event
   */
  emit(
    sessionId: string,
    type: EventMessage['type'],
    rawPayload: Record<string, unknown>,
    dedupeKey?: string
  ): EventMessage | null {
    if (dedupeKey) {
      let keySet = this.seenEventKeys.get(sessionId);
      if (!keySet) {
        keySet = new Set();
        this.seenEventKeys.set(sessionId, keySet);
      }
      if (keySet.has(dedupeKey)) {
        return null;
      }
      keySet.add(dedupeKey);
    }

    const nextSeq = (this.sequenceCounters.get(sessionId) ?? 0) + 1;
    this.sequenceCounters.set(sessionId, nextSeq);

    const sanitizedPayload = sanitizeObjectForLog(rawPayload);
    const event: EventMessage = EventMessageSchema.parse({
      category: 'event',
      type,
      sessionId,
      sequence: nextSeq,
      timestamp: new Date().toISOString(),
      payload: sanitizedPayload,
    });

    let history = this.sessionEventHistory.get(sessionId);
    if (!history) {
      history = [];
      this.sessionEventHistory.set(sessionId, history);
    }
    history.push(event);
    if (history.length > this.maxHistoryPerSession) {
      history.shift();
    }

    for (const listener of this.listeners.values()) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber errors so one broken listener never crashes Runtime
      }
    }

    return event;
  }

  /**
   * Replay missed events after `lastSequence` when Webview re-attaches
   */
  getEventsSince(sessionId: string, lastSequence: number): EventMessage[] {
    const history = this.sessionEventHistory.get(sessionId) ?? [];
    return history.filter((ev) => ev.sequence > lastSequence);
  }

  getLastSequence(sessionId: string): number {
    return this.sequenceCounters.get(sessionId) ?? 0;
  }

  clearSession(sessionId: string): void {
    this.sequenceCounters.delete(sessionId);
    this.sessionEventHistory.delete(sessionId);
    this.seenEventKeys.delete(sessionId);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

