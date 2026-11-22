import type { AlertDatabase, RecoveryControllerMode } from './db.js';

export type RecoveryModeName = 'MANUAL' | 'KUBERNETES';

export class RecoveryModeManager {
  private switching = false;
  private generation = 0;

  constructor(private readonly db: AlertDatabase, private readonly application = 'test-service') {}

  current() { return this.db.getRecoveryControllerMode(this.application); }
  currentMode(): RecoveryModeName { return this.current().mode === 'MANUAL' ? 'MANUAL' : 'KUBERNETES'; }
  getGeneration(): number { return this.generation; }
  isActive(mode: RecoveryModeName): boolean { return this.currentMode() === mode; }

  switchTo(mode: RecoveryModeName) {
    if (this.switching) throw new Error('A recovery mode transition is already in progress');
    this.switching = true;
    const previous = this.current();
    try {
      this.generation += 1;
      const runtime = mode === 'MANUAL' ? 'docker-compose' : 'kubernetes';
      const state = mode === 'MANUAL' ? 'MANUAL_ACTIVE' : 'KUBERNETES_ACTIVE';
      const reason = mode === 'MANUAL' ? 'Manual Runbook recovery is active.' : 'Kubernetes Recovery is active; Manual Recovery execution is disabled.';
      this.db.setRecoveryControllerMode(this.application, mode as RecoveryControllerMode, runtime, state, reason);
      return { previous, current: this.current(), generation: this.generation };
    } finally {
      this.switching = false;
    }
  }

  assertActive(mode: RecoveryModeName): void {
    if (!this.isActive(mode)) throw new Error(`${mode === 'MANUAL' ? 'Manual Recovery' : 'Kubernetes Recovery'} is not the active recovery mode`);
  }
}
