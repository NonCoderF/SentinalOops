i import Fastify, { type FastifyInstance } from 'fastify';
import client from 'prom-client';

const { Counter, Histogram, Registry, collectDefaultMetrics } = client;

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: { base: { service: 'sentinelops-test-service-2' } } });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'sentinelops_service_2_' });
  const requests = new Counter({ name: 'sentinelops_http_requests_total', help: 'Total requests handled by Test Service 2', labelNames: ['method', 'route', 'status_code'] as const, registers: [registry] });
  const durations = new Histogram({ name: 'sentinelops_http_request_duration_seconds', help: 'Request duration for Test Service 2', labelNames: ['method', 'route', 'status_code'] as const, registers: [registry] });

  app.addHook('onRequest', async (request) => { request.startTime = process.hrtime.bigint(); });
  app.addHook('onResponse', async (request, reply) => {
    const elapsed = Number(process.hrtime.bigint() - request.startTime) / 1e9;
    const labels = { method: request.method, route: request.routeOptions.url ?? request.url, status_code: String(reply.statusCode) };
    requests.inc(labels); durations.observe(labels, elapsed);
  });

  app.get('/', async () => ({ message: 'Welcome to SentinelOps Test Service 2', service: 'test-service-2' }));
  app.get('/health', async () => ({ status: 'ok', service: 'test-service-2', timestamp: new Date().toISOString(), uptime: process.uptime() }));
  app.get('/api/health', async () => ({ status: 'ok', service: 'test-service-2', timestamp: new Date().toISOString() }));
  app.get('/api/catalog', async () => ({ data: [{ sku: 'catalog-101', name: 'Recovery Sensor' }, { sku: 'catalog-202', name: 'Agent Relay' }] }));
  app.get('/api/orders', async () => ({ data: [{ id: 'order-2001', status: 'READY' }, { id: 'order-2002', status: 'PROCESSING' }] }));
  app.get('/metrics', async (_request, reply) => { reply.type(registry.contentType); return registry.metrics(); });
  return app;
}

declare module 'fastify' { interface FastifyRequest { startTime: bigint; } }
