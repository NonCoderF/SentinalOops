import { buildApp } from './app.js';

const app = buildApp();
try {
  await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
