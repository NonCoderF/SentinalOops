import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('test-service endpoints', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('GET /health returns service health details', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.timestamp, 'string');
    assert.equal(typeof body.uptime, 'number');
  });

  it('GET /metrics exposes Prometheus metrics', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/plain/);
    assert.match(response.body, /sentinelops_http_requests_total/);
    assert.match(response.body, /sentinelops_process_cpu_user_seconds_total/);
  });
});
