import type { AlertDatabase, AlertRecord, IncomingAlert } from './db.js';
import { sendAlertEmail } from './email.js';
import type { EventHub } from './events.js';

type PrometheusAlert = { state?: string; labels?: Record<string, string>; annotations?: Record<string, string>; activeAt?: string };
type PrometheusResponse = { status: string; data?: { alerts?: PrometheusAlert[] } };

function toIncoming(alert: PrometheusAlert): IncomingAlert | undefined {
  if (!alert.labels || typeof alert.labels.alertname !== 'string') return undefined;
  const fingerprint = alert.labels.fingerprint ?? stableFingerprint(alert.labels);
  return { status: 'firing', fingerprint, labels: alert.labels, annotations: alert.annotations ?? {}, startsAt: alert.activeAt };
}

function stableFingerprint(labels: Record<string, string>): string {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('|');
}

export function startPrometheusPolling(db: AlertDatabase, dashboardUrl?: string, events?: EventHub): () => void {
  let running = false;
  const prometheusUrl = process.env.PROMETHEUS_URL ?? 'http://prometheus:9090';
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const response = await fetch(`${prometheusUrl}/api/v1/alerts`);
      if (!response.ok) throw new Error(`Prometheus returned ${response.status}`);
      const body = await response.json() as PrometheusResponse;
      if (body.status !== 'success') throw new Error('Prometheus alert API returned an error');
      const active = new Map<string, AlertRecord>();
      for (const raw of body.data?.alerts ?? []) {
        if (raw.state !== 'firing') continue;
        const alert = toIncoming(raw);
        if (!alert) continue;
        const result = db.upsertAlert(alert);
        active.set(alert.fingerprint, result.record);
        if (result.transitioned) {
          events?.publish('incident', {
            fingerprint: alert.fingerprint,
            status: 'FIRING',
            alertName: alert.labels.alertname ?? 'unknown',
            service: alert.labels.service ?? 'unknown',
            severity: alert.labels.severity ?? 'info',
            firstSeenAt: result.record.firstSeenAt
          });
          db.enqueueJob('notification', { alert: result.record, event: 'firing' });
        }
      }
      for (const alert of db.listAlerts({ status: 'firing' })) {
        if (active.has(alert.fingerprint)) continue;
        const resolved: IncomingAlert = { status: 'resolved', fingerprint: alert.fingerprint, labels: alert.labels, annotations: alert.annotations, startsAt: alert.startsAt, endsAt: new Date().toISOString() };
        const result = db.upsertAlert(resolved);
        if (result.transitioned) {
          events?.publish('recovery', {
            fingerprint: alert.fingerprint,
            status: 'RESOLVED',
            alertName: alert.labels.alertname ?? 'unknown',
            service: alert.labels.service ?? 'unknown',
            severity: alert.labels.severity ?? 'info',
            resolvedAt: result.record.lastSeenAt
          });
          db.enqueueJob('notification', { alert: result.record, event: 'resolved' });
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ service: 'sentinelops-alert-manager', error: String(error), msg: 'prometheus polling failed' }));
    } finally { running = false; }
  };
  void poll();
  const timer = setInterval(() => void poll(), 2000);
  return () => clearInterval(timer);
}

export function startNotificationWorker(db: AlertDatabase, dashboardUrl?: string, events?: EventHub): () => void {
  let running = false;
  const process = async () => {
    if (running) return;
    let job: { id: number; kind: string; payload: unknown; attempts: number } | undefined;
    running = true;
    try {
      job = db.claimJob();
      if (!job) return;
      if (job.kind !== 'notification' || !job.payload || typeof job.payload !== 'object') { db.failJob(job.id, 'Unsupported job'); return; }
      const payload = job.payload as { alert: AlertRecord; event: 'firing' | 'resolved' };
      const delivery = await sendAlertEmail(payload.alert, payload.event, db.getSettings(), dashboardUrl, (entry) => db.recordEmail(entry));
      events?.publish('notification', {
        fingerprint: payload.alert.fingerprint,
        event: payload.event.toUpperCase(),
        status: delivery?.status ?? 'skipped',
        deliveryId: delivery?.id
      });
      if (delivery || !db.getSettings().enabled) db.completeJob(job.id);
      else db.completeJob(job.id);
    } catch (error) {
      console.error(JSON.stringify({ service: 'sentinelops-alert-manager', error: String(error), msg: 'notification job failed' }));
      if (job) {
        events?.publish('notification', { status: 'failed', jobId: job.id, attempts: job.attempts });
        const retryAt = job.attempts < 3 ? new Date(Date.now() + (250 * 2 ** job.attempts)).toISOString() : undefined;
        db.failJob(job.id, String(error), retryAt);
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => void process(), 250);
  return () => clearInterval(timer);
}
