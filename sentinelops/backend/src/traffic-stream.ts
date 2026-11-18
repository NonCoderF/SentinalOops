import type { AlertDatabase } from './db.js';
import type { EventHub } from './events.js';

type PromRow = { metric: Record<string, string>; value?: [number, string] };
type PromResponse = { status?: string; data?: { result?: PromRow[] } };

const routeOf = (url: string) => { try { return new URL(url).pathname; } catch { return ''; } };

export function counterDelta(current: number, previous?: number): number {
  if (!Number.isFinite(current)) return 0;
  if (previous == null) return 0;
  return current >= previous ? current - previous : current;
}

async function query(prometheusUrl: string, expression: string): Promise<PromRow[]> {
  try {
    const response = await fetch(`${prometheusUrl}/api/v1/query?query=${encodeURIComponent(expression)}`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return [];
    const body = await response.json() as PromResponse;
    return body.status === 'success' ? body.data?.result ?? [] : [];
  } catch { return []; }
}

export function startTrafficStreaming(db: AlertDatabase, events: EventHub): () => void {
  let running = false;
  const previousCounters = new Map<string, number>();
  const previousErrorCounters = new Map<string, number>();
  const prometheusUrl = process.env.PROMETHEUS_URL ?? 'http://prometheus:9090';
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const registered = db.listMonitoredEndpoints().filter(endpoint => endpoint.enabled).map(endpoint => ({ application: endpoint.applicationName, method: endpoint.method, route: routeOf(endpoint.endpointUrl) }));
      if (!registered.length) return;
      const requestMetric = 'sentinelops_http_requests_total';
      const scope = new Set(registered.map(item => `${item.application}\u0000${item.method}\u0000${item.route}`));
      const [rates, counters, errorCounters] = await Promise.all([
        query(prometheusUrl, `sum by (application, method, route) (rate(${requestMetric}[4s]))`),
        query(prometheusUrl, `sum by (application, method, route) (${requestMetric})`),
        query(prometheusUrl, `sum by (application, method, route) (${requestMetric}{status_code=~"4..|5.."})`)
      ]);
      const deltaFor = (rows: PromRow[], key: string, previous: Map<string, number>) => {
        const value = Number(rows.find(row => `${row.metric.application ?? ''}\u0000${row.metric.method ?? ''}\u0000${row.metric.route ?? ''}` === key)?.value?.[1]);
        if (!Number.isFinite(value)) return 0;
        const old = previous.get(key);
        previous.set(key, value);
        return counterDelta(value, old);
      };
      for (const row of rates) {
        const application = row.metric.application ?? 'unknown';
        const method = row.metric.method ?? 'unknown';
        const route = row.metric.route ?? 'unknown';
        const key = `${application}\u0000${method}\u0000${route}`;
        if (!scope.has(key)) continue;
        const currentRps = Number(row.value?.[1]);
        if (!Number.isFinite(currentRps)) continue;
        const observedAt = row.value?.[0] ? new Date(row.value[0] * 1000).toISOString() : new Date().toISOString();
        events.publishEphemeral('traffic', { application, method, route, currentRps, requestCountDelta: Math.max(0, deltaFor(counters, key, previousCounters)), errorCountDelta: Math.max(0, deltaFor(errorCounters, key, previousErrorCounters)), dataSource: 'Prometheus application instrumentation', lastObservedSample: observedAt });
      }
    } finally { running = false; }
  };
  void poll();
  const timer = setInterval(() => void poll(), 1000);
  return () => clearInterval(timer);
}
