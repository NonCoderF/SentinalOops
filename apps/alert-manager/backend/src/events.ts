export type LiveEventType = 'incident' | 'recovery' | 'notification' | 'heartbeat';

export interface LiveEvent {
  type: LiveEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: LiveEvent) => void;

/** In-process event fan-out for the single-container Alert Manager. */
export class EventHub {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(type: LiveEventType, data: Record<string, unknown> = {}): void {
    const event: LiveEvent = { type, timestamp: new Date().toISOString(), data };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected browser must not affect the poller or notification worker.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
