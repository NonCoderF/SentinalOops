export type LiveEventType = 'incident' | 'recovery' | 'notification' | 'heartbeat' | 'traffic';

export interface LiveEvent {
  type: LiveEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: LiveEvent) => void;

/** In-process event fan-out for the single-container Alert Manager. */
export class EventHub {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly persist?: (event: LiveEvent) => void) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(type: LiveEventType, data: Record<string, unknown> = {}): void {
    const event: LiveEvent = { type, timestamp: new Date().toISOString(), data };
    try { this.persist?.(event); } catch { /* persistence must not interrupt live delivery */ }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected browser must not affect the poller or notification worker.
      }
    }
  }

  publishEphemeral(type: LiveEventType, data: Record<string, unknown> = {}): void {
    const event: LiveEvent = { type, timestamp: new Date().toISOString(), data };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* live clients may disconnect between events */ }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
