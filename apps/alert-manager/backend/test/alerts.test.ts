import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildAlertManagerApp } from '../src/app.js';
import { AlertDatabase } from '../src/db.js';
import { formatAlertEmail, sendAlertEmail } from '../src/email.js';
import { EventHub } from '../src/events.js';

const alert = {
  status: 'firing',
  labels: { alertname: 'ServiceDown', service: 'test-service', severity: 'critical' },
  annotations: { summary: 'Test service is unavailable', description: 'Test service is unavailable.' },
  startsAt: '2026-11-16T00:00:00Z',
  fingerprint: 'fingerprint-1'
};

describe('SentinelOps Alert Manager', () => {
  let app: FastifyInstance;
  let db: AlertDatabase;

  before(async () => {
    db = new AlertDatabase(':memory:', 'test-encryption-key');
    app = buildAlertManagerApp({ db, adminToken: 'admin-token', webhookToken: 'webhook-token', dashboardUrl: 'http://localhost:3005', authEnabled: true });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('requires authentication for management settings', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(response.statusCode, 401);
  });

  it('deduplicates repeated firing events and processes resolved lifecycle', async () => {
    const headers = { authorization: 'Bearer webhook-token' };
    const first = await app.inject({ method: 'POST', url: '/api/webhooks/alertmanager', headers, payload: { alerts: [alert] } });
    const repeated = await app.inject({ method: 'POST', url: '/api/webhooks/alertmanager', headers, payload: { alerts: [alert] } });
    assert.equal(first.statusCode, 202);
    assert.equal(repeated.statusCode, 202);

    const active = await app.inject({ method: 'GET', url: '/api/alerts', headers: { authorization: 'Bearer admin-token' } });
    assert.equal(active.json().total, 1);
    assert.equal(db.getHistory('fingerprint-1').length, 2);

    const resolved = await app.inject({ method: 'POST', url: '/api/webhooks/alertmanager', headers, payload: { alerts: [{ ...alert, status: 'resolved', endsAt: '2026-11-16T00:01:00Z' }] } });
    assert.equal(resolved.statusCode, 202);
    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { authorization: 'Bearer admin-token' } });
    assert.equal(overview.json().active, 0);
    assert.equal(overview.json().resolved, 1);
  });

  it('rejects invalid notification settings', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization: 'Bearer admin-token' }, payload: { smtpPort: 99999, fromEmail: 'not-an-email', recipients: [] } });
    assert.equal(response.statusCode, 400);
  });

  it('formats firing email content without leaking unsafe markup', () => {
    const message = formatAlertEmail({ ...alert, status: 'firing', firstSeenAt: alert.startsAt, lastSeenAt: alert.startsAt }, 'firing', 'http://localhost:3005');
    assert.equal(message.subject, '[CRITICAL] SentinelOps — test-service DOWN');
    assert.match(message.text, /Test service is unavailable/);
    assert.match(message.html, /Open SentinelOps dashboard/);
  });

  it('records bounded SMTP failure after retries', async () => {
    let attempts = 0;
    const settings = { enabled: true, notifyFiring: true, notifyResolved: true, smtpHost: 'smtp.invalid', smtpPort: 587, smtpSecure: true, smtpUsername: 'user', smtpPassword: 'secret', fromEmail: 'from@example.com', recipients: ['to@example.com'], severityFilter: [] };
    const result = await sendAlertEmail({ ...alert, status: 'firing', firstSeenAt: alert.startsAt, lastSeenAt: alert.startsAt }, 'firing', settings, undefined, (delivery) => db.recordEmail(delivery), (() => ({ sendMail: async () => { attempts += 1; throw new Error('connection failed'); } })) as never);
    assert.equal(result?.status, 'failed');
    assert.equal(attempts, 3);
  });

  it('journals lifecycle events once and supports indexed filters', () => {
    const hub = new EventHub((event) => db.recordDashboardEvent(event));
    const event = { fingerprint: 'fingerprint-1', service: 'test-service', severity: 'critical', status: 'FIRING' };
    hub.publish('incident', event);
    hub.publish('incident', event);
    const rows = db.dashboardEvents({ service: 'test-service', severity: 'critical', type: 'incident' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].service_id, 'test-service');
  });
});
