import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryModeManager } from '../src/recovery-mode.js';
import type { AlertDatabase } from '../src/db.js';

function fakeDatabase() {
  let mode: 'MANUAL' | 'KUBERNETES' = 'KUBERNETES';
  const db = {
    getRecoveryControllerMode: () => ({ application: 'test-service', mode, runtime: mode === 'MANUAL' ? 'docker-compose' : 'kubernetes', state: `${mode}_ACTIVE`, reason: '', updatedAt: '' }),
    setRecoveryControllerMode: (_application: string, next: 'MANUAL' | 'KUBERNETES') => { mode = next; }
  };
  return db as unknown as AlertDatabase;
}

test('recovery mode is exclusive and transitions increment the generation', () => {
  const manager = new RecoveryModeManager(fakeDatabase());
  assert.equal(manager.currentMode(), 'KUBERNETES');
  assert.equal(manager.isActive('MANUAL'), false);
  const transition = manager.switchTo('MANUAL');
  assert.equal(transition.current.mode, 'MANUAL');
  assert.equal(manager.currentMode(), 'MANUAL');
  assert.equal(manager.getGeneration(), 1);
  assert.throws(() => manager.assertActive('KUBERNETES'), /Kubernetes Recovery is not the active/);
  manager.switchTo('KUBERNETES');
  assert.equal(manager.currentMode(), 'KUBERNETES');
  assert.equal(manager.getGeneration(), 2);
});
