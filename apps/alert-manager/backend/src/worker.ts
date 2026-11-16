import { AlertDatabase } from './db.js';
import { sendAlertEmail } from './email.js';
import { ALERT_TOPIC, DLQ_TOPIC, KafkaEventBus, parseKafkaEvent, type AlertEvent } from './streaming.js';

const mode = process.env.WORKER_MODE === 'email' ? 'email' : 'incident';
const groupId = process.env.KAFKA_GROUP_ID ?? (mode === 'email' ? 'sentinelops-email-workers' : 'sentinelops-incident-workers');
const consumerName = groupId;
const db = new AlertDatabase(process.env.DATABASE_PATH ?? '/var/lib/sentinelops/sentinelops.db', process.env.SETTINGS_ENCRYPTION_KEY ?? 'local-development-encryption-key');
const bus = new KafkaEventBus(undefined, `sentinelops-${mode}-worker`);
const consumer = bus.kafka.consumer({ groupId, retry: { retries: 8, initialRetryTime: 300, maxRetryTime: 5000 } });
const dlqProducer = bus.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
let stopping = false;

async function sleep(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function processIncident(event: AlertEvent): Promise<void> {
  db.incidentFromEvent(event);
}

async function processEmail(event: AlertEvent): Promise<void> {
  const incident = db.getAlert(event.fingerprint) ?? db.incidentFromEvent(event).record;
  const settings = db.getSettings();
  await sendAlertEmail(incident, event.status === 'FIRING' ? 'firing' : 'resolved', settings, process.env.DASHBOARD_URL, (entry) => db.recordEmail(entry));
}

async function processMessage(value: Buffer | null): Promise<void> {
  const event = parseKafkaEvent(value);
  if (!db.claimEvent(event, consumerName)) return;
  if (mode === 'incident') await processIncident(event); else await processEmail(event);
}

async function sendToDlq(value: Buffer | null, error: unknown): Promise<void> {
  await dlqProducer.send({ topic: DLQ_TOPIC, acks: -1, messages: [{ key: 'failed-event', value: value ?? Buffer.from('null'), headers: { error: String(error), consumer: consumerName } }] });
}

async function main(): Promise<void> {
  await bus.ensureTopics();
  await consumer.connect();
  await dlqProducer.connect();
  db.updateConsumerStatus(consumerName, true);
  await consumer.subscribe({ topic: ALERT_TOPIC, fromBeginning: false });
  await consumer.run({ autoCommit: false, eachMessage: async ({ topic, partition, message, heartbeat }) => {
    if (stopping) return;
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try { await processMessage(message.value); await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]); db.updateConsumerStatus(consumerName, true, new Date().toISOString()); return; }
      catch (error) { lastError = error; db.recordStreamFailure(parseKafkaEventSafe(message.value)); if (attempt < maxAttempts - 1) { await sleep(250 * (2 ** attempt)); await heartbeat(); } }
    }
    await sendToDlq(message.value, lastError);
    await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
    db.updateConsumerStatus(consumerName, true, new Date().toISOString(), true);
  } });
}

function parseKafkaEventSafe(value: Buffer | null): AlertEvent { try { return parseKafkaEvent(value); } catch { return { eventId: `invalid-${Date.now()}`, schemaVersion: 1, fingerprint: 'invalid', status: 'FIRING', alertName: 'InvalidEvent', service: 'sentinelops', severity: 'critical', description: 'Invalid Kafka event', receivedAt: new Date().toISOString(), source: 'alertmanager' }; } }

async function shutdown(signal: string): Promise<void> {
  stopping = true;
  db.updateConsumerStatus(consumerName, false);
  console.log(JSON.stringify({ service: consumerName, signal, msg: 'shutdown requested' }));
  await consumer.disconnect().catch(() => undefined);
  await dlqProducer.disconnect().catch(() => undefined);
  db.close();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
main().catch((error) => { console.error(JSON.stringify({ service: consumerName, error, msg: 'worker failed' })); db.updateConsumerStatus(consumerName, false, undefined, true); db.close(); process.exit(1); });
