import http from 'node:http';
import crypto from 'node:crypto';

type Target = { id: number; applicationName: string; probeUrl: string; method: 'GET' | 'HEAD'; expectedStatus: number; intervalSeconds: number };
type Policy = { enabled: boolean; intervalSeconds: number; timeoutSeconds: number; failureThreshold: number; cooldownSeconds: number; maxAttempts: number };
type TrafficConfig = { prometheusUrl: string; requestMetric: string; intervalSeconds: number; source: string };
type Config = { agentId: string; mode: 'MANUAL' | 'KUBERNETES'; policy: Policy; endpoints: Target[]; traffic?: TrafficConfig };
type State = { failures: number; incidentId?: string; attempts: number; lastRecoveryAt?: number; leaseToken?: string };

const backend = (process.env.SENTINELOPS_BACKEND_URL ?? 'http://sentinelops:8081').replace(/\/$/, '');
const agentId = process.env.SENTINELOPS_AGENT_ID ?? `agent-${crypto.randomUUID()}`;
const podName = process.env.POD_NAME;
const namespace = process.env.POD_NAMESPACE ?? 'sentinelops';
const nodeName = process.env.POD_NODE_NAME;
const states = new Map<number, State>();
let monitoring = true;
let lastConfig: Config | undefined;
let trafficTimer: NodeJS.Timeout | undefined;
let lastHealthCheckAt: string | undefined;

const recoveryService = (target: Target): string => target.applicationName === 'Test Service' || target.applicationName === 'localhost' ? 'test-service' : target.applicationName;

