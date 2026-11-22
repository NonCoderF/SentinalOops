import crypto from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AlertDatabase, encryptSecret, type AlertRecord, type IncomingAlert, type NotificationSettings, type RecoveryActionType, type RecoveryMode, type RecoveryRunbook, type RecoveryControllerMode } from './db.js';
import { sendAlertEmail, sendTestEmail, validateEmail } from './email.js';
import { toAlertEvent, type AlertEvent } from './streaming.js';
import { EventHub } from './events.js';
import { controlContainer } from './recovery-controller.js';
import { ReadonlyKubernetesCommandRunner, readonlyCommands, type ReadonlyCommand } from './kubernetes-readonly.js';
import { readTestServiceStatus } from './test-service-status.js';
import { RecoveryModeManager, type RecoveryModeName } from './recovery-mode.js';
import websocket from '@fastify/websocket';
import { registerTerminalBridge } from './terminal-bridge.js';
import WebSocket from 'ws';
import { deployAgentThroughTerminal as deployAgentViaTerminal } from './kubernetes-agent-deployer.js';
import { runKubernetesSetup, type KubernetesSetupOperation } from './kubernetes-setup.js';

interface AlertmanagerPayload {
  alerts: IncomingAlert[];
}

type PromValue = number | null;
type PromSeries = { metric: Record<string, string>; value?: [number, string] };

