import Fastify, { type FastifyInstance } from 'fastify';
import client from 'prom-client';

const { Counter, Histogram, Registry, collectDefaultMetrics } = client;

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service: 'sentinelops-test-service' },
      redact: ['req.headers.authorization']
    }
  });

  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'sentinelops_' });

  const httpRequestsTotal = new Counter({
    name: 'sentinelops_http_requests_total',
    help: 'Total number of HTTP requests handled by the service',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry]
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'sentinelops_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry]
  });

  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const elapsed = Number(process.hrtime.bigint() - request.startTime) / 1e9;
    const route = request.routeOptions.url ?? request.url;
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, elapsed);
  });

  app.get('/', async () => ({
    message: 'Welcome to SentinelOps',
    service: 'test-service'
  }));

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  }));

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'test-service',
    timestamp: new Date().toISOString()
  }));

  app.get('/api/users', async () => ({
    data: [
      { id: 1, name: 'Ada Lovelace' },
      { id: 2, name: 'Grace Hopper' }
    ]
  }));

  app.get('/api/products', async () => ({
    data: [
      { id: 'sentinel-1', name: 'Monitoring Starter' },
      { id: 'sentinel-2', name: 'Recovery Pack' }
    ]
  }));

  app.get('/metrics', async (_request, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime: bigint;
  }
}
