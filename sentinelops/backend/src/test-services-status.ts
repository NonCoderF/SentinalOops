import { existsSync } from 'node:fs';
import { readTestServiceStatus } from './test-service-status.js';

export type TestServiceTarget = {
  service: string;
  displayName: string;
  container: string;
  url: string;
};

export function configuredTestServices(): TestServiceTarget[] {
  const dockerHost = process.env.TEST_SERVICE_STATUS_HOST?.trim() || (existsSync('/.dockerenv') || process.env.TEST_SERVICE_URL?.includes('host.docker.internal') ? 'host.docker.internal' : '127.0.0.1');
  return [
    {
      service: 'test-service',
      displayName: 'Test Service',
      container: process.env.TEST_SERVICE_CONTAINER ?? 'sentinelops-test-service',
      url: process.env.TEST_SERVICE_URL ?? `http://${dockerHost}:8080/api/health`
    },
    {
      service: 'test-service-2',
      displayName: 'Test Service 2',
      container: process.env.TEST_SERVICE_2_CONTAINER ?? 'sentinelops-test-service-2',
      url: process.env.TEST_SERVICE_2_URL ?? `http://${dockerHost}:8081/api/health`
    }
  ];
}

export async function readConfiguredTestServiceStatuses() {
  return Promise.all(configuredTestServices().map(async (target) => ({
    service: target.service,
    displayName: target.displayName,
    ...(await readTestServiceStatus({ containerName: target.container, target: target.url }))
  })));
}
