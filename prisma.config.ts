import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'alert-manager/prisma/schema.prisma',
  migrations: { path: 'alert-manager/prisma/migrations' },
  datasource: { url: env('DATABASE_URL') }
});