async function fetchBounded(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs + 50))
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetchBounded(`${backend}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-sentinelops-agent-id': agentId, ...(init.headers ?? {}) } }, 5000);
}

async function config(): Promise<Config> {
  const response = await request('/api/kubernetes/agent/config');
  if (!response.ok) throw new Error(`Backend configuration request failed (${response.status})`);
  return await response.json() as Config;
}

async function sendEvent(eventType: string, target: Target, state: State, extra: Record<string, unknown> = {}, waitForDelivery = false): Promise<void> {
  const deliver = request('/api/kubernetes/agent/events', { method: 'POST', body: JSON.stringify({ agentId, eventType, incidentId: state.incidentId, monitorId: target.id, service: target.applicationName, ...extra }) })
    .then(async (response) => {
      if (!response.ok) console.error(JSON.stringify({ event: 'agent.event_rejected', eventType, status: response.status }));
    })
    .catch((error) => console.error(JSON.stringify({ event: 'agent.event_unavailable', eventType, error: error instanceof Error ? error.message : String(error) })));
  if (waitForDelivery) await deliver;
}

async function heartbeat(): Promise<void> {
  try {
    const response = await request('/api/kubernetes/agent/heartbeat', { method: 'POST', body: JSON.stringify({ agentId, podName, namespace, nodeName, status: monitoring ? 'MONITORING' : 'STOPPED', metadata: { modules: { trafficMonitor: 'ACTIVE', apiHealthChecker: 'ACTIVE', recoveryEngine: 'READY' }, lastHealthCheckAt } }) });
    if (!response.ok) console.error(JSON.stringify({ event: 'agent.heartbeat_rejected', status: response.status }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'agent.heartbeat_unavailable', error: error instanceof Error ? error.message : String(error) }));
  }
}

async function check(target: Target, policy: Policy): Promise<{ healthy: boolean; status?: number; latencyMs?: number; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetchBounded(target.probeUrl, { method: target.method, redirect: 'error' }, policy.timeoutSeconds * 1000);
    return { healthy: response.status >= 200 && response.status < 300 && response.status === target.expectedStatus, status: response.status, latencyMs: Date.now() - started, error: response.ok ? undefined : `HTTP ${response.status}` };
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'Health check failed' };
  }
}

async function monitorTarget(target: Target, current: Config): Promise<void> {
  const policy = current.policy;
  const state = states.get(target.id) ?? { failures: 0, attempts: 0 };
  const result = await check(target, policy);
  if (result.healthy) {
    if (state.failures > 0) await sendEvent('api.healthy', target, state, { statusCode: result.status, latencyMs: result.latencyMs });
    state.failures = 0;
    if (state.incidentId) {
      await sendEvent('incident.resolved', target, state, { statusCode: result.status, latencyMs: result.latencyMs });
      state.incidentId = undefined;
      state.attempts = 0;
    }
    states.set(target.id, state);
    return;
  }
  state.failures += 1;
  await sendEvent(state.failures >= policy.failureThreshold ? 'api.unhealthy' : 'api.degraded', target, state, { statusCode: result.status, latencyMs: result.latencyMs, error: result.error });
  if (state.failures < policy.failureThreshold) { states.set(target.id, state); return; }
  if (!state.incidentId) {
    state.incidentId = `${agentId}-${target.id}-${Date.now()}`;
    console.warn(JSON.stringify({ event: 'agent.threshold_reached', agentId, monitorId: target.id, failureCount: state.failures, threshold: policy.failureThreshold }));
    await sendEvent('incident.created', target, state, { error: result.error, failureCount: state.failures }, true);
  }
  const now = Date.now();
  const cooled = !state.lastRecoveryAt || now - state.lastRecoveryAt >= policy.cooldownSeconds * 1000;
  if (current.mode !== 'KUBERNETES' || !policy.enabled || state.attempts >= policy.maxAttempts || !cooled) {
    console.warn(JSON.stringify({ event: 'agent.recovery_skipped', monitorId: target.id, mode: current.mode, enabled: policy.enabled, attempts: state.attempts, maxAttempts: policy.maxAttempts, cooled }));
    states.set(target.id, state); return;
  }
  state.attempts += 1;
  state.lastRecoveryAt = now;
  const service = recoveryService(target);
  try {
    const ownership = await request('/api/kubernetes/agent/lease/acquire', { method: 'POST', body: JSON.stringify({ agentId, service, incidentId: state.incidentId, ttlSeconds: Math.min(900, Math.max(120, policy.cooldownSeconds + 60)) }) });
    if (!ownership.ok) {
      console.warn(JSON.stringify({ event: 'agent.recovery_skipped', monitorId: target.id, reason: 'recovery_ownership_contended', status: ownership.status }));
      state.attempts -= 1;
      states.set(target.id, state);
      return;
    }
    const lease = await ownership.json() as { leaseToken?: string; acquired?: boolean };
    if (!lease.acquired || !lease.leaseToken) throw new Error('Recovery ownership was not granted');
    state.leaseToken = lease.leaseToken;
  } catch (error) {
    await sendEvent('recovery.skipped', target, state, { reason: 'ownership_unavailable', error: error instanceof Error ? error.message : String(error) });
    state.attempts -= 1;
    states.set(target.id, state);
    return;
  }
  await sendEvent('recovery.requested', target, state, { attempt: state.attempts, error: result.error });
  try {
    const response = await request('/api/kubernetes/agent/recovery', { method: 'POST', body: JSON.stringify({ agentId, incidentId: state.incidentId, monitorId: target.id, service, leaseToken: state.leaseToken, action: 'START_CONTAINER' }) });
    if (!response.ok) throw new Error(`Backend rejected recovery (${response.status}): ${(await response.text()).slice(0, 500)}`);
    console.log(JSON.stringify({ event: 'agent.recovery_accepted', monitorId: target.id, attempt: state.attempts }));
    await sendEvent('recovery.started', target, state, { attempt: state.attempts });
  } catch (error) {
    await sendEvent('recovery.failed', target, state, { attempt: state.attempts, error: error instanceof Error ? error.message : 'Recovery request failed' });
  }
  state.leaseToken = undefined;
  states.set(target.id, state);
}

async function trafficMonitor(config: Config): Promise<void> {
  const traffic = config.traffic;
  if (!traffic?.prometheusUrl) return;
  try {
    const query = `sum(rate(${traffic.requestMetric}[1m]))`;
    const response = await fetchBounded(`${traffic.prometheusUrl.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`, {}, 2000);
    if (!response.ok) throw new Error(`Prometheus returned HTTP ${response.status}`);
    const body = await response.json() as { status?: string; data?: { result?: Array<{ value?: [number, string] }> } };
    const rps = Number(body.data?.result?.[0]?.value?.[1] ?? 0);
    if (body.status !== 'success' || !Number.isFinite(rps)) throw new Error('Prometheus returned no traffic sample');
    const payload = { agentId, eventType: 'traffic.sample', service: 'test-service', rps, collector: agentId, dataSource: traffic.source, deduplicationKey: String(Math.floor(Date.now() / (traffic.intervalSeconds * 1000))) };
    await request('/api/kubernetes/agent/events', { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'agent.traffic_monitor_unavailable', error: error instanceof Error ? error.message : String(error) }));
  }
}

function startTrafficMonitor(): void {
  const run = async () => {
    if (!monitoring) return;
    const current = lastConfig;
    if (current) await trafficMonitor(current);
    trafficTimer = setTimeout(() => void run(), Math.max(1, current?.traffic?.intervalSeconds ?? 5) * 1000);
  };
  void run();
}

async function loop(): Promise<void> {
  while (monitoring) {
    try {
      lastConfig = await config();
      await heartbeat();
      const results = await Promise.allSettled(lastConfig.endpoints.map((target) => monitorTarget(target, lastConfig as Config)));
      for (const result of results) if (result.status === 'rejected') console.error(JSON.stringify({ event: 'agent.monitor_failed', error: result.reason instanceof Error ? result.reason.message : String(result.reason) }));
      lastHealthCheckAt = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, lastConfig?.policy.intervalSeconds ?? 5) * 1000));
    } catch (error) {
      console.error(JSON.stringify({ event: 'agent.backend_unavailable', error: error instanceof Error ? error.message : String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

const port = Number(process.env.PORT ?? 8080);
http.createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', agentId })); return; }
  if (request.url === '/ready') { const ready = Boolean(lastConfig); response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: ready ? 'ready' : 'initializing', agentId })); return; }
  response.writeHead(404); response.end();
}).listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ service: 'sentinelops-kubernetes-agent', agentId, modules: ['TRAFFIC_MONITOR', 'API_HEALTH_CHECKER', 'AUTOMATIC_RECOVERY_ENGINE'], port }));
  void loop();
  startTrafficMonitor();
});

process.once('SIGTERM', () => { monitoring = false; if (trafficTimer) clearTimeout(trafficTimer); });
process.once('SIGINT', () => { monitoring = false; if (trafficTimer) clearTimeout(trafficTimer); });
