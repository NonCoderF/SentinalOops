import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { AlertDatabase } from '../src/db.js';

const service = (db: AlertDatabase, name: string, priority: 'HIGH'|'NORMAL'|'LOW') => db.saveRegisteredService({ id: crypto.randomUUID(), name, description: '', dockerEngine: 'default', containerId: `${name}-id`, containerName: name, monitoringEnabled: true, intervalSeconds: 5, failureThreshold: 3, timeoutSeconds: 2, autoRecoveryEnabled: true, recoveryAction: 'RESTART_CONTAINER', priority, cooldownSeconds: 60, verificationTimeoutSeconds: 10, maxAttempts: 1, endpoints: [{ id: crypto.randomUUID(), serviceId: '', friendlyName: 'health', url: `http://${name}/health`, expectedStatus: 200, enabled: true }] });

describe('registered service recovery queue', () => {
  it('orders by priority, enforces global active ownership, and deduplicates', () => {
    const db = new AlertDatabase(':memory:', 'test-key');
    try {
      const normal = service(db, 'payment-service', 'NORMAL');
      const high = service(db, 'auth-service', 'HIGH');
      const first = db.enqueueRecovery(normal, 'incident-normal', 'agent-1');
      const duplicate = db.enqueueRecovery(normal, 'incident-normal', 'agent-2');
      assert.equal(duplicate.id, first.id);
      db.enqueueRecovery(high, 'incident-high', 'agent-2');
      const claimed = db.claimNextRecovery();
      assert.equal(claimed?.serviceName, 'auth-service');
      assert.equal(db.claimNextRecovery(), undefined);
      db.updateRecoveryQueue(claimed!.id, 'RECOVERED');
      assert.equal(db.claimNextRecovery()?.serviceName, 'payment-service');
    } finally { db.close(); }
  });
});
