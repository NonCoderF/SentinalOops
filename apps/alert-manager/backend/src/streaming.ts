import crypto from 'node:crypto';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { AlertStatus, IncomingAlert } from './db.js';

export const ALERT_TOPIC = process.env.KAFKA_ALERT_TOPIC ?? 'sentinelops.alerts';
export const DLQ_TOPIC = process.env.KAFKA_DLQ_TOPIC ?? 'sentinelops.alerts.dlq';

export interface AlertEvent {
  eventId: string;
  schemaVersion: 1;
  fingerprint: string;
  status: Uppercase<AlertStatus>;
  alertName: string;
  service: string;
  severity: string;
  description: string;
  startsAt?: string;
  endsAt?: string;
  receivedAt: string;
  source: 'alertmanager';
}

export function validateAlertEvent(value: unknown): value is AlertEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return event.schemaVersion === 1 && typeof event.eventId === 'string' && event.eventId.length > 0 &&
    typeof event.fingerprint === 'string' && event.fingerprint.length > 0 &&
    (event.status === 'FIRING' || event.status === 'RESOLVED') &&
    typeof event.alertName === 'string' && typeof event.service === 'string' &&
    typeof event.severity === 'string' && typeof event.description === 'string' &&
    typeof event.receivedAt === 'string' && event.source === 'alertmanager';
}

export function toAlertEvent(alert: IncomingAlert, receivedAt = new Date().toISOString()): AlertEvent {
  const alertName = alert.labels.alertname ?? 'unknown';
  const service = alert.labels.service ?? alert.labels.job ?? 'unknown-service';
  const description = alert.annotations.description ?? alert.annotations.summary ?? 'No description provided.';
  const status = alert.status === 'firing' ? 'FIRING' : 'RESOLVED';
  const identity = `${alert.fingerprint}:${status}:${alert.startsAt ?? ''}:${alert.endsAt ?? ''}`;
  return {
    eventId: crypto.createHash('sha256').update(identity).digest('hex'),
    schemaVersion: 1,
    fingerprint: alert.fingerprint,
    status,
    alertName,
    service,
    severity: alert.labels.severity ?? 'info',
    description,
    startsAt: alert.startsAt,
    endsAt: alert.endsAt,
    receivedAt,
    source: 'alertmanager'
  };
}

export interface StreamingStats { published: number; processed: number; failures: number; recentEvents: AlertEvent[]; consumers: Record<string, { connected: boolean; lastEventAt?: string; failures: number }> }

export class KafkaEventBus {
  readonly kafka: Kafka;
  readonly producer: Producer;
  private connected = false;
  private readonly topic: string;

  constructor(brokers = (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(','), clientId = 'sentinelops-backend', topic = ALERT_TOPIC) {
    this.kafka = new Kafka({ clientId, brokers, logLevel: logLevel.NOTHING, connectionTimeout: 5000, requestTimeout: 10000, retry: { retries: 3 } });
    this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1, retry: { retries: 3 } });
    this.topic = topic;
  }

  async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({ waitForLeaders: true, topics: [
        { topic: this.topic, numPartitions: 3, replicationFactor: 1, configEntries: [{ name: 'retention.ms', value: process.env.KAFKA_RETENTION_MS ?? '604800000' }] },
        { topic: DLQ_TOPIC, numPartitions: 3, replicationFactor: 1, configEntries: [{ name: 'retention.ms', value: process.env.KAFKA_RETENTION_MS ?? '604800000' }] }
      ] });
    } finally { await admin.disconnect(); }
  }

  async connect(): Promise<void> { await this.ensureTopics(); await this.producer.connect(); this.connected = true; }
  isConnected(): boolean { return this.connected; }
  async publish(event: AlertEvent): Promise<void> { if (!validateAlertEvent(event)) throw new Error('Invalid alert event'); await this.producer.send({ topic: this.topic, acks: -1, messages: [{ key: event.fingerprint, value: JSON.stringify(event), headers: { 'schema-version': '1' } }] }); }
  async close(): Promise<void> { if (this.connected) await this.producer.disconnect(); this.connected = false; }
}

export function parseKafkaEvent(value: Buffer | string | null): AlertEvent {
  const parsed = JSON.parse(value?.toString() ?? 'null') as unknown;
  if (!validateAlertEvent(parsed)) throw new Error('Invalid SentinelOps alert event');
  return parsed;
}

export type KafkaConsumer = Consumer;
