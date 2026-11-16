import Fastify, { type FastifyInstance } from 'fastify';

type AlertStatus = 'firing' | 'resolved';

interface AlertmanagerAlert {
  status: AlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  fingerprint: string;
}

interface AlertEvent extends AlertmanagerAlert {
  receivedAt: string;
}

interface AlertmanagerPayload {
  status: AlertStatus;
  alerts: AlertmanagerAlert[];
}

const MAX_HISTORY = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;

  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function parsePayload(body: unknown): AlertmanagerPayload | null {
  if (!isRecord(body) || !Array.isArray(body.alerts)) return null;

  const payloadStatus = body.status;
  if (payloadStatus !== 'firing' && payloadStatus !== 'resolved') return null;

  const alerts: AlertmanagerAlert[] = [];
  for (const item of body.alerts) {
    if (!isRecord(item)) return null;

    const status = item.status;
    const labels = stringMap(item.labels);
    const annotations = stringMap(item.annotations);
    const fingerprint = item.fingerprint;
    if ((status !== 'firing' && status !== 'resolved') || !labels || !annotations || typeof fingerprint !== 'string' || fingerprint.length === 0) {
      return null;
    }

    alerts.push({
      status,
      labels,
      annotations,
      startsAt: typeof item.startsAt === 'string' ? item.startsAt : undefined,
      endsAt: typeof item.endsAt === 'string' ? item.endsAt : undefined,
      fingerprint
    });
  }

  return { status: payloadStatus, alerts };
}

export function buildAlertReceiverApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service: 'sentinelops-alert-receiver' }
    }
  });

  const activeAlerts = new Map<string, AlertEvent>();
  const history: AlertEvent[] = [];

  app.get('/health', async () => ({
    status: 'ok',
    activeAlerts: activeAlerts.size,
    uptime: process.uptime()
  }));

  app.get('/alerts', async () => ({
    status: 'ok',
    activeCount: activeAlerts.size,
    active: Array.from(activeAlerts.values()),
    history
  }));

  app.post('/alerts', async (request, reply) => {
    const payload = parsePayload(request.body);
    if (!payload) {
      return reply.code(400).send({ error: 'Invalid Alertmanager webhook payload' });
    }

    const receivedAt = new Date().toISOString();
    for (const alert of payload.alerts) {
      const event = { ...alert, receivedAt };
      if (alert.status === 'firing') {
        activeAlerts.set(alert.fingerprint, event);
      } else {
        activeAlerts.delete(alert.fingerprint);
      }

      history.unshift(event);
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

      request.log.info({
        status: alert.status,
        fingerprint: alert.fingerprint,
        labels: alert.labels,
        description: alert.annotations.description,
        receivedAt
      }, `alert ${alert.status}`);
    }

    return reply.code(202).send({
      status: 'accepted',
      received: payload.alerts.length,
      activeCount: activeAlerts.size
    });
  });

  return app;
}
