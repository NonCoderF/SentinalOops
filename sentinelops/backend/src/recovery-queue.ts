import type { EventHub } from './events.js';
import { controlContainer } from './recovery-controller.js';
import type { AlertDatabase, RegisteredService } from './db.js';

async function verify(service: RegisteredService, timeoutMs: number): Promise<boolean> {
  const endpoints = service.endpoints.filter((endpoint) => endpoint.enabled);
  if (!endpoints.length) return false;
  const checks = await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)) });
      return response.status === endpoint.expectedStatus;
    } catch { return false; }
  }));
  return checks.every(Boolean);
}

async function processOne(db: AlertDatabase, events?: EventHub): Promise<void> {
  const job = db.claimNextRecovery();
  if (!job) return;
  const service = db.getRegisteredService(job.serviceId);
  if (!service || !service.autoRecoveryEnabled || !service.containerId || !service.containerName) {
    db.updateRecoveryQueue(job.id, 'SKIPPED', 'Recovery target is no longer authorized or configured');
    return;
  }
  if (await verify(service, service.timeoutSeconds * 1000)) {
    db.updateRecoveryQueue(job.id, 'SKIPPED', 'Service recovered naturally while queued');
    events?.publish('recovery', { jobId: job.id, service: service.name, status: 'SKIPPED', reason: 'healthy_before_execution' });
    return;
  }
  const attemptId = `${job.id}-${Date.now()}`;
  db.createKubernetesAttempt(attemptId, job.incidentId);
  try {
    // A stopped container cannot be restarted. Resolve the actual state at
    // execution time and start it when necessary; preserve the registered
    // restart policy for containers that are still running.
    const current = await controlContainer('CHECK_CONTAINER_STATUS', service.name, service.verificationTimeoutSeconds * 1000, { containerId: service.containerId, containerName: service.containerName });
    const action = current.state === 'exited' || current.state === 'created' ? 'START_CONTAINER' : job.action;
    events?.publish('recovery', { jobId: job.id, incidentId: job.incidentId, service: service.name, agentId: job.agentId, status: 'RECOVERING', action });
    await controlContainer(action, service.name, service.verificationTimeoutSeconds * 1000, { containerId: service.containerId, containerName: service.containerName });
    db.updateRecoveryQueue(job.id, 'VERIFYING');
    const deadline = Date.now() + service.verificationTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (await verify(service, service.timeoutSeconds * 1000)) {
        db.updateRecoveryQueue(job.id, 'RECOVERED');
        db.finishKubernetesAttempt(attemptId, 'SUCCEEDED', undefined, { verified: true });
        db.updateKubernetesIncident(job.incidentId, { status: 'RECOVERED', recoveredAt: new Date().toISOString() });
        if (job.agentId) db.recordKubernetesAgentEvent(job.agentId, 'recovery.succeeded', { jobId: job.id, attemptId, serviceId: service.id }, job.incidentId);
        events?.publish('recovery', { jobId: job.id, incidentId: job.incidentId, service: service.name, agentId: job.agentId, status: 'RECOVERED' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Recovery verification timed out');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Recovery failed';
    db.updateRecoveryQueue(job.id, 'FAILED', message);
    db.finishKubernetesAttempt(attemptId, 'FAILED', message);
    db.updateKubernetesIncident(job.incidentId, { status: 'FAILED', error: message });
    if (job.agentId) db.recordKubernetesAgentEvent(job.agentId, 'recovery.failed', { jobId: job.id, attemptId, error: message }, job.incidentId);
    events?.publish('recovery', { jobId: job.id, incidentId: job.incidentId, service: service.name, agentId: job.agentId, status: 'FAILED', error: message });
  }
}

export function startRecoveryQueue(db: AlertDatabase, events?: EventHub): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await processOne(db, events); } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 1000);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
