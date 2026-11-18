import { buildAlertReceiverApp } from './app.js';

const port = Number(process.env.PORT ?? 8090);
const host = process.env.HOST ?? '0.0.0.0';
const app = buildAlertReceiverApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutdown requested');
  try {
    await app.close();
    app.log.info('alert receiver closed');
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, 'alert receiver shutdown failed');
    process.exit(1);
  }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ error }, 'alert receiver startup failed');
  process.exit(1);
}
