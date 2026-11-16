export type AlertEventStatus = 'FIRING' | 'RESOLVED';

export interface SentinelOpsAlertEvent {
  eventId: string;
  schemaVersion: 1;
  fingerprint: string;
  status: AlertEventStatus;
  alertName: string;
  service: string;
  severity: string;
  description: string;
  startsAt?: string;
  endsAt?: string;
  receivedAt: string;
  source: 'alertmanager';
}

export function isSentinelOpsAlertEvent(value: unknown): value is SentinelOpsAlertEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return event.schemaVersion === 1 && typeof event.eventId === 'string' && typeof event.fingerprint === 'string' &&
    (event.status === 'FIRING' || event.status === 'RESOLVED') && typeof event.alertName === 'string' &&
    typeof event.service === 'string' && typeof event.severity === 'string' && typeof event.description === 'string' &&
    typeof event.receivedAt === 'string' && event.source === 'alertmanager';
}
