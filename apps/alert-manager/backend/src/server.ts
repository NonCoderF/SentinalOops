import { AlertDatabase } from './db.js';
import { buildAlertManagerApp } from './app.js';
import { startNotificationWorker, startPrometheusPolling } from './poller.js';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { EventHub } from './events.js';

const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? '0.0.0.0';
const databasePath = process.env.DATABASE_PATH ?? './sentinelops.db';
const adminToken = process.env.ADMIN_TOKEN ?? 'local-development-token';
const webhookToken = process.env.ALERTMANAGER_WEBHOOK_TOKEN ?? '';
const encryptionKey = process.env.SETTINGS_ENCRYPTION_KEY ?? 'local-development-encryption-key';

const db = new AlertDatabase(databasePath, encryptionKey);
const events = new EventHub((event) => db.recordDashboardEvent(event));
const envSmtpHost = process.env.SMTP_HOST?.trim();
if (envSmtpHost) {
  const current = db.getSettings();
  const recipients = (process.env.SMTP_RECIPIENTS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  db.saveSettings({
    ...current,
    enabled: process.env.EMAIL_ENABLED === 'true',
    smtpHost: envSmtpHost,
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpUsername: process.env.SMTP_USERNAME ?? current.smtpUsername,
    smtpPassword: process.env.SMTP_PASSWORD ?? current.smtpPassword,
    fromEmail: process.env.SMTP_FROM ?? process.env.SMTP_USERNAME ?? current.fromEmail,
    recipients: recipients.length > 0 ? recipients : current.recipients
  });
}
const app = buildAlertManagerApp({ db, adminToken, webhookToken, dashboardUrl: process.env.DASHBOARD_URL, authEnabled: process.env.AUTH_ENABLED === 'true', events });
const stopPolling = startPrometheusPolling(db, process.env.DASHBOARD_URL, events);
const stopNotifications = startNotificationWorker(db, process.env.DASHBOARD_URL, events);
const frontendNoCache = process.env.FRONTEND_NO_CACHE === 'true';
await app.register(fastifyStatic, {
  root: process.env.STATIC_ROOT ?? path.resolve('apps/alert-manager/frontend/dist'),
  prefix: '/',
  setHeaders: (response, filePath) => {
    const isHtml = path.basename(filePath).toLowerCase() === 'index.html';
    if (frontendNoCache) {
      response.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      response.header('Pragma', 'no-cache');
      response.header('Expires', '0');
    } else if (isHtml) {
      response.header('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    }
  }
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutdown requested');
  await app.close();
  stopPolling();
  stopNotifications();
  db.close();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ error }, 'alert manager startup failed');
  db.close();
  process.exit(1);
}