async function prometheusJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}${path}`);
    if (!response.ok) return null;
    const body = await response.json() as { status?: string; data?: T };
    return body.status === 'success' ? body.data ?? null : null;
  } catch { return null; }
}

async function endpointStatus(url: string): Promise<'connected' | 'unavailable'> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok ? 'connected' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

type EndpointScope = 'external' | 'host' | 'docker';

function isPrivateIp(value: string): boolean {
  const ip = value.toLowerCase();
  return (isIP(ip) === 4 && (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('169.254.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) || ip === '0.0.0.0')) || (isIP(ip) === 6 && (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')));
}

function isLocalHostUrl(target: URL): boolean {
  const host = target.hostname.toLowerCase();
  return host === 'localhost' || host === 'host.docker.internal' || isPrivateIp(host);
}

const agentManifest = `apiVersion: v1
kind: Namespace
metadata:
  name: sentinelops-agent
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sentinelops-agent
  namespace: sentinelops-agent
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinelops-agent
  namespace: sentinelops-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sentinelops-agent
  template:
    metadata:
      labels:
        app: sentinelops-agent
    spec:
      serviceAccountName: sentinelops-agent
      containers:
        - name: agent
          image: sentinelops/kubernetes-agent:local
          imagePullPolicy: IfNotPresent
          env:
            - name: SENTINELOPS_BACKEND_URL
              value: http://host.docker.internal:3005
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 3
            periodSeconds: 15
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 128Mi
`;

function deployAgentThroughTerminal(context: string, clusterName: string, token: string): Promise<{ output: string; exitCode: number }> {
  const encoded = Buffer.from(agentManifest, 'utf8').toString('base64');
  const command = `printf '%s' '${encoded}' | base64 -d > /tmp/sentinelops-agent.yaml && kind load docker-image sentinelops/kubernetes-agent:local --name '${clusterName}' && kubectl --context '${context}' apply -f /tmp/sentinelops-agent.yaml; code=$?; printf '\\n__SENTINELOPS_AGENT_DEPLOY_DONE__:%s\\n' "$code"`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(process.env.KUBERNETES_TERMINAL_URL ?? 'ws://kubernetes-terminal:8787/terminal', { headers: { authorization: `Bearer ${token}` } });
    let output = '';
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Agent deployment timed out in the trusted terminal')); }, 120_000);
    const finish = (code: number) => { clearTimeout(timeout); socket.close(); resolve({ output, exitCode: code }); };
    socket.once('open', () => socket.send(JSON.stringify({ type: 'input', data: `${command}\n` })));
    socket.on('message', (data) => {
      const text = data.toString();
      output += text;
      const match = output.match(/__SENTINELOPS_AGENT_DEPLOY_DONE__:(\\d+)/);
      if (match) finish(Number(match[1]));
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(new Error(`Trusted terminal unavailable: ${error.message}`)); });
  });
}

function isLoopbackHost(target: URL): boolean {
  const host = target.hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function dockerHostAlternative(target: URL): string | null {
  const host = target.hostname.toLowerCase();
  if (host !== 'localhost' && !isPrivateIp(host)) return null;
  const alternative = new URL(target.toString());
  alternative.hostname = 'host.docker.internal';
  return alternative.toString();
}

async function validateEndpointUrl(value: string, allowInternal = false): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Endpoint URL must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS endpoints are supported');
  if (parsed.username || parsed.password) throw new Error('Credentials must be configured separately and cannot be included in the URL');
  const host = parsed.hostname.toLowerCase();
  if (host === 'metadata.google.internal' || host === '169.254.169.254') throw new Error('Cloud metadata destinations are not allowed');
  if (allowInternal) return parsed;
  if (host === 'localhost' || host === 'host.docker.internal' || isPrivateIp(host)) {
    throw new Error('This internal address requires explicit host or Docker network authorization');
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.some((address) => isPrivateIp(address.address))) throw new Error('This hostname resolves to an internal address. Explicit host or Docker network authorization is required');
  return parsed;
}

async function syncPrometheusTargets(db: AlertDatabase): Promise<void> {
  const destination = process.env.PROMETHEUS_FILE_SD_PATH;
  if (!destination) return;
  const targets = db.listMonitoredEndpoints().filter((endpoint) => endpoint.enabled).map((endpoint) => ({ targets: [endpoint.probeUrl || endpoint.endpointUrl], labels: { endpoint_id: String(endpoint.id), application: endpoint.applicationName, environment: endpoint.environment } }));
  await mkdir(destination.substring(0, destination.lastIndexOf('/')), { recursive: true });
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, destination);
  const metricsTarget = process.env.PROMETHEUS_METRICS_TARGET?.trim();
  const metricsPath = process.env.PROMETHEUS_METRICS_FILE_SD_PATH;
  if (metricsPath) {
    const metricsTargets = metricsTarget ? [{ targets: [metricsTarget], labels: { application: process.env.PROMETHEUS_METRICS_APPLICATION?.trim() || 'application' } }] : [];
    const metricsTemporary = `${metricsPath}.tmp`;
    await writeFile(metricsTemporary, `${JSON.stringify(metricsTargets, null, 2)}\n`, { mode: 0o644 });
    await rename(metricsTemporary, metricsPath);
  }
}

async function managedEndpoints(db: AlertDatabase): Promise<Array<Record<string, unknown>>> {
  const endpoints = db.listMonitoredEndpoints();
  const q = async (expr: string) => prometheusJson<{ result?: Array<{ metric: Record<string, string>; value?: [number, string] }> }>(`/api/v1/query?query=${encodeURIComponent(expr)}`);
  const [up, status, duration] = await Promise.all([q('probe_success'), q('probe_http_status_code'), q('probe_http_duration_seconds')]);
  const valueFor = (rows: typeof up, id: number) => rows?.result?.find((row) => row.metric.endpoint_id === String(id))?.value;
  return endpoints.map((endpoint) => {
    const healthy = valueFor(up, endpoint.id);
    const responseCode = valueFor(status, endpoint.id);
    const responseTime = valueFor(duration, endpoint.id);
    return {
      ...endpoint,
      monitoringStatus: healthy?.[1] === '1' ? 'UP' : healthy ? 'DOWN' : 'UNKNOWN',
      lastResponseCode: responseCode ? Number(responseCode[1]) : null,
      responseTimeSeconds: responseTime ? Number(responseTime[1]) : null,
      lastChecked: healthy ? new Date(healthy[0] * 1000).toISOString() : null
    };
  });
}

async function trafficData(range: string, db: AlertDatabase) {
  const windows: Record<string, { seconds: number; step: number; rate: string }> = {
    '5m': { seconds: 300, step: 5, rate: '30s' }, '15m': { seconds: 900, step: 10, rate: '30s' },
    '1h': { seconds: 3600, step: 30, rate: '1m' }, '6h': { seconds: 21600, step: 300, rate: '5m' }, '24h': { seconds: 86400, step: 900, rate: '15m' }
  };
  const selected = windows[range] ?? windows['15m'];
  const enabled = db.listMonitoredEndpoints().filter((endpoint) => endpoint.enabled);
  const applications = [...new Map(enabled.map((endpoint) => [endpoint.applicationName, enabled.filter((candidate) => candidate.applicationName === endpoint.applicationName)])).values()];
  const series = (await Promise.all(applications.map(async (endpoints) => {
    const application = endpoints[0].applicationName;
    const escapedApplication = application.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const query = `sum by (application, route) (rate(sentinelops_http_requests_total{application="${escapedApplication}"}[${selected.rate}]))`;
    const result = await prometheusJson<{ result?: Array<{ metric: Record<string, string>; values?: [number, string][] }> }>(`/api/v1/query_range?query=${encodeURIComponent(query)}&start=${(Date.now() / 1000 - selected.seconds).toFixed(0)}&end=${(Date.now() / 1000).toFixed(0)}&step=${selected.step}`);
    const rows = result?.result ?? [];
    const pointsFor = (selectedRows: typeof rows) => {
      const totals = new Map<number, number>();
      for (const row of selectedRows) for (const [time, value] of row.values ?? []) {
        const number = Number(value);
        if (Number.isFinite(number)) totals.set(time, (totals.get(time) ?? 0) + number);
      }
      return [...totals.entries()].sort(([a], [b]) => a - b);
    };
    const routeRows = new Map(endpoints.map((endpoint) => {
      let pathname = '';
      try { pathname = new URL(endpoint.endpointUrl).pathname; } catch { /* invalid historical URLs have no route match */ }
      return [endpoint.id, rows.filter((row) => row.metric.route === pathname)] as const;
    }));
    const hasRouteMetrics = [...routeRows.values()].some((matched) => matched.length > 0);
    if (!hasRouteMetrics) {
      const points = pointsFor(rows.filter((row) => !row.metric.route));
      return [{ applicationName: application, endpointId: endpoints[0].id, available: points.length > 0, points }];
    }
    return endpoints.map((endpoint) => {
      const points = pointsFor(routeRows.get(endpoint.id) ?? []);
      let route = '';
      try { route = new URL(endpoint.endpointUrl).pathname; } catch { /* displayed without route */ }
      return { applicationName: application, endpointId: endpoint.id, route, available: points.length > 0, points };
    });
  }))).flat();
  return { range: windows[range] ? range : '15m', series };
}

type PromRangeRow = { metric: Record<string, string>; values?: [number, string][] };
type PromInstantRow = { metric: Record<string, string>; value?: [number, string] };
const intelligenceWindows: Record<string, { seconds: number; step: number; rate: string }> = {
  '5m': { seconds: 300, step: 5, rate: '30s' }, '15m': { seconds: 900, step: 10, rate: '30s' },
  '1h': { seconds: 3600, step: 30, rate: '1m' }, '6h': { seconds: 21600, step: 300, rate: '5m' },
  '24h': { seconds: 86400, step: 900, rate: '15m' }, '7d': { seconds: 604800, step: 3600, rate: '1h' }
};
function promLabel(value: string): string { return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function finite(value: string | number | undefined): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function points(rows: PromRangeRow[]): Array<[number, number]> {
  const result = new Map<number, number>();
  for (const row of rows) for (const [time, value] of row.values ?? []) { const n = finite(value); if (n != null) result.set(time, (result.get(time) ?? 0) + n); }
  return [...result.entries()].sort(([a], [b]) => a - b);
}
function latest(rows: PromRangeRow[]): number | null { const values = rows.flatMap(row => row.values ?? []).map(([, value]) => finite(value)).filter((value): value is number => value != null); return values.length ? values[values.length - 1] : null; }
function statusCodeClass(code: string): '2xx' | '3xx' | '4xx' | '5xx' | 'other' { const n = Number(code); return n >= 200 && n < 300 ? '2xx' : n >= 300 && n < 400 ? '3xx' : n >= 400 && n < 500 ? '4xx' : n >= 500 && n < 600 ? '5xx' : 'other'; }

export function calculateTrafficSummary(points: Array<[number, number]>, totalRequests: number | null, totalErrors: number | null, requestedSeconds: number, step: number) {
  const timestamps = [...new Set(points.map(([timestamp]) => timestamp))].sort((a, b) => a - b);
  const coverageSeconds = timestamps.length > 1 ? Math.min(requestedSeconds, Math.max(step, timestamps[timestamps.length - 1] - timestamps[0])) : null;
  const values = points.map(([, value]) => value).filter(Number.isFinite);
  return {
    coverageSeconds,
    averageRps: totalRequests != null && coverageSeconds ? totalRequests / coverageSeconds : null,
    peakRps: values.length ? Math.max(...values) : null,
    errorPercent: totalRequests ? ((totalErrors ?? 0) / totalRequests) * 100 : totalRequests === 0 ? 0 : null
  };
}

export function summarizeTrafficStatus(rows: Array<{ statusCode: string; total: number }>) {
  return rows.reduce((summary, row) => {
    const group = statusCodeClass(row.statusCode);
    summary.total += Number.isFinite(row.total) ? row.total : 0;
    if (group === '2xx') summary.success += row.total;
    if (group === '4xx') summary.clientErrors += row.total;
    if (group === '5xx') summary.serverErrors += row.total;
    return summary;
  }, { total: 0, success: 0, clientErrors: 0, serverErrors: 0 });
}

async function trafficIntelligence(range: string, service: string | undefined, route: string | undefined, db: AlertDatabase) {
  const selected = intelligenceWindows[range] ?? intelligenceWindows['15m'];
  const selectedRange = intelligenceWindows[range] ? range : '15m';
  const registered = db.listMonitoredEndpoints().filter(endpoint => endpoint.enabled);
  const applications = [...new Set(registered.map(endpoint => endpoint.applicationName))];
  const routes = [...new Set(registered.map(endpoint => { try { return new URL(endpoint.endpointUrl).pathname; } catch { return ''; } }).filter(Boolean))];
  const application = service && applications.includes(service) ? service : undefined;
  const endpoint = route && routes.includes(route) ? route : undefined;
  const matcher = `${application ? `,application="${promLabel(application)}"` : ''}${endpoint ? `,route="${promLabel(endpoint)}"` : ''}`;
  const labels = matcher.slice(1);
  const metric = `sentinelops_http_requests_total{${labels}}`;
  const errorMetric = `sentinelops_http_requests_total{${labels ? `${labels},` : ''}status_code=~"4..|5.."}`;
  const histogram = `sentinelops_http_request_duration_seconds_bucket{${labels}}`;
  const now = Date.now() / 1000;
  const start = now - selected.seconds;
  const queryRange = async (query: string) => prometheusJson<{ result?: PromRangeRow[] }>(`/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start.toFixed(0)}&end=${now.toFixed(0)}&step=${selected.step}`);
  const queryInstant = async (query: string) => prometheusJson<{ result?: PromInstantRow[] }>(`/api/v1/query?query=${encodeURIComponent(query)}`);
  const [requestsResponse, requestTotalsResponse, errorsResponse, p50Response, p95Response, p99Response, statusResponse] = await Promise.all([
    queryRange(`sum by (application, method, route) (rate(${metric}[${selected.rate}]))`),
    queryInstant(`sum by (application, method, route) (increase(${metric}[${selectedRange}]))`),
    queryRange(`sum by (application, method, route) (rate(${errorMetric}[${selected.rate}]))`),
    queryRange(`histogram_quantile(0.50, sum by (application, method, route, le) (rate(${histogram}[${selected.rate}])))`),
    queryRange(`histogram_quantile(0.95, sum by (application, method, route, le) (rate(${histogram}[${selected.rate}])))`),
    queryRange(`histogram_quantile(0.99, sum by (application, method, route, le) (rate(${histogram}[${selected.rate}])))`),
    queryInstant(`sum by (application, route, method, status_code) (increase(${metric}[${selectedRange}]))`)
  ]);
  const requestRows = requestsResponse?.result ?? [], requestTotalRows = requestTotalsResponse?.result ?? [], errorRows = errorsResponse?.result ?? [];
  const p50Rows = p50Response?.result ?? [], p95Rows = p95Response?.result ?? [], p99Rows = p99Response?.result ?? [];
  const statusRows = statusResponse?.result ?? [];
  const routeKey = (labels: Record<string, string>) => `${labels.application ?? 'unknown'}\u0000${labels.method ?? 'unknown'}\u0000${labels.route ?? 'unknown'}`;
  const registeredKeys = new Set(registered.map(item => {
    let pathname = 'unknown';
    try { pathname = new URL(item.endpointUrl).pathname; } catch { /* invalid historical URLs remain out of scope */ }
    return `${item.applicationName}\u0000${item.method}\u0000${pathname}`;
  }));
  const inScope = (row: { metric: Record<string, string> }) => registeredKeys.has(routeKey(row.metric));
  const scopedRequestRows = requestRows.filter(inScope);
  const scopedRequestTotalRows = requestTotalRows.filter(inScope);
  const scopedErrorRows = errorRows.filter(inScope);
  const scopedStatusRows = statusRows.filter(inScope);
  const matching = (rows: PromRangeRow[], key: string) => rows.filter(row => routeKey(row.metric) === key);
  const requestSeries = new Map<string, Array<[number, number]>>();
  for (const row of scopedRequestRows) requestSeries.set(routeKey(row.metric), points([row]));
  const selectedSeries = [...requestSeries.entries()].map(([key, values]) => { const [name, method, path] = key.split('\u0000'); return { name, method, route: path, points: values }; });
  const endpointRows = new Map<string, { application: string; route: string; method: string; total: number; errors4xx: number; errors5xx: number }>();
  for (const row of scopedRequestTotalRows) {
    const applicationName = row.metric.application ?? 'unknown'; const path = row.metric.route ?? 'unknown'; const method = row.metric.method ?? 'unknown'; const key = `${applicationName}\u0000${method}\u0000${path}`; const value = finite(row.value?.[1]);
    if (value == null) continue; endpointRows.set(key, { application: applicationName, route: path, method, total: value, errors4xx: 0, errors5xx: 0 });
  }
  for (const row of scopedStatusRows) {
    const applicationName = row.metric.application ?? 'unknown'; const path = row.metric.route ?? 'unknown'; const method = row.metric.method ?? 'unknown'; const key = `${applicationName}\u0000${method}\u0000${path}`; const value = finite(row.value?.[1]);
    if (value == null) continue; const entry = endpointRows.get(key) ?? { application: applicationName, route: path, method, total: 0, errors4xx: 0, errors5xx: 0 }; const group = statusCodeClass(row.metric.status_code ?? ''); if (group === '4xx') entry.errors4xx += value; if (group === '5xx') entry.errors5xx += value; endpointRows.set(key, entry);
  }
  const endpoints = [...endpointRows.values()].filter(entry => registered.some(item => item.applicationName === entry.application && item.method === entry.method && (() => { try { return new URL(item.endpointUrl).pathname === entry.route; } catch { return false; } })())).map(entry => {
    const key = `${entry.application}\u0000${entry.method}\u0000${entry.route}`; const rps = requestSeries.get(key) ?? []; const values = rps.map(([, value]) => value); const p95 = latest(matching(p95Rows, key)); const p99 = latest(matching(p99Rows, key)); const totalErrors = entry.errors4xx + entry.errors5xx;
    return { ...entry, averageRps: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, peakRps: values.length ? Math.max(...values) : null, errorPercent: entry.total ? totalErrors / entry.total * 100 : null, p95Seconds: p95, p99Seconds: p99, lastObserved: rps.length ? new Date(rps[rps.length - 1][0] * 1000).toISOString() : null };
  }).sort((a, b) => b.total - a.total);
  const allRequestPoints = points(scopedRequestRows); const totalRequests = endpoints.length ? endpoints.reduce((sum, item) => sum + item.total, 0) : null; const totalErrors = endpoints.length ? endpoints.reduce((sum, item) => sum + item.errors4xx + item.errors5xx, 0) : null; const summaryMetrics = calculateTrafficSummary(allRequestPoints, totalRequests, totalErrors, selected.seconds, selected.step);
  const freshness = allRequestPoints.length ? new Date(allRequestPoints[allRequestPoints.length - 1][0] * 1000).toISOString() : null;
  return {
    range: selectedRange, service: application ?? 'all', route: endpoint ?? 'all', filters: { applications, routes }, source: 'Prometheus application instrumentation', freshness,
    supported: { requests: scopedRequestRows.length > 0, latency: p95Rows.length > 0, status: scopedStatusRows.length > 0, payloadSize: false, infrastructure: false },
    summary: { totalRequests, averageRps: summaryMetrics.averageRps, peakRps: summaryMetrics.peakRps, errorPercent: summaryMetrics.errorPercent, coverageSeconds: summaryMetrics.coverageSeconds, p50Seconds: endpoint ? latest(p50Rows.filter(row => inScope(row))) : null, p95Seconds: endpoint ? latest(p95Rows.filter(row => inScope(row))) : null, p99Seconds: endpoint ? latest(p99Rows.filter(row => inScope(row))) : null, availability: null, averageResponseBytes: null },
    series: { requestsPerSecond: selectedSeries, errorsPerSecond: scopedErrorRows.map(row => ({ name: row.metric.application ?? 'unknown', method: row.metric.method ?? 'unknown', route: row.metric.route ?? 'unknown', points: points([row]) })), p50: p50Rows.filter(inScope).map(row => ({ name: row.metric.application ?? 'unknown', method: row.metric.method ?? 'unknown', route: row.metric.route ?? 'unknown', points: points([row]) })), p95: p95Rows.filter(inScope).map(row => ({ name: row.metric.application ?? 'unknown', method: row.metric.method ?? 'unknown', route: row.metric.route ?? 'unknown', points: points([row]) })), p99: p99Rows.filter(inScope).map(row => ({ name: row.metric.application ?? 'unknown', method: row.metric.method ?? 'unknown', route: row.metric.route ?? 'unknown', points: points([row]) })) },
    status: scopedStatusRows.map(row => ({ application: row.metric.application ?? 'unknown', route: row.metric.route ?? 'unknown', method: row.metric.method ?? 'unknown', statusCode: row.metric.status_code ?? 'unknown', total: finite(row.value?.[1]) ?? 0 })), endpoints,
    infrastructure: { cpu: null, memory: null, networkReceive: null, networkTransmit: null, restartCount: null, replicaCount: null, availability: null }
  };
}

function requestedScope(value: unknown): EndpointScope {
  return value === 'host' || value === 'docker' ? value : 'external';
}

async function resolveProbeTarget(body: Record<string, unknown>): Promise<{ displayUrl: URL; probeUrl: URL; scope: EndpointScope; suggestedUrl?: string }> {
  const displayUrl = await validateEndpointUrl(typeof body.endpointUrl === 'string' ? body.endpointUrl.trim() : '', true);
  const explicitScope = requestedScope(body.networkScope);
  const scope: EndpointScope = (displayUrl.hostname.toLowerCase() === 'host.docker.internal' || isLoopbackHost(displayUrl)) && explicitScope === 'external' ? 'host' : explicitScope;
  const suggestedUrl = dockerHostAlternative(displayUrl) ?? undefined;
  const requestedProbe = typeof body.probeUrl === 'string' && body.probeUrl.trim() ? body.probeUrl.trim() : '';
  if (isLocalHostUrl(displayUrl) && explicitScope === 'external') {
    const message = suggestedUrl
      ? `This address points to the SentinelOps container. Is your API running on the Docker host? Use ${suggestedUrl} as the Docker probe URL and authorize host access.`
      : 'This internal address requires explicit host or Docker network authorization.';
    const error = new Error(message) as Error & { code?: string; suggestedUrl?: string };
    error.code = 'INTERNAL_TARGET_REQUIRES_AUTHORIZATION'; error.suggestedUrl = suggestedUrl;
    throw error;
  }
  const probeUrl = await validateEndpointUrl(requestedProbe || (scope === 'host' ? (suggestedUrl ?? displayUrl.toString()) : displayUrl.toString()), scope !== 'external');
  return { displayUrl, probeUrl, scope, suggestedUrl };
}

async function probeBlackboxTarget(target: URL): Promise<{ reachable: boolean; detail: string }> {
  const base = process.env.BLACKBOX_EXPORTER_URL ?? 'http://blackbox-exporter:9115';
  try {
    const response = await fetch(`${base}/probe?module=http_2xx&target=${encodeURIComponent(target.toString())}`, { signal: AbortSignal.timeout(7000) });
    const text = await response.text();
    const success = /probe_success\s+1(?:\D|$)/.test(text);
    return { reachable: response.ok && success, detail: success ? 'Blackbox Exporter reached the target' : 'Blackbox Exporter could not reach the target' };
  } catch (error) { return { reachable: false, detail: error instanceof Error ? `Blackbox Exporter error: ${error.message}` : 'Blackbox Exporter request failed' }; }
}

function instantValue(data: { result?: Array<{ value?: [number, string] }> } | null, labels?: Record<string, string>): PromValue {
  const row = data?.result?.find((entry) => !labels || Object.entries(labels).every(([key, value]) => entry.value && value === String(value))) ?? data?.result?.[0];
  const value = row?.value?.[1];
  const number = value === undefined ? null : Number(value);
  return number !== undefined && Number.isFinite(number) ? number : null;
}

async function dashboardData(range: string, db: AlertDatabase) {
  const allowed = new Set(['5m', '15m', '1h', '6h', '24h']);
  const window = allowed.has(range) ? range : '15m';
  const step = ({ '5m': 5, '15m': 10, '1h': 30, '6h': 300, '24h': 900 } as Record<string, number>)[window];
  const q = (expr: string) => prometheusJson<{ result?: Array<{ metric: Record<string, string>; value?: [number, string] }> }>(`/api/v1/query?query=${encodeURIComponent(expr)}`);
  const rq = (expr: string) => prometheusJson<{ result?: Array<{ metric: Record<string, string>; values?: [number, string][] }> }>(`/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${(Date.now() / 1000 - ({ '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 } as Record<string, number>)[window]).toFixed(0)}&end=${(Date.now() / 1000).toFixed(0)}&step=${step}`);
  const [up, cpu, memory, requestRate, errorRate, latency, availability, rangeCpu, rangeMemory, rangeRequests, rangeLatency, rangeErrors, rangeAvailability, connections, settings] = await Promise.all([
    q('up'), q('sum by (job) (rate(sentinelops_process_cpu_user_seconds_total[30s]) + rate(sentinelops_process_cpu_system_seconds_total[30s]))'),
    q('sentinelops_process_resident_memory_bytes'), q('sum by (job, route) (rate(sentinelops_http_requests_total[30s]))'),
    q('sum by (job, route) (rate(sentinelops_http_requests_total{status_code=~"5.."}[30s]))'),
    q('histogram_quantile(0.95, sum by (job, route, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    q('avg by (job) (avg_over_time(up[15m]))'),
    rq('sum by (job) (rate(sentinelops_process_cpu_user_seconds_total[30s]) + rate(sentinelops_process_cpu_system_seconds_total[30s]))'),
    rq('sentinelops_process_resident_memory_bytes'), rq('sum by (job, route) (rate(sentinelops_http_requests_total[30s]))'),
    rq('histogram_quantile(0.95, sum by (job, route, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    rq('sum by (job, route) (rate(sentinelops_http_requests_total{status_code=~"5.."}[30s]))'), rq('avg by (job) (avg_over_time(up[15m]))'),
    Promise.all([
      `${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}/-/ready`,
      `${process.env.GRAFANA_URL ?? 'http://grafana:3000'}/api/health`,
      `${process.env.RECOVERY_CONTROLLER_URL ?? 'http://recovery-controller:8090'}/health`
    ].map(endpointStatus)),
    Promise.resolve(db.getSettings())
  ]);
  const [latencyP50, latencyP99, rangeLatencyP50, rangeLatencyP99] = await Promise.all([
    q('histogram_quantile(0.50, sum by (job, route, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    q('histogram_quantile(0.99, sum by (job, route, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    rq('histogram_quantile(0.50, sum by (job, route, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    rq('histogram_quantile(0.99, sum by (job, route, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))')
  ]);
  // Load-test metrics are an auxiliary observability target, not a monitored application service.
  const upRows = (up?.result ?? []).filter((row) => row.metric.job !== 'sentinelops-load-test');
  const alerts = db.listAlerts({});
  const metric = (rows: typeof upRows, job: string) => instantValue({ result: rows.filter((row) => row.metric.job === job) });
  const series = (data: { result?: Array<{ metric: Record<string, string>; values?: [number, string][] }> } | null) => (data?.result ?? []).map((row) => ({ job: row.metric.job ?? 'unknown', route: row.metric.route, points: (row.values ?? []).map(([time, value]) => [time, Number(value)]).filter((point) => Number.isFinite(point[1])) }));
  const services = upRows.map((row) => { const job = row.metric.job ?? 'unknown'; const serviceName = row.metric.application ?? job; const lastFailure = alerts.filter((alert) => alert.labels.service === serviceName).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))[0]; return { name: serviceName, job, status: row.value?.[1] === '1' ? 'UP' : 'DOWN', cpu: metric(cpu?.result ?? [], job), memory: metric(memory?.result ?? [], job), requests: metric(requestRate?.result ?? [], job), errors: metric(errorRate?.result ?? [], job), latency: metric(latency?.result ?? [], job), availability: metric(availability?.result ?? [], job), checkedAt: row.value?.[0] ? new Date(row.value[0] * 1000).toISOString() : null, lastFailure: lastFailure?.firstSeenAt ?? null }; });
  const deliveries = db.listEmails();
  const executions = db.recoveryExecutions();
  const active = alerts.filter((alert) => alert.status === 'firing').length;
  const success = executions.filter((run) => run.status === 'SUCCESS');
  const finished = executions.filter((run) => ['SUCCESS', 'FAILED', 'TIMED_OUT'].includes(String(run.status)));
  const durations = finished.map((run) => run.completed_at && run.started_at ? new Date(String(run.completed_at)).getTime() - new Date(String(run.started_at)).getTime() : 0).filter((value) => value > 0);
  const journal = db.dashboardEvents({ limit: 200 });
  const activity = journal.map((event) => { let metadata: Record<string, unknown> = {}; try { metadata = JSON.parse(String(event.metadata_json)) as Record<string, unknown>; } catch { /* old/corrupt metadata is displayed without detail */ } return { id: String(event.event_id), type: String(event.event_type), label: `${String(event.event_type).toUpperCase()} Â· ${String(event.status ?? 'RECORDED')}`, detail: `${String(event.service_id ?? 'unknown service')} Â· ${String(metadata.alertName ?? metadata.actionType ?? metadata.subject ?? '')}`.trim(), at: String(event.occurred_at), incidentId: event.incident_id, severity: event.severity, status: event.status, metadata }; });
  const resolved = alerts.filter((alert) => alert.status === 'resolved' && alert.resolvedAt);
  const incidentDurations = resolved.map((alert) => new Date(alert.resolvedAt as string).getTime() - new Date(alert.firstSeenAt).getTime()).filter((value) => value >= 0);
  const mttd = null;
  const mttr = incidentDurations.length ? incidentDurations.reduce((sum, value) => sum + value, 0) / incidentDurations.length : null;
  const healthy = services.filter((service) => service.status === 'UP').length;
  const unhealthy = services.filter((service) => service.status === 'DOWN').length;
  const sent = deliveries.filter((delivery) => delivery.status === 'sent').length;
  const failedEmails = deliveries.filter((delivery) => delivery.status === 'failed').length;
  const notificationAttempts = sent + failedEmails;
  const averageRequests = services.length ? services.reduce((sum, service) => sum + (service.requests ?? 0), 0) : null;
  const averageLatency = services.length ? services.reduce((sum, service) => sum + (service.latency ?? 0), 0) / services.length : null;
  const lastPrometheusScrape = services.map((service) => service.checkedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const monitoringStatus = !services.length || connections?.[0] !== 'connected' ? 'UNKNOWN' : unhealthy > 0 || active > 0 ? 'CRITICAL' : connections?.some((value) => value !== 'connected') ? 'DEGRADED' : 'HEALTHY';
  const runbooks = db.listRunbooks();
  const latestRecovery = success.find((run) => run.completed_at) ?? null;
  return { generatedAt: new Date().toISOString(), range: window, infrastructureStatus: monitoringStatus, lastPrometheusScrape, monitoringInterval: '2s', services, charts: { cpu: series(rangeCpu), memory: series(rangeMemory), requests: series(rangeRequests), latency: series(rangeLatency), latencyP50: series(rangeLatencyP50), latencyP99: series(rangeLatencyP99), errors: series(rangeErrors), availability: series(rangeAvailability) }, connections: { prometheus: connections?.[0], grafana: connections?.[1], recoveryController: connections?.[2], sentinelops: 'connected' }, summary: { total: services.length, healthy, unhealthy, active, critical: alerts.filter((alert) => alert.status === 'firing' && alert.labels.severity === 'critical').length, warning: alerts.filter((alert) => alert.status === 'firing' && alert.labels.severity === 'warning').length, resolved: resolved.length, recoveries: success.length, failedRecoveries: executions.filter((run) => ['FAILED', 'TIMED_OUT'].includes(String(run.status))).length, availability: services.length ? services.reduce((sum, service) => sum + (service.availability ?? 0), 0) / services.length : null, currentRequestsPerSecond: averageRequests, averageResponseLatencySeconds: averageLatency, recoveryAttempts: executions.length, averageRecoveryDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null, runningRecoveries: executions.filter((run) => ['RUNNING', 'PENDING'].includes(String(run.status))).length, availableRunbooks: runbooks.filter((runbook) => runbook.enabled).length, totalIncidents: alerts.length, resolvedIncidents: resolved.length, unresolvedIncidents: active, averageIncidentDurationMs: incidentDurations.length ? incidentDurations.reduce((sum, value) => sum + value, 0) / incidentDurations.length : null, recoverySuccessRate: executions.length ? success.length / executions.length : null, notificationSuccessRate: notificationAttempts ? sent / notificationAttempts : null, mttdMs: mttd, mttrMs: mttr }, alerts, deliveries: deliveries.slice(0, 12), executions: executions.slice(0, 12), latestRecovery, email: { enabled: settings.enabled, smtpConfigured: Boolean(settings.smtpHost && settings.fromEmail), lastAttempt: deliveries[0]?.createdAt ?? null, sent, failed: failedEmails, lastError: deliveries.find((delivery) => delivery.status === 'failed')?.error ?? null }, activity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const values = Object.values(value);
  if (values.some((item) => typeof item !== 'string')) return null;
  return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}

export function parseAlertmanagerPayload(body: unknown): AlertmanagerPayload | null {
  if (!isRecord(body) || !Array.isArray(body.alerts)) return null;
  const alerts: IncomingAlert[] = [];
  for (const raw of body.alerts) {
    if (!isRecord(raw)) return null;
    if (raw.status !== 'firing' && raw.status !== 'resolved') return null;
    const labels = stringMap(raw.labels);
    const annotations = stringMap(raw.annotations);
    if (!labels || !annotations || typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0) return null;
    alerts.push({
      status: raw.status,
      labels,
      annotations,
      fingerprint: raw.fingerprint,
      startsAt: typeof raw.startsAt === 'string' ? raw.startsAt : undefined,
      endsAt: typeof raw.endsAt === 'string' ? raw.endsAt : undefined
    });
  }
  return { alerts };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const query = request.query as { token?: unknown };
  return typeof query?.token === 'string' ? query.token : undefined;
}

function publicSettings(settings: NotificationSettings) {
  return {
    enabled: settings.enabled,
    notifyFiring: settings.notifyFiring,
    notifyResolved: settings.notifyResolved,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecure: settings.smtpSecure,
    smtpUsername: settings.smtpUsername,
    smtpPasswordConfigured: settings.smtpPassword.length > 0,
    fromEmail: settings.fromEmail,
    recipients: settings.recipients,
    severityFilter: settings.severityFilter,
    firingSubject: settings.firingSubject,
    firingBody: settings.firingBody,
    resolvedSubject: settings.resolvedSubject,
    resolvedBody: settings.resolvedBody,
    content: settings.content
  };
}

function validateSettings(body: Record<string, unknown>, current: NotificationSettings): { settings?: NotificationSettings; errors: string[] } {
  const smtpHost = typeof body.smtpHost === 'string' ? body.smtpHost.trim() : current.smtpHost;
  const smtpPort = typeof body.smtpPort === 'number' ? body.smtpPort : Number(body.smtpPort ?? current.smtpPort);
  const smtpUsername = typeof body.smtpUsername === 'string' ? body.smtpUsername.trim() : current.smtpUsername;
  const smtpPassword = typeof body.smtpPassword === 'string' ? body.smtpPassword : current.smtpPassword;
  const fromEmail = typeof body.fromEmail === 'string' ? body.fromEmail.trim() : current.fromEmail;
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.flatMap((item) => typeof item === 'string' ? item.split(',') : []).map((item) => item.trim()).filter(Boolean)
    : typeof body.recipients === 'string'
      ? body.recipients.split(',').map((item) => item.trim()).filter(Boolean)
      : current.recipients;
  const severityFilter = Array.isArray(body.severityFilter) ? body.severityFilter.filter((item): item is string => typeof item === 'string') : current.severityFilter;
  const firingSubject = typeof body.firingSubject === 'string' ? body.firingSubject.trim() : current.firingSubject;
  const firingBody = typeof body.firingBody === 'string' ? body.firingBody : current.firingBody;
  const resolvedSubject = typeof body.resolvedSubject === 'string' ? body.resolvedSubject.trim() : current.resolvedSubject;
  const resolvedBody = typeof body.resolvedBody === 'string' ? body.resolvedBody : current.resolvedBody;
  const content = typeof body.content === 'string' ? body.content : current.content;
  const errors: string[] = [];
  if (!smtpHost) errors.push('SMTP host is required');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) errors.push('SMTP port must be between 1 and 65535');
  if (!validateEmail(fromEmail)) errors.push('A valid sender email is required');
  if (recipients.length === 0 || recipients.some((recipient) => !validateEmail(recipient))) errors.push('At least one valid recipient email is required');
  if (severityFilter.some((severity) => !['critical', 'warning', 'info'].includes(severity))) errors.push('Severity filters must be critical, warning, or info');
  if (errors.length > 0) return { errors };
  return {
    errors,
    settings: {
      enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
      notifyFiring: body.notifyFiring === undefined ? current.notifyFiring : Boolean(body.notifyFiring),
      notifyResolved: body.notifyResolved === undefined ? current.notifyResolved : Boolean(body.notifyResolved),
      smtpHost, smtpPort, smtpSecure: body.smtpSecure === undefined ? current.smtpSecure : Boolean(body.smtpSecure),
      smtpUsername, smtpPassword, fromEmail, recipients, severityFilter, firingSubject, firingBody, resolvedSubject, resolvedBody, content
    }
  };
}

const recoveryActions = new Set<RecoveryActionType>(['RESTART_CONTAINER','START_CONTAINER','CHECK_CONTAINER_STATUS','HTTP_HEALTH_CHECK']);
function parseRunbook(body: unknown) {
  if (!isRecord(body)) return { error: 'Runbook body must be an object' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const service = typeof body.service === 'string' ? body.service.trim() : '';
  const actionType = body.actionType as RecoveryActionType;
  const mode: RecoveryMode = body.mode === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL';
  const parameters = isRecord(body.parameters) && Object.values(body.parameters).every((value) => typeof value === 'string') ? body.parameters as Record<string, string> : {};
  const endpoint = typeof body.verificationEndpoint === 'string' ? body.verificationEndpoint.trim() : '/health';
  const allowedService = process.env.RECOVERY_ALLOWED_SERVICE?.trim();
  if (!name || name.length > 100) return { error: 'Runbook name is required and must be at most 100 characters' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(service)) return { error: 'Service must be a valid registered service name' };
  if (allowedService && service !== allowedService) return { error: 'This service is not enabled for recovery' };
  if (!recoveryActions.has(actionType)) return { error: 'Unsupported recovery action' };
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*$/.test(endpoint)) return { error: 'Verification endpoint must be a relative HTTP path' };
  if (Object.values(parameters).some((value) => /[;&|`$<>\r\n]/.test(value))) return { error: 'Command metacharacters are not allowed' };
  const integer = (value: unknown, fallback: number, min: number, max: number) => { const number = typeof value === 'number' ? value : Number(value ?? fallback); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; };
  return { value: { name, description: typeof body.description === 'string' ? body.description.slice(0, 1000) : '', service, actionType, parameters, timeoutSeconds: integer(body.timeoutSeconds, 30, 1, 300), verificationEndpoint: endpoint, maxAttempts: integer(body.maxAttempts, 1, 1, 5), cooldownSeconds: integer(body.cooldownSeconds, 300, 0, 86400), mode, enabled: body.enabled === undefined ? true : Boolean(body.enabled) } };
}
async function verifyService(runbook: RecoveryRunbook, timeoutMs: number): Promise<boolean> {
  const base = runbook.parameters.healthUrl ?? process.env.RECOVERY_HEALTH_URL ?? 'http://host.docker.internal:8080/api/health';
  if (!base) return false;
  try { const response = await fetch(new URL(runbook.verificationEndpoint, base).toString(), { signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)) }); return response.ok; } catch { return false; }
}

async function runRecovery(executionId: number, runbook: RecoveryRunbook, db: AlertDatabase, events?: EventHub): Promise<void> {
  const started = Date.now();
  const output: string[] = [];
  try {
    if (runbook.actionType === 'HTTP_HEALTH_CHECK') output.push('No Docker state change requested; verifying the configured health endpoint.');
    else {
      const controllerResult = await controlContainer(runbook.actionType, runbook.service, runbook.timeoutSeconds * 1000);
      output.push(`Docker controller: ${JSON.stringify(controllerResult)}`);
    }
    let successes = 0;
    while (Date.now() - started < runbook.timeoutSeconds * 1000) {
      if (await verifyService(runbook, 5000)) successes += 1; else successes = 0;
      if (successes >= 2) { db.finishRecoveryExecution(executionId, 'SUCCESS', `${output.join('\n')}\nHealth verification passed twice.`); events?.publish('recovery', { executionId, status: 'SUCCESS', service: runbook.service, actionType: runbook.actionType }); return; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    db.finishRecoveryExecution(executionId, 'TIMED_OUT', `${output.join('\n')}\nHealth verification timed out.`);
    events?.publish('recovery', { executionId, status: 'TIMED_OUT', service: runbook.service, actionType: runbook.actionType });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Recovery failed';
    db.finishRecoveryExecution(executionId, 'FAILED', `${output.join('\n')}\n${message}`);
    events?.publish('recovery', { executionId, status: 'FAILED', service: runbook.service, actionType: runbook.actionType, error: message });
  }
}

function triggerAutomaticRecovery(alert: IncomingAlert, db: AlertDatabase, events?: EventHub, recoveryMode?: RecoveryModeManager): void {
  if (recoveryMode && !recoveryMode.isActive('MANUAL')) return;
  if (alert.status !== 'firing' || !alert.labels.service) return;
  const runbook = db.listRunbooks().find((candidate) => candidate.enabled && candidate.mode === 'AUTOMATIC' && candidate.service === alert.labels.service);
  if (!runbook || db.activeRecoveryForService(runbook.service)) return;
  const executionId = db.createRecoveryExecution(runbook, 'AUTOMATIC', `Triggered by ${alert.labels.alertname ?? 'service alert'}.`);
  events?.publish('recovery', { executionId, runbookId: runbook.id, status: 'RUNNING', service: runbook.service, actionType: runbook.actionType });
  void runRecovery(executionId, runbook, db, events);
}


export function buildAlertManagerApp(options: { db: AlertDatabase; adminToken: string; webhookToken: string; dashboardUrl?: string; authEnabled?: boolean; publisher?: { publish(event: AlertEvent): Promise<void>; isConnected?: () => boolean }; events?: EventHub }): FastifyInstance {
  const { db, adminToken, webhookToken, dashboardUrl, authEnabled = process.env.AUTH_ENABLED === 'true', publisher, events } = options;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'sentinelops-alert-manager' }, redact: ['req.headers.authorization', 'req.query.token', 'body.smtpPassword'] } });
  const transitionLocks = new Set<string>();
  const kubernetesRecoveryLocks = new Set<string>();
  let lastCapacityDiagnostic = '';
  const kubernetesCommands = new ReadonlyKubernetesCommandRunner();
  const recoveryMode = new RecoveryModeManager(db);

  void app.register(cors, { origin: ['http://localhost:3005', 'http://127.0.0.1:3005'] });
  void app.register(rateLimit, { global: false });
  void app.register(websocket);

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authEnabled) return;
    if (!tokenFromRequest(request) || !safeEqual(tokenFromRequest(request) as string, adminToken)) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  };

  void app.register(async (terminalScope) => {
    registerTerminalBridge(terminalScope, {
      authEnabled,
      adminToken,
      terminalUrl: process.env.KUBERNETES_TERMINAL_URL,
      terminalToken: process.env.KUBERNETES_TERMINAL_TOKEN ?? 'local-terminal-token'
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'sentinelops-alert-manager', uptime: process.uptime() }));
  app.get('/ready', async (_request, reply) => {
    try {
      if (!db.check()) return reply.code(503).send({ status: 'not_ready' });
      return { status: 'ready', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'not_ready', database: 'error' });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const token = typeof body.token === 'string' ? body.token : '';
    return !authEnabled || safeEqual(token, adminToken) ? { authenticated: true } : reply.code(401).send({ error: 'Invalid token' });
  });

  app.get('/api/setup/status', async () => {
    const check = async (url: string): Promise<boolean> => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
    const [prometheus, grafana, blackbox] = await Promise.all([
      check(`${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}/-/ready`),
      check(`${process.env.GRAFANA_URL ?? 'http://grafana:3000'}/api/health`),
      check(`${process.env.BLACKBOX_EXPORTER_URL ?? 'http://blackbox-exporter:9115'}/metrics`)
    ]);
    return { configured: db.getInstallationState('monitoring_configured') === 'true', administratorCreated: db.getInstallationState('administrator_created') === 'true', authRequired: authEnabled, components: { sentinelops: true, prometheus, grafana, blackboxExporter: blackbox }, endpoints: db.listMonitoredEndpoints().map(({ authType, ...endpoint }) => ({ ...endpoint, authConfigured: authType !== 'none' })) };
  });

  app.post('/api/setup/bootstrap', async (request, reply) => {
    if (db.getInstallationState('administrator_created') === 'true') return reply.code(409).send({ error: 'Administrator setup has already been completed' });
    const supplied = request.headers['x-setup-token'];
    const setupToken = process.env.SETUP_TOKEN ?? '';
    if (authEnabled && (!setupToken || typeof supplied !== 'string' || !safeEqual(supplied, setupToken))) return reply.code(401).send({ error: 'A valid one-time setup token is required' });
    db.setInstallationState('administrator_created', 'true');
    return { authenticated: true, token: adminToken };
  });

  app.get('/api/setup/endpoints', { preHandler: requireAdmin }, async () => ({ endpoints: (await managedEndpoints(db)).map(({ authType, ...endpoint }) => ({ ...endpoint, authConfigured: authType !== 'none' })) }));

  app.post('/api/setup/endpoints/test', { preHandler: requireAdmin }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    try {
      const resolved = await resolveProbeTarget(body);
      const method = body.method === 'HEAD' ? 'HEAD' : 'GET';
      const response = await fetch(resolved.probeUrl, { method, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const backendReachable = response.status === Number(body.expectedStatus ?? 200);
      const blackbox = await probeBlackboxTarget(resolved.probeUrl);
      return { reachable: backendReachable && blackbox.reachable, backendReachable, blackboxReachable: blackbox.reachable, blackboxDetail: blackbox.detail, status: response.status, statusText: response.statusText, probeUrl: resolved.probeUrl.toString(), suggestedUrl: resolved.suggestedUrl };
    } catch (error) {
      const detail = error as Error & { code?: string; suggestedUrl?: string };
      return reply.code(detail.code === 'INTERNAL_TARGET_REQUIRES_AUTHORIZATION' ? 409 : 400).send({ error: detail.message || 'Endpoint validation failed', code: detail.code, suggestedUrl: detail.suggestedUrl });
    }
  });

  app.post('/api/setup/endpoints', { preHandler: requireAdmin }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    try {
      const resolved = await resolveProbeTarget(body);
      const method = body.method === 'HEAD' ? 'HEAD' : 'GET';
      const expectedStatus = Number(body.expectedStatus ?? 200);
      const intervalSeconds = Number(body.intervalSeconds ?? 30);
      const environment = ['production', 'staging', 'development'].includes(String(body.environment)) ? String(body.environment) as 'production'|'staging'|'development' : 'production';
      if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new Error('Expected status must be between 100 and 599');
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) throw new Error('Monitoring interval must be between 5 and 3600 seconds');
      const authType = ['bearer', 'basic'].includes(String(body.authType)) ? String(body.authType) as 'bearer'|'basic' : 'none';
      const endpoint = db.saveMonitoredEndpoint({ applicationName: typeof body.applicationName === 'string' && body.applicationName.trim() ? body.applicationName.trim().slice(0, 120) : resolved.displayUrl.hostname, endpointUrl: resolved.displayUrl.toString(), probeUrl: resolved.probeUrl.toString(), networkScope: resolved.scope, method, expectedStatus, intervalSeconds, environment, authType, enabled: body.enabled !== false, authSecretEncrypted: typeof body.authSecret === 'string' && body.authSecret ? encryptSecret(body.authSecret, process.env.SETTINGS_ENCRYPTION_KEY ?? adminToken) : undefined });
      await syncPrometheusTargets(db);
      return reply.code(201).send({ endpoint: { ...endpoint, authConfigured: authType !== 'none' } });
    } catch (error) { const detail = error as Error & { code?: string; suggestedUrl?: string }; return reply.code(detail.code === 'INTERNAL_TARGET_REQUIRES_AUTHORIZATION' ? 409 : 400).send({ error: detail.message || 'Invalid endpoint', code: detail.code, suggestedUrl: detail.suggestedUrl }); }
  });

  app.put('/api/setup/endpoints/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const existing = db.listMonitoredEndpoints().find((endpoint) => endpoint.id === id);
    if (!existing) return reply.code(404).send({ error: 'Endpoint not found' });
    const body = isRecord(request.body) ? request.body : {};
    try {
      const resolved = await resolveProbeTarget({ ...body, endpointUrl: typeof body.endpointUrl === 'string' ? body.endpointUrl.trim() : existing.endpointUrl, probeUrl: typeof body.probeUrl === 'string' ? body.probeUrl : existing.probeUrl, networkScope: body.networkScope ?? existing.networkScope });
      const method = body.method === 'HEAD' ? 'HEAD' : body.method === 'GET' ? 'GET' : existing.method;
      const expectedStatus = Number(body.expectedStatus ?? existing.expectedStatus);
      const intervalSeconds = Number(body.intervalSeconds ?? existing.intervalSeconds);
      if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new Error('Expected status must be between 100 and 599');
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) throw new Error('Monitoring interval must be between 5 and 3600 seconds');
      const endpoint = db.saveMonitoredEndpoint({ id, applicationName: typeof body.applicationName === 'string' && body.applicationName.trim() ? body.applicationName.trim().slice(0, 120) : existing.applicationName, endpointUrl: resolved.displayUrl.toString(), probeUrl: resolved.probeUrl.toString(), networkScope: resolved.scope, method, expectedStatus, intervalSeconds, environment: (['production', 'staging', 'development'].includes(String(body.environment)) ? String(body.environment) : existing.environment) as 'production'|'staging'|'development', authType: (['bearer', 'basic'].includes(String(body.authType)) ? String(body.authType) : existing.authType) as 'none'|'bearer'|'basic', enabled: body.enabled === undefined ? existing.enabled : Boolean(body.enabled), authSecretEncrypted: typeof body.authSecret === 'string' && body.authSecret ? encryptSecret(body.authSecret, process.env.SETTINGS_ENCRYPTION_KEY ?? adminToken) : undefined });
      await syncPrometheusTargets(db);
      return { endpoint: { ...endpoint, authConfigured: endpoint.authType !== 'none' } };
    } catch (error) { const detail = error as Error & { code?: string; suggestedUrl?: string }; return reply.code(detail.code === 'INTERNAL_TARGET_REQUIRES_AUTHORIZATION' ? 409 : 400).send({ error: detail.message || 'Invalid endpoint', code: detail.code, suggestedUrl: detail.suggestedUrl }); }
  });

  app.delete('/api/setup/endpoints/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!db.deleteMonitoredEndpoint(id)) return reply.code(404).send({ error: 'Endpoint not found' });
    await syncPrometheusTargets(db);
    return { deleted: true };
  });

  app.post('/api/setup/activate', { preHandler: requireAdmin }, async (_request, reply) => {
    if (db.listMonitoredEndpoints().length === 0) return reply.code(400).send({ error: 'Register at least one endpoint before activating monitoring' });
    await syncPrometheusTargets(db);
    db.setInstallationState('monitoring_configured', 'true');
    return { configured: true };
  });

  app.get('/api/events/stream', async (request, reply) => {
    if (authEnabled && (!tokenFromRequest(request) || !safeEqual(tokenFromRequest(request) as string, adminToken))) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = (event: { type: string; timestamp: string; data: Record<string, unknown> }) => {
      if (!response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'heartbeat', timestamp: new Date().toISOString(), data: {} });
    const unsubscribe = events?.subscribe(send) ?? (() => undefined);
    const heartbeat = setInterval(() => send({ type: 'heartbeat', timestamp: new Date().toISOString(), data: {} }), 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once('close', cleanup);
  });

  app.get('/api/kubernetes/config', { preHandler: requireAdmin }, async () => ({
    context: kubernetesCommands.context,
    namespace: kubernetesCommands.namespace,
    commands: readonlyCommands
  }));
  app.get('/api/test-service/status', { preHandler: requireAdmin }, async () => readTestServiceStatus());
  app.get('/api/kubernetes/agent/config', async (request, reply) => {
    const policy = db.getKubernetesAgentPolicy();
    const agentProbeHost = process.env.KUBERNETES_AGENT_PROBE_HOST?.trim();
    const resolveProbeUrl = (endpoint: ReturnType<AlertDatabase['listMonitoredEndpoints']>[number]): string => {
      const value = endpoint.probeUrl || endpoint.endpointUrl;
      if (!agentProbeHost) return value;
      try {
        const url = new URL(value);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') url.hostname = agentProbeHost;
        return url.toString();
      } catch { return value; }
    };
    const endpoints = db.listMonitoredEndpoints().filter((endpoint) => endpoint.enabled).map((endpoint) => ({ id: endpoint.id, applicationName: endpoint.applicationName, probeUrl: resolveProbeUrl(endpoint), method: endpoint.method, expectedStatus: endpoint.expectedStatus, intervalSeconds: endpoint.intervalSeconds }));
    return {
      agentId: String(request.headers['x-sentinelops-agent-id'] ?? 'kubernetes-agent'),
      mode: recoveryMode.currentMode(),
      policy,
      endpoints,
      traffic: {
        prometheusUrl: process.env.KUBERNETES_AGENT_PROMETHEUS_URL?.trim() || 'http://host.docker.internal:9090',
        requestMetric: 'sentinelops_http_requests_total',
        intervalSeconds: 5,
        source: 'Prometheus application instrumentation'
      },
      generatedAt: new Date().toISOString()
    };
  });
  app.get('/api/kubernetes/agent/status', { preHandler: requireAdmin }, async () => ({ policy: db.getKubernetesAgentPolicy(), mode: recoveryMode.current(), agents: db.listKubernetesAgents(), leases: db.listKubernetesAgentLeases(), incidents: db.listKubernetesIncidents(50), events: db.listKubernetesAgentEvents(200) }));
  app.post('/api/kubernetes/agent/deploy', { preHandler: requireAdmin, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (_request, reply) => {
    const lockKey = 'kubernetes-agent-deploy';
    if (transitionLocks.has(lockKey)) return reply.code(409).send({ error: 'Agent deployment is already in progress' });
    const terminalUrl = process.env.KUBERNETES_TERMINAL_URL?.trim();
    const terminalToken = process.env.KUBERNETES_TERMINAL_TOKEN?.trim();
    if (!terminalUrl || !terminalToken) return reply.code(503).send({ error: 'Trusted terminal is not configured. Set KUBERNETES_TERMINAL_URL and KUBERNETES_TERMINAL_TOKEN.' });
    const context = process.env.KUBERNETES_CONTEXT?.trim() || 'kind-sentinelops-dev';
    const clusterName = process.env.KIND_CLUSTER_NAME?.trim() || 'sentinelops-dev';
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(context) || !/^sentinelops-dev$/.test(clusterName)) return reply.code(503).send({ error: 'Agent deployment target is not an allowlisted development cluster' });
    transitionLocks.add(lockKey);
    try {
      events?.publishEphemeral('operation', { source: 'agent-deploy', status: 'STARTED', command: 'Automatic Agent bootstrap started.' });
      const result = await deployAgentViaTerminal({ context, clusterName, terminalUrl, terminalToken, onOutput: (chunk) => events?.publishEphemeral('operation', { source: 'agent-deploy', status: 'RUNNING', output: chunk }) });
      events?.publishEphemeral('operation', { source: 'agent-deploy', status: result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode: result.exitCode });
      if (result.exitCode !== 0) return reply.code(502).send({ error: 'Agent deployment command failed', output: result.output, exitCode: result.exitCode });
      return { status: 'applied', context, clusterName, output: result.output };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'Agent deployment failed' });
    } finally {
      transitionLocks.delete(lockKey);
    }
  });
  app.get('/api/kubernetes/topology', { preHandler: requireAdmin }, async (_request, reply) => {
    const terminalUrl = process.env.KUBERNETES_TERMINAL_URL?.trim();
    const terminalToken = process.env.KUBERNETES_TERMINAL_TOKEN?.trim();
    const context = process.env.KUBERNETES_CONTEXT?.trim() || 'kind-sentinelops-dev';
    const clusterName = process.env.KIND_CLUSTER_NAME?.trim() || 'sentinelops-dev';
    const namespace = process.env.KUBERNETES_AGENT_NAMESPACE?.trim() || 'sentinelops-system';
    if (!terminalUrl || !terminalToken) return reply.code(503).send({ error: 'Trusted terminal is not configured' });
    const lockKey = 'kubernetes-topology-read';
    if (transitionLocks.has(lockKey)) return reply.code(409).send({ error: 'A topology inspection is already in progress' });
    transitionLocks.add(lockKey);
    try {
      const result = await runKubernetesSetup({ operation: 'topology', clusterName, context, namespace, terminalUrl, terminalToken });
      // Keep these delimiters identical to the markers emitted by the
      // trusted terminal topology command. A spelling mismatch here makes
      // valid kubectl JSON appear as a failed refresh.
      const nodesMarker = '__SENTINELOOPS_NODES_JSON__';
      const podsMarker = '__SENTINELOOPS_PODS_JSON__';
      const nodesStart = result.output.lastIndexOf(nodesMarker);
      const podsStart = result.output.lastIndexOf(podsMarker);
      const completionStart = result.output.lastIndexOf('__SENTINELOPS_SETUP_DONE__:');
      if (result.exitCode !== 0 || nodesStart < 0 || podsStart < 0) return reply.code(502).send({ error: 'Kubernetes topology inspection failed', output: result.output, exitCode: result.exitCode });
      const nodesText = result.output.slice(nodesStart + nodesMarker.length, podsStart).trim();
      const podsText = result.output.slice(podsStart + podsMarker.length, completionStart > podsStart ? completionStart : undefined).trim();
      const parseKubectlJson = (text: string): Record<string, unknown> => {
        // The interactive terminal may append a prompt/control sequence after
        // kubectl exits. Extract the actual JSON document before parsing so
        // valid live topology data is not rejected by PTY framing.
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('kubectl returned no JSON document');
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      };
      const nodes = parseKubectlJson(nodesText);
      const pods = parseKubectlJson(podsText);
      return { context, namespace, nodes: Array.isArray(nodes.items) ? nodes.items : [], pods: Array.isArray(pods.items) ? pods.items : [], agents: db.listKubernetesAgents(), leases: db.listKubernetesAgentLeases(), observedAt: new Date().toISOString() };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'Kubernetes topology inspection failed' });
    } finally { transitionLocks.delete(lockKey); }
  });
  app.post('/api/kubernetes/failure-test/stop-service', { preHandler: requireAdmin, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (_request, reply) => {
    if (!recoveryMode.isActive('KUBERNETES')) return reply.code(409).send({ error: 'Kubernetes Recovery must be the active mode' });
    const service = process.env.RECOVERY_ALLOWED_SERVICE?.trim() || 'test-service';
    try {
      const result = await controlContainer('STOP_CONTAINER', service, 15000);
      events?.publish('operation', { source: 'failure-testing-lab', action: 'STOP_TEST_SERVICE', service, result });
      return { status: 'stopped', service, result };
    } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'Test Service stop failed' }); }
  });
  app.post('/api/kubernetes/setup/:operation', { preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const allowed: KubernetesSetupOperation[] = ['create-cluster', 'check-cluster', 'create-namespace', 'deploy-agent', 'check-agent-pods', 'agent-logs', 'delete-agent-pod', 'scale-agents-zero', 'delete-cluster', 'inspect-node', 'stop-worker', 'start-worker'];
    const operation = String((request.params as { operation?: string }).operation ?? '') as KubernetesSetupOperation;
    if (!allowed.includes(operation)) return reply.code(404).send({ error: 'Unsupported Kubernetes setup operation' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const clusterName = typeof body.clusterName === 'string' ? body.clusterName.trim() : 'sentinelops-dev';
    const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : 'sentinelops-system';
    const workerNodes = Number(body.workerNodes ?? 3);
    const agentPods = Number(body.agentPods ?? 3);
    const context = `kind-${clusterName}`;
    const validName = (value: string) => /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(value);
    if (clusterName !== (process.env.KIND_CLUSTER_NAME?.trim() || 'sentinelops-dev') || !validName(clusterName)) return reply.code(400).send({ error: 'Only the allowlisted development kind cluster may be managed' });
    if (!validName(namespace) || namespace.length > 63) return reply.code(400).send({ error: 'Invalid Kubernetes namespace' });
    if (!Number.isInteger(workerNodes) || workerNodes < 0 || workerNodes > 10) return reply.code(400).send({ error: 'Worker nodes must be an integer from 0 to 10' });
    if (!Number.isInteger(agentPods) || agentPods < 1 || agentPods > 20) return reply.code(400).send({ error: 'Agent Pods must be an integer from 1 to 20' });
    const podName = typeof body.podName === 'string' ? body.podName.trim() : undefined;
    const nodeName = typeof body.nodeName === 'string' ? body.nodeName.trim() : undefined;
    if ((podName && !validName(podName)) || (nodeName && !validName(nodeName))) return reply.code(400).send({ error: 'Invalid Pod or node name' });
    const terminalUrl = process.env.KUBERNETES_TERMINAL_URL?.trim();
    const terminalToken = process.env.KUBERNETES_TERMINAL_TOKEN?.trim();
    if (!terminalUrl || !terminalToken) return reply.code(503).send({ error: 'Trusted terminal is not configured' });
    const mutating = !['check-cluster', 'check-agent-pods', 'agent-logs', 'inspect-node'].includes(operation);
    const lockKey = `kubernetes-setup-${mutating ? 'mutation' : operation}`;
    if (transitionLocks.has(lockKey)) return reply.code(409).send({ error: 'A Kubernetes setup operation is already in progress' });
    transitionLocks.add(lockKey);
    let output = '';
    try {
      events?.publishEphemeral('operation', { source: 'k8s-setup', operation, status: 'STARTED', command: `Kubernetes setup: ${operation}` });
      const result = await runKubernetesSetup({ operation, clusterName, context, namespace, workerNodes, agentPods, podName, nodeName, terminalUrl, terminalToken, onOutput: (chunk) => { output += chunk; events?.publishEphemeral('operation', { source: 'k8s-setup', operation, status: 'RUNNING', output: chunk }); } });
      events?.publishEphemeral('operation', { source: 'k8s-setup', operation, status: result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode: result.exitCode });
      if (result.exitCode !== 0) return reply.code(502).send({ error: `Kubernetes setup operation failed (${operation})`, output: result.output || output, exitCode: result.exitCode });
      return { operation, clusterName, context, namespace, output: result.output || output, exitCode: result.exitCode };
    } catch (error) {
      events?.publishEphemeral('operation', { source: 'k8s-setup', operation, status: 'FAILED', error: error instanceof Error ? error.message : 'Operation failed' });
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'Kubernetes setup operation failed', output });
    } finally { transitionLocks.delete(lockKey); }
  });
  app.get('/api/kubernetes/agent/events', { preHandler: requireAdmin }, async (request) => ({ events: db.listKubernetesAgentEvents(Number((request.query as { limit?: string }).limit ?? 100)) }));
  app.put('/api/kubernetes/agent/policy', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const integer = (name: string, fallback: number, min: number, max: number) => { const value = body?.[name] === undefined ? fallback : Number(body[name]); return Number.isInteger(value) && value >= min && value <= max ? value : null; };
    const current = db.getKubernetesAgentPolicy();
    const intervalSeconds = integer('intervalSeconds', Number(current.intervalSeconds), 1, 3600);
    const timeoutSeconds = integer('timeoutSeconds', Number(current.timeoutSeconds), 1, 60);
    const failureThreshold = integer('failureThreshold', Number(current.failureThreshold), 1, 20);
    const cooldownSeconds = integer('cooldownSeconds', Number(current.cooldownSeconds), 0, 86400);
    const maxAttempts = integer('maxAttempts', Number(current.maxAttempts), 1, 10);
    if ([intervalSeconds, timeoutSeconds, failureThreshold, cooldownSeconds, maxAttempts].some((value) => value == null)) return reply.code(400).send({ error: 'Invalid agent policy values' });
    return { policy: db.saveKubernetesAgentPolicy({ enabled: body?.enabled === undefined ? Boolean(current.enabled) : Boolean(body.enabled), intervalSeconds: intervalSeconds as number, timeoutSeconds: timeoutSeconds as number, failureThreshold: failureThreshold as number, cooldownSeconds: cooldownSeconds as number, maxAttempts: maxAttempts as number }) };
  });
  app.post('/api/kubernetes/agent/heartbeat', async (request) => {
    const body = request.body as Record<string, unknown>;
    const agentId = typeof body?.agentId === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(body.agentId) ? body.agentId : 'kubernetes-agent';
    db.upsertKubernetesAgent({ agentId, podName: typeof body?.podName === 'string' ? body.podName : undefined, namespace: typeof body?.namespace === 'string' ? body.namespace : undefined, nodeName: typeof body?.nodeName === 'string' ? body.nodeName : undefined, status: 'MONITORING', metadata: body?.metadata });
    db.recordKubernetesAgentEvent(agentId, 'agent.connected', { status: 'MONITORING' });
    return { status: 'accepted', mode: recoveryMode.currentMode(), policy: db.getKubernetesAgentPolicy() };
  });
  app.post('/api/kubernetes/agent/events', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const agentId = typeof body?.agentId === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(body.agentId) ? body.agentId : 'kubernetes-agent';
    const eventType = typeof body?.eventType === 'string' && /^[a-z][a-z0-9_.-]{1,80}$/.test(body.eventType) ? body.eventType : '';
    if (!eventType) return reply.code(400).send({ error: 'eventType is required' });
    const incidentId = typeof body?.incidentId === 'string' ? body.incidentId.slice(0, 120) : undefined;
    if (eventType === 'traffic.sample') {
      events?.publishEphemeral('traffic', {
        source: 'kubernetes-agent',
        agentId,
        service: typeof body?.service === 'string' ? body.service : 'test-service',
        rps: Number(body?.rps ?? 0),
        dataSource: typeof body?.dataSource === 'string' ? body.dataSource : 'Prometheus application instrumentation',
        deduplicationKey: typeof body?.deduplicationKey === 'string' ? body.deduplicationKey : undefined
      });
      return { status: 'accepted', deduplicated: true, sourceOfTruth: 'prometheus' };
    }
    if (incidentId && body.eventType === 'incident.created') db.createKubernetesIncident(incidentId, Number(body.monitorId), typeof body.service === 'string' ? body.service : 'test-service', typeof body.error === 'string' ? body.error : 'Health check failed', body.metadata);
    if (incidentId && body.eventType === 'incident.resolved') db.updateKubernetesIncident(incidentId, { status: 'RECOVERED', recoveredAt: new Date().toISOString() });
    db.recordKubernetesAgentEvent(agentId, eventType, body, incidentId);
    events?.publish('operation', { source: 'kubernetes-agent', eventType, incidentId, service: body.service });
    return { status: 'accepted' };
  });
  app.post('/api/kubernetes/agent/lease/acquire', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const agentId = typeof body?.agentId === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(body.agentId) ? body.agentId : '';
    const service = typeof body?.service === 'string' ? body.service.trim() : '';
    const incidentId = typeof body?.incidentId === 'string' ? body.incidentId.trim() : '';
    const ttlSeconds = Number(body?.ttlSeconds ?? 120);
    if (!agentId || !service || !incidentId || !Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 900) return reply.code(400).send({ error: 'Invalid recovery lease request' });
    const allowedService = process.env.RECOVERY_ALLOWED_SERVICE?.trim() || 'test-service';
    if (service !== allowedService && service !== 'Test Service' && service !== 'localhost') return reply.code(403).send({ error: 'Recovery lease target is not allowlisted' });
    const normalizedService = allowedService;
    if (!recoveryMode.isActive('KUBERNETES')) return reply.code(409).send({ error: 'Kubernetes Recovery is not the active recovery mode' });
    const policy = db.getKubernetesAgentPolicy();
    if (!policy.enabled) return reply.code(409).send({ error: 'Kubernetes Agent automatic recovery is disabled' });
    const lease = db.acquireKubernetesAgentLease(normalizedService, incidentId, agentId, ttlSeconds);
    db.recordKubernetesAgentEvent(agentId, lease.acquired ? 'recovery.ownership_acquired' : 'recovery.ownership_contended', { service: normalizedService, incidentId, ownerAgentId: lease.ownerAgentId, expiresAt: lease.expiresAt }, incidentId);
    return lease.acquired ? lease : reply.code(409).send(lease);
  });
  app.post('/api/kubernetes/agent/recovery', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const requestedService = typeof body?.service === 'string' ? body.service.trim() : '';
    const incidentId = typeof body?.incidentId === 'string' ? body.incidentId.trim() : '';
    const monitorId = Number(body?.monitorId);
    const agentId = typeof body?.agentId === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(body.agentId) ? body.agentId : '';
    const leaseToken = typeof body?.leaseToken === 'string' ? body.leaseToken.trim() : '';
    const action = body?.action === 'START_CONTAINER' || body?.action === 'RESTART_CONTAINER' ? body.action as 'START_CONTAINER' | 'RESTART_CONTAINER' : null;
    const allowedService = process.env.RECOVERY_ALLOWED_SERVICE?.trim() || 'test-service';
    const service = requestedService === allowedService || requestedService === 'Test Service' || requestedService === 'localhost' ? allowedService : '';
    if (!service || !incidentId || !Number.isInteger(monitorId) || !action) return reply.code(400).send({ error: 'Invalid recovery request' });
    if (!recoveryMode.isActive('KUBERNETES')) return reply.code(409).send({ error: 'Kubernetes Recovery is not the active recovery mode' });
    const policy = db.getKubernetesAgentPolicy();
    if (!policy.enabled) return reply.code(409).send({ error: 'Kubernetes Agent automatic recovery is disabled' });
    if (!agentId || !leaseToken || !db.validateKubernetesAgentLease(service, incidentId, agentId, leaseToken)) return reply.code(409).send({ error: 'Recovery ownership is missing, expired, or held by another Agent' });
    const runbook = db.listRunbooks().find((candidate) => candidate.enabled && candidate.mode === 'AUTOMATIC' && candidate.service === service);
    if (!runbook) return reply.code(409).send({ error: 'No enabled automatic runbook is configured for this recovery target' });
    if (kubernetesRecoveryLocks.has(service) || db.activeRecoveryForService(service)) return reply.code(409).send({ error: 'A recovery attempt is already running for this service' });
    const incident = db.getKubernetesIncident(incidentId);
    if (incident?.status === 'RECOVERED') return reply.code(409).send({ error: 'Incident is already recovered' });
    kubernetesRecoveryLocks.add(service);
    const attemptId = crypto.randomUUID();
    db.createKubernetesAttempt(attemptId, incidentId);
    db.updateKubernetesIncident(incidentId, { status: 'RECOVERING', recoveryAttempts: Number(incident?.recovery_attempts ?? 0) + 1 });
    try {
      events?.publish('recovery', { source: 'kubernetes-agent', incidentId, attemptId, status: 'RECOVERY_REQUESTED', service, action });
      const result = await controlContainer(action, service, Number(runbook.timeoutSeconds) * 1000);
      let healthyChecks = 0;
      const verificationDeadline = Date.now() + Number(runbook.timeoutSeconds) * 1000;
      while (Date.now() < verificationDeadline) {
        if (await verifyService(runbook, 5000)) healthyChecks += 1; else healthyChecks = 0;
        if (healthyChecks >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (healthyChecks < 2) throw new Error('Recovery command completed but API health verification did not pass');
      db.finishKubernetesAttempt(attemptId, 'SUCCEEDED', undefined, { ...result, verified: true });
      db.updateKubernetesIncident(incidentId, { status: 'RECOVERED', recoveredAt: new Date().toISOString() });
      db.recordKubernetesAgentEvent(String(request.headers['x-sentinelops-agent-id'] ?? 'kubernetes-agent'), 'recovery.succeeded', { incidentId, attemptId, result, verified: true }, incidentId);
      return { status: 'accepted', attemptId, result, verified: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery executor failed';
      db.finishKubernetesAttempt(attemptId, 'FAILED', message);
      db.updateKubernetesIncident(incidentId, { status: 'FAILED', error: message });
      db.recordKubernetesAgentEvent(String(request.headers['x-sentinelops-agent-id'] ?? 'kubernetes-agent'), 'recovery.failed', { incidentId, attemptId, error: message }, incidentId);
      return reply.code(502).send({ error: message, attemptId });
    } finally {
      kubernetesRecoveryLocks.delete(service);
      db.releaseKubernetesAgentLease(service, incidentId, agentId, leaseToken);
    }
  });
  app.get('/api/kubernetes/commands', { preHandler: requireAdmin }, async () => ({ operations: kubernetesCommands.list() }));
  app.get('/api/kubernetes/commands/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const operation = kubernetesCommands.get(String((request.params as { id: string }).id));
    return operation ? { operation } : reply.code(404).send({ error: 'Kubernetes command operation not found' });
  });
  app.post('/api/kubernetes/commands/:id/cancel', { preHandler: requireAdmin }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    return kubernetesCommands.cancel(id) ? { status: 'CANCEL_REQUESTED', operationId: id } : reply.code(409).send({ error: 'Command is not running or cannot be canceled' });
  });
  app.post('/api/kubernetes/commands', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { command?: unknown; commandLine?: unknown } | undefined;
    if (typeof body?.commandLine === 'string') {
      try { return reply.code(202).send({ operation: kubernetesCommands.startInteractive(body.commandLine) }); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unsupported read-only command' }); }
    }
    if (typeof body?.command !== 'string' || !readonlyCommands.includes(body.command as typeof readonlyCommands[number])) {
      return reply.code(400).send({ error: 'Unsupported read-only Kubernetes command' });
    }
    return reply.code(202).send({ operation: kubernetesCommands.start(body.command as typeof readonlyCommands[number]) });
  });
  app.get('/api/kubernetes/commands/:id/stream', async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const operation = kubernetesCommands.get(id);
    if (!operation) return reply.code(404).send({ error: 'Kubernetes command operation not found' });
    if (authEnabled && (!tokenFromRequest(request) || !safeEqual(tokenFromRequest(request) as string, adminToken))) return reply.code(401).send({ error: 'Authentication required' });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: { type: string; timestamp: string; data: Record<string, unknown> }) => { if (!response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    send({ type: 'start', timestamp: operation.startedAt, data: { operation } });
    if (operation.stdout) send({ type: 'stdout', timestamp: operation.startedAt, data: { text: operation.stdout } });
    if (operation.stderr) send({ type: 'stderr', timestamp: operation.startedAt, data: { text: operation.stderr } });
    if (operation.status !== 'RUNNING') send({ type: 'complete', timestamp: operation.completedAt ?? new Date().toISOString(), data: { operation } });
    const unsubscribe = operation.status === 'RUNNING' ? kubernetesCommands.subscribe(id, send) : () => undefined;
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000);
    request.raw.once('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.post('/api/webhooks/alertmanager', async (request, reply) => {
    if (authEnabled && (!tokenFromRequest(request) || !safeEqual(tokenFromRequest(request) as string, webhookToken))) return reply.code(401).send({ error: 'Invalid webhook authorization' });
    const payload = parseAlertmanagerPayload(request.body);
    if (!payload) return reply.code(400).send({ error: 'Invalid Alertmanager webhook payload' });

    let accepted = 0;
    for (const alert of payload.alerts) {
      if (publisher) {
        const event = toAlertEvent(alert);
        try {
          await publisher.publish(event);
          db.recordPublishedEvent(event);
          accepted += 1;
          request.log.info({ eventId: event.eventId, fingerprint: event.fingerprint, status: event.status }, 'alert event published');
        } catch (error) {
          request.log.error({ error, fingerprint: alert.fingerprint }, 'alert event publish failed');
          return reply.code(503).send({ error: 'Alert event could not be durably published', fingerprint: alert.fingerprint });
        }
      } else {
        const result = db.upsertAlert(alert);
        accepted += 1;
        if (result.transitioned) {
          triggerAutomaticRecovery(alert, db, events, recoveryMode);
          events?.publish(alert.status === 'firing' ? 'incident' : 'recovery', {
            fingerprint: alert.fingerprint,
            status: alert.status.toUpperCase(),
            alertName: alert.labels.alertname ?? 'unknown',
            service: alert.labels.service ?? 'unknown',
            severity: alert.labels.severity ?? 'info'
          });
          const settings = db.getSettings();
          const delivery = await sendAlertEmail(result.record, alert.status, settings, dashboardUrl, (entry) => db.recordEmail(entry));
          request.log.info({ alert: alert.labels.alertname, status: alert.status, fingerprint: alert.fingerprint, email: delivery?.status ?? 'not-configured' }, 'alert lifecycle processed');
        }
      }
    }
    return reply.code(202).send({ status: 'accepted', received: accepted });
  });

  app.get('/api/overview', { preHandler: requireAdmin }, async () => {
    const alerts = db.listAlerts({});
    return {
      active: alerts.filter((alert) => alert.status === 'firing').length,
      critical: alerts.filter((alert) => alert.status === 'firing' && alert.labels.severity === 'critical').length,
      warning: alerts.filter((alert) => alert.status === 'firing' && alert.labels.severity === 'warning').length,
      resolved: alerts.filter((alert) => alert.status === 'resolved').length
    };
  });

  app.get('/api/dashboard', { preHandler: requireAdmin }, async (request) => {
    const range = String((request.query as { range?: string }).range ?? '15m');
    return dashboardData(range, db);
  });

  app.get('/api/dashboard/traffic', { preHandler: requireAdmin }, async (request) => trafficData(String((request.query as { range?: string }).range ?? '15m'), db));

  app.get('/api/traffic/intelligence', { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { range?: string; service?: string; route?: string };
    return trafficIntelligence(String(query.range ?? '15m'), query.service, query.route, db);
  });

  app.get('/api/traffic/export.csv', { preHandler: requireAdmin }, async (request, reply) => {
    const query = request.query as { range?: string; service?: string; route?: string };
    const data = await trafficIntelligence(String(query.range ?? '15m'), query.service, query.route, db);
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = ['application,route,method,total_hits,average_rps,peak_rps,4xx_count,5xx_count,error_percent,p95_seconds,p99_seconds,last_observed'];
    for (const endpoint of data.endpoints) rows.push([endpoint.application, endpoint.route, endpoint.method, endpoint.total, endpoint.averageRps, endpoint.peakRps, endpoint.errors4xx, endpoint.errors5xx, endpoint.errorPercent, endpoint.p95Seconds, endpoint.p99Seconds, endpoint.lastObserved].map(escape).join(','));
    return reply.type('text/csv; charset=utf-8').send(`${rows.join('\n')}\n`);
  });

  app.get('/api/activity', { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { service?: string; severity?: string; type?: string; since?: string; limit?: string; offset?: string };
    return { events: db.dashboardEvents({ service: query.service, severity: query.severity, type: query.type, since: query.since, limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0) }) };
  });

  app.get('/api/connections', { preHandler: requireAdmin }, async () => {
    const check = async (url: string): Promise<'connected' | 'unavailable'> => {
      try {
        const response = await fetch(url);
        return response.ok ? 'connected' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    };
    const prometheus = await check(`${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}/-/ready`);
    const alertmanager = await check(`${process.env.ALERTMANAGER_URL ?? 'http://alertmanager:9093'}/-/ready`);
    return { prometheus, alertmanager };
  });

  app.get('/api/alerts', { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { status?: 'firing' | 'resolved'; service?: string; severity?: string; search?: string };
    const alerts = db.listAlerts(query);
    return { alerts, total: alerts.length };
  });

  app.get('/api/alerts/:fingerprint', { preHandler: requireAdmin }, async (request, reply) => {
    const { fingerprint } = request.params as { fingerprint: string };
    const alert = db.getAlert(fingerprint);
    return alert ? { alert, history: db.getHistory(fingerprint) } : reply.code(404).send({ error: 'Alert not found' });
  });

  app.get('/api/settings', { preHandler: requireAdmin }, async () => publicSettings(db.getSettings()));

  app.put('/api/settings', { preHandler: requireAdmin }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const result = validateSettings(body, db.getSettings());
    if (!result.settings) return reply.code(400).send({ error: 'Invalid notification settings', details: result.errors });
    db.saveSettings(result.settings);
    events?.publish('notification', { kind: 'settings-updated' });
    return publicSettings(db.getSettings());
  });

  app.post('/api/settings/test-email', { preHandler: requireAdmin, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (_request, reply) => {
    const settings = db.getSettings();
    if (!settings.enabled || settings.recipients.length === 0 || !settings.smtpHost || !settings.fromEmail) return reply.code(400).send({ error: 'Complete and enable SMTP notification settings first' });
    const delivery = await sendTestEmail(settings, dashboardUrl, (entry) => db.recordEmail(entry));
    return delivery.status === 'sent' ? { status: 'sent', delivery } : reply.code(502).send({ status: 'failed', error: delivery.error ?? 'SMTP delivery failed', delivery });
  });

  app.get('/api/notifications/history', { preHandler: requireAdmin }, async () => ({ deliveries: db.listEmails() }));

  app.get('/api/recovery/history', { preHandler: requireAdmin }, async () => ({ recoveries: db.recoveryHistory() }));

  app.get('/api/recovery/mode', { preHandler: requireAdmin }, async (request) => {
    const application = typeof (request.query as { application?: unknown }).application === 'string' ? String((request.query as { application: string }).application) : 'test-service';
    if (application !== 'test-service') return { ...db.getRecoveryControllerMode(application), requestedMode: db.getRecoveryControllerMode(application).mode, verified: true };
    const mode = recoveryMode.current();
    return { ...mode, requestedMode: mode.mode, verified: true, kubernetes: { context: process.env.KUBERNETES_CONTEXT ?? 'kind-sentinelops-dev', namespace: process.env.KUBERNETES_NAMESPACE ?? 'sentinelops-test' } };
  });

  app.get('/api/recovery/operations', { preHandler: requireAdmin }, async (request) => ({ operations: db.recoveryOperations(typeof (request.query as { application?: unknown }).application === 'string' ? String((request.query as { application: string }).application) : undefined) }));

  app.post('/api/recovery/mode', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { application?: unknown; mode?: unknown };
    const application = typeof body?.application === 'string' && body.application.trim() ? body.application.trim() : 'test-service';
    if (application !== 'test-service' || (body?.mode !== 'MANUAL' && body?.mode !== 'KUBERNETES')) return reply.code(400).send({ error: 'Only MANUAL or KUBERNETES modes are supported for test-service' });
    try {
      const result = recoveryMode.switchTo(body.mode as RecoveryModeName);
      return { status: 'SUCCESS', mode: result.current.mode, previous: result.previous, controller: result.current, generation: result.generation };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Recovery mode transition failed' });
    }
  });
  app.get('/api/recovery/runbooks',{preHandler:requireAdmin},async()=>({runbooks:db.listRunbooks(),executionEnabled:Boolean(process.env.RECOVERY_CONTROLLER_URL && process.env.RECOVERY_ALLOWED_SERVICE),executionMessage:'Docker recovery is available only for the explicitly configured recovery service.'}));
  app.post('/api/recovery/runbooks',{preHandler:requireAdmin},async(request,reply)=>{const parsed=parseRunbook(request.body);if(!parsed.value)return reply.code(400).send({error:parsed.error});return{runbook:db.saveRunbook(parsed.value)};});
  app.put('/api/recovery/runbooks/:id',{preHandler:requireAdmin},async(request,reply)=>{const id=Number((request.params as {id:string}).id);if(!db.getRunbook(id))return reply.code(404).send({error:'Runbook not found'});const parsed=parseRunbook(request.body);if(!parsed.value)return reply.code(400).send({error:parsed.error});return{runbook:db.saveRunbook(parsed.value,id)};});
  app.get('/api/recovery/executions',{preHandler:requireAdmin},async()=>({executions:db.recoveryExecutions()}));
  app.post('/api/recovery/runbooks/:id/execute',{preHandler:requireAdmin},async(request,reply)=>{const runbook=db.getRunbook(Number((request.params as {id:string}).id));if(!recoveryMode.isActive('MANUAL'))return reply.code(409).send({error:'Manual Recovery is disabled while Kubernetes Recovery is active'});if(!runbook||!runbook.enabled)return reply.code(404).send({error:'Enabled runbook not found'});if(runbook.mode!=='MANUAL')return reply.code(409).send({error:'Automatic runbooks must be triggered by an active incident'});if(db.activeRecoveryForService(runbook.service))return reply.code(409).send({error:'A recovery attempt is already running for this service'});const executionId=db.createRecoveryExecution(runbook,'MANUAL','Approved manually from the Recovery panel.');events?.publish('recovery',{executionId,runbookId:runbook.id,status:'RUNNING',service:runbook.service,actionType:runbook.actionType});void runRecovery(executionId,runbook,db,events);return reply.code(202).send({status:'started',executionId});});


  app.post('/api/recovery/:fingerprint/request', { preHandler: requireAdmin }, async (request, reply) => {
    const { fingerprint } = request.params as { fingerprint: string };
    const alert = db.getAlert(fingerprint);
    if (!alert || alert.status !== 'firing') return reply.code(404).send({ error: 'Active incident not found' });
    try { return { id: db.requestRecovery(fingerprint, alert.labels.service ?? '') }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Recovery is not allowed' }); }
  });

  app.post('/api/recovery/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const approved = db.approveRecovery(Number(id));
    return approved ? { status: 'approved_manual', message: 'Execute the documented docker compose recovery command manually.' } : reply.code(404).send({ error: 'Pending recovery request not found' });
  });

  app.get('/api/streaming', { preHandler: requireAdmin }, async () => ({
    kafka: 'embedded-queue',
    topic: 'sqlite.jobs',
    jobs: db.jobStats(),
    ...db.streamStats(),
    consumers: db.consumerStatuses()
  }));


  void syncPrometheusTargets(db).catch(() => undefined);
  return app;
}

