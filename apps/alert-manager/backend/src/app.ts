import crypto from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AlertDatabase, type AlertRecord, type IncomingAlert, type NotificationSettings, type RecoveryActionType, type RecoveryMode, type RecoveryRunbook } from './db.js';
import { sendAlertEmail, sendTestEmail, validateEmail } from './email.js';
import { toAlertEvent, type AlertEvent } from './streaming.js';
import { EventHub } from './events.js';
import { controlContainer } from './recovery-controller.js';

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

function instantValue(data: { result?: Array<{ value?: [number, string] }> } | null, labels?: Record<string, string>): PromValue {
  const row = data?.result?.find((entry) => !labels || Object.entries(labels).every(([key, value]) => entry.value && value === String(value))) ?? data?.result?.[0];
  const value = row?.value?.[1];
  const number = value === undefined ? null : Number(value);
  return number !== undefined && Number.isFinite(number) ? number : null;
}

async function dashboardData(range: string, db: AlertDatabase) {
  const allowed = new Set(['5m', '15m', '1h', '6h', '24h']);
  const window = allowed.has(range) ? range : '15m';
  const q = (expr: string) => prometheusJson<{ result?: Array<{ metric: Record<string, string>; value?: [number, string] }> }>(`/api/v1/query?query=${encodeURIComponent(expr)}`);
  const rq = (expr: string) => prometheusJson<{ result?: Array<{ metric: Record<string, string>; values?: [number, string][] }> }>(`/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${(Date.now() / 1000 - ({ '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 } as Record<string, number>)[window]).toFixed(0)}&end=${(Date.now() / 1000).toFixed(0)}&step=${window === '24h' ? 900 : window === '6h' ? 300 : 30}`);
  const [up, cpu, memory, requestRate, errorRate, latency, availability, rangeCpu, rangeMemory, rangeRequests, rangeLatency, rangeErrors, rangeAvailability, connections, settings] = await Promise.all([
    q('up'), q('sum by (job) (rate(sentinelops_process_cpu_user_seconds_total[30s]) + rate(sentinelops_process_cpu_system_seconds_total[30s]))'),
    q('sentinelops_process_resident_memory_bytes'), q('sum by (job) (rate(sentinelops_http_requests_total[30s]))'),
    q('sum by (job) (rate(sentinelops_http_requests_total{status_code=~"5.."}[30s]))'),
    q('histogram_quantile(0.95, sum by (job, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    q('avg by (job) (avg_over_time(up[15m]))'),
    rq('sum by (job) (rate(sentinelops_process_cpu_user_seconds_total[30s]) + rate(sentinelops_process_cpu_system_seconds_total[30s]))'),
    rq('sentinelops_process_resident_memory_bytes'), rq('sum by (job) (rate(sentinelops_http_requests_total[30s]))'),
    rq('histogram_quantile(0.95, sum by (job, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    rq('sum by (job) (rate(sentinelops_http_requests_total{status_code=~"5.."}[30s]))'), rq('avg by (job) (avg_over_time(up[15m]))'),
    Promise.all([
      `${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}/-/ready`,
      `${process.env.GRAFANA_URL ?? 'http://grafana:3000'}/api/health`,
      `${process.env.RECOVERY_CONTROLLER_URL ?? 'http://recovery-controller:8090'}/health`
    ].map(endpointStatus)),
    Promise.resolve(db.getSettings())
  ]);
  const [latencyP50, latencyP99, rangeLatencyP50, rangeLatencyP99] = await Promise.all([
    q('histogram_quantile(0.50, sum by (job, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    q('histogram_quantile(0.99, sum by (job, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    rq('histogram_quantile(0.50, sum by (job, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))'),
    rq('histogram_quantile(0.99, sum by (job, le) (rate(sentinelops_http_request_duration_seconds_bucket[30s])))')
  ]);
  // Load-test metrics are an auxiliary observability target, not a monitored application service.
  const upRows = (up?.result ?? []).filter((row) => row.metric.job !== 'sentinelops-load-test');
  const alerts = db.listAlerts({});
  const metric = (rows: typeof upRows, job: string) => instantValue({ result: rows.filter((row) => row.metric.job === job) });
  const series = (data: { result?: Array<{ metric: Record<string, string>; values?: [number, string][] }> } | null) => (data?.result ?? []).map((row) => ({ job: row.metric.job ?? 'unknown', points: (row.values ?? []).map(([time, value]) => [time, Number(value)]).filter((point) => Number.isFinite(point[1])) }));
  const services = upRows.map((row) => { const job = row.metric.job ?? 'unknown'; const serviceName = job === 'sentinelops-test-service' ? 'test-service' : job; const lastFailure = alerts.filter((alert) => alert.labels.service === serviceName).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))[0]; return { name: serviceName, job, status: row.value?.[1] === '1' ? 'UP' : 'DOWN', cpu: metric(cpu?.result ?? [], job), memory: metric(memory?.result ?? [], job), requests: metric(requestRate?.result ?? [], job), errors: metric(errorRate?.result ?? [], job), latency: metric(latency?.result ?? [], job), availability: metric(availability?.result ?? [], job), checkedAt: row.value?.[0] ? new Date(row.value[0] * 1000).toISOString() : null, lastFailure: lastFailure?.firstSeenAt ?? null }; });
  const deliveries = db.listEmails();
  const executions = db.recoveryExecutions();
  const active = alerts.filter((alert) => alert.status === 'firing').length;
  const success = executions.filter((run) => run.status === 'SUCCESS');
  const finished = executions.filter((run) => ['SUCCESS', 'FAILED', 'TIMED_OUT'].includes(String(run.status)));
  const durations = finished.map((run) => run.completed_at && run.started_at ? new Date(String(run.completed_at)).getTime() - new Date(String(run.started_at)).getTime() : 0).filter((value) => value > 0);
  const journal = db.dashboardEvents({ limit: 200 });
  const activity = journal.map((event) => { let metadata: Record<string, unknown> = {}; try { metadata = JSON.parse(String(event.metadata_json)) as Record<string, unknown>; } catch { /* old/corrupt metadata is displayed without detail */ } return { id: String(event.event_id), type: String(event.event_type), label: `${String(event.event_type).toUpperCase()} · ${String(event.status ?? 'RECORDED')}`, detail: `${String(event.service_id ?? 'unknown service')} · ${String(metadata.alertName ?? metadata.actionType ?? metadata.subject ?? '')}`.trim(), at: String(event.occurred_at), incidentId: event.incident_id, severity: event.severity, status: event.status, metadata }; });
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
  const recipients = Array.isArray(body.recipients) ? body.recipients.filter((item): item is string => typeof item === 'string').map((item) => item.trim()) : current.recipients;
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
function parseRunbook(body:unknown){if(!isRecord(body))return{error:'Runbook body must be an object'};const name=typeof body.name==='string'?body.name.trim():'';const service=typeof body.service==='string'?body.service.trim():'';const actionType=body.actionType as RecoveryActionType;const mode:RecoveryMode=body.mode==='AUTOMATIC'?'AUTOMATIC':'MANUAL';const parameters=isRecord(body.parameters)&&Object.values(body.parameters).every(v=>typeof v==='string')?body.parameters as Record<string,string>:{};const endpoint=typeof body.verificationEndpoint==='string'?body.verificationEndpoint.trim():'/health';if(!name||name.length>100)return{error:'Runbook name is required and must be at most 100 characters'};if(service!=='test-service')return{error:'Only test-service is allowlisted for recovery'};if(!recoveryActions.has(actionType))return{error:'Unsupported recovery action'};if(!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(endpoint))return{error:'Verification endpoint must be a relative HTTP path'};if(Object.values(parameters).some(v=>/[;&|`$<>\r\n]/.test(v)))return{error:'Command metacharacters are not allowed'};const integer=(v:unknown,d:number,min:number,max:number)=>{const n=typeof v==='number'?v:Number(v??d);return Number.isInteger(n)&&n>=min&&n<=max?n:d};return{value:{name,description:typeof body.description==='string'?body.description.slice(0,1000):'',service,actionType,parameters,timeoutSeconds:integer(body.timeoutSeconds,30,1,300),verificationEndpoint:endpoint,maxAttempts:integer(body.maxAttempts,1,1,5),cooldownSeconds:integer(body.cooldownSeconds,300,0,86400),mode,enabled:body.enabled===undefined?true:Boolean(body.enabled)}};}

async function verifyService(endpoint: string, timeoutMs: number): Promise<boolean> {
  try { const response = await fetch(`${process.env.TEST_SERVICE_URL ?? 'http://test-service:8080'}${endpoint}`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)) }); return response.ok; } catch { return false; }
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
      if (await verifyService(runbook.verificationEndpoint, 5000)) successes += 1; else successes = 0;
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


export function buildAlertManagerApp(options: { db: AlertDatabase; adminToken: string; webhookToken: string; dashboardUrl?: string; authEnabled?: boolean; publisher?: { publish(event: AlertEvent): Promise<void>; isConnected?: () => boolean }; events?: EventHub }): FastifyInstance {
  const { db, adminToken, webhookToken, dashboardUrl, authEnabled = process.env.AUTH_ENABLED === 'true', publisher, events } = options;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'sentinelops-alert-manager' }, redact: ['req.headers.authorization', 'req.query.token', 'body.smtpPassword'] } });

  void app.register(cors, { origin: ['http://localhost:3005', 'http://127.0.0.1:3005'] });
  void app.register(rateLimit, { global: false });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authEnabled) return;
    if (!tokenFromRequest(request) || !safeEqual(tokenFromRequest(request) as string, adminToken)) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  };

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
    return delivery.status === 'sent' ? { status: 'sent', delivery } : reply.code(502).send({ status: 'failed', delivery });
  });

  app.get('/api/notifications/history', { preHandler: requireAdmin }, async () => ({ deliveries: db.listEmails() }));

  app.get('/api/recovery/history', { preHandler: requireAdmin }, async () => ({ recoveries: db.recoveryHistory() }));

  app.get('/api/recovery/runbooks',{preHandler:requireAdmin},async()=>({runbooks:db.listRunbooks(),executionEnabled:Boolean(process.env.RECOVERY_CONTROLLER_URL),executionMessage:'Only the allowlisted test-service can be controlled by the private recovery controller.'}));
  app.post('/api/recovery/runbooks',{preHandler:requireAdmin},async(request,reply)=>{const parsed=parseRunbook(request.body);if(!parsed.value)return reply.code(400).send({error:parsed.error});return{runbook:db.saveRunbook(parsed.value)};});
  app.put('/api/recovery/runbooks/:id',{preHandler:requireAdmin},async(request,reply)=>{const id=Number((request.params as {id:string}).id);if(!db.getRunbook(id))return reply.code(404).send({error:'Runbook not found'});const parsed=parseRunbook(request.body);if(!parsed.value)return reply.code(400).send({error:parsed.error});return{runbook:db.saveRunbook(parsed.value,id)};});
  app.get('/api/recovery/executions',{preHandler:requireAdmin},async()=>({executions:db.recoveryExecutions()}));
  app.post('/api/recovery/runbooks/:id/execute',{preHandler:requireAdmin},async(request,reply)=>{const runbook=db.getRunbook(Number((request.params as {id:string}).id));if(!runbook||!runbook.enabled)return reply.code(404).send({error:'Enabled runbook not found'});if(runbook.mode!=='MANUAL')return reply.code(409).send({error:'Automatic runbooks must be triggered by an active incident'});if(db.activeRecoveryForService(runbook.service))return reply.code(409).send({error:'A recovery attempt is already running for this service'});const executionId=db.createRecoveryExecution(runbook,'MANUAL','Approved manually from the Recovery panel.');events?.publish('recovery',{executionId,runbookId:runbook.id,status:'RUNNING',service:runbook.service,actionType:runbook.actionType});void runRecovery(executionId,runbook,db,events);return reply.code(202).send({status:'started',executionId});});


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

  return app;
}
