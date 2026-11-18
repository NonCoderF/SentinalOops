import type { RecoveryActionType } from './db.js';

export interface ControllerResult { action: string; containerId: string; state: string; health: string; }

export async function controlContainer(action: RecoveryActionType, service: string, timeoutMs = 10000): Promise<ControllerResult> {
  if (!['START_CONTAINER', 'RESTART_CONTAINER', 'CHECK_CONTAINER_STATUS'].includes(action)) throw new Error('This recovery action is not supported by the Docker control boundary');
  const controller = process.env.RECOVERY_CONTROLLER_URL ?? 'http://recovery-controller:8090';
  const token = process.env.RECOVERY_CONTROLLER_TOKEN ?? '';
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${controller}/v1/recovery`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ service, action })
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & Partial<ControllerResult>;
  if (!response.ok) throw new Error(body.error ?? `Recovery controller returned ${response.status}`);
  if (typeof body.containerId !== 'string' || body.state !== 'running') throw new Error('Recovery controller did not report a running container');
  return body as ControllerResult;
}
