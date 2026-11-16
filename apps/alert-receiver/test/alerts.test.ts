import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildAlertReceiverApp } from '../src/app.js';

const firingAlert = {
  status: 'firing',
  labels: { alertname: 'ServiceDown', severity: 'critical', service: 'test-service' },
  annotations: { summary: 'Test service is unavailable', description: 'Test service is unavailable.' },
  startsAt: '2026-11-16T00:00:00Z',
  fingerprint: 'service-down-fingerprint'
};

describe('alert receiver webhook', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildAlertReceiverApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('accepts firing alerts and exposes active state', async () => {
    const response = await app.inject({ method: 'POST', url: '/alerts', payload: { status: 'firing', alerts: [firingAlert] } });
    assert.equal(response.statusCode, 202);

    const state = await app.inject({ method: 'GET', url: '/alerts' });
    const body = state.json();
    assert.equal(body.activeCount, 1);
    assert.equal(body.active[0].labels.alertname, 'ServiceDown');
  });

  it('removes resolved alerts from active state and records the event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: {
        status: 'resolved',
        alerts: [{ ...firingAlert, status: 'resolved', endsAt: '2026-11-16T00:01:00Z' }]
      }
    });
    assert.equal(response.statusCode, 202);

    const state = await app.inject({ method: 'GET', url: '/alerts' });
    const body = state.json();
    assert.equal(body.activeCount, 0);
    assert.equal(body.history[0].status, 'resolved');
  });

  it('rejects malformed webhook payloads', async () => {
    const response = await app.inject({ method: 'POST', url: '/alerts', payload: { status: 'firing', alerts: [{ labels: {} }] } });
    assert.equal(response.statusCode, 400);
  });
});
