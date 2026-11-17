import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { AlertEvent } from './streaming.js';
import type { LiveEvent } from './events.js';

export type AlertStatus = 'firing' | 'resolved';

export interface IncomingAlert {
  status: AlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  fingerprint: string;
}

export interface AlertRecord extends IncomingAlert {
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
}

export interface NotificationSettings {
  enabled: boolean;
  notifyFiring: boolean;
  notifyResolved: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  fromEmail: string;
  recipients: string[];
  severityFilter: string[];
  firingSubject?: string;
  firingBody?: string;
  resolvedSubject?: string;
  resolvedBody?: string;
  content?: string;
}

export interface EmailDelivery {
  id: number;
  fingerprint?: string;
  event: 'firing' | 'resolved' | 'test';
  status: 'sent' | 'failed';
  recipients: string[];
  subject: string;
  error?: string;
  createdAt: string;
}

export interface StreamEventRecord {
  event: AlertEvent;
  processedAt?: string;
  consumer?: string;
}

export type RecoveryActionType = 'RESTART_CONTAINER' | 'START_CONTAINER' | 'CHECK_CONTAINER_STATUS' | 'HTTP_HEALTH_CHECK';
export type RecoveryMode = 'MANUAL' | 'AUTOMATIC';
export interface RecoveryRunbook { id:number; name:string; description:string; service:string; actionType:RecoveryActionType; parameters:Record<string,string>; timeoutSeconds:number; verificationEndpoint:string; maxAttempts:number; cooldownSeconds:number; mode:RecoveryMode; enabled:boolean; createdAt:string; updatedAt:string; }


function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(value: string, keyMaterial: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptSecret(value: string, keyMaterial: string): string {
  const [ivText, tagText, encryptedText] = value.split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Invalid encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class AlertDatabase {
  private readonly db: Database.Database;
  private readonly encryptionKey: string;

  constructor(path: string, encryptionKey: string) {
    this.encryptionKey = encryptionKey;
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        fingerprint TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        annotations_json TEXT NOT NULL,
        starts_at TEXT,
        ends_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        notify_firing INTEGER NOT NULL DEFAULT 1,
        notify_resolved INTEGER NOT NULL DEFAULT 1,
        smtp_host TEXT NOT NULL DEFAULT '',
        smtp_port INTEGER NOT NULL DEFAULT 587,
        smtp_secure INTEGER NOT NULL DEFAULT  true,
        smtp_username TEXT NOT NULL DEFAULT '',
        smtp_password_encrypted TEXT NOT NULL DEFAULT '',
        from_email TEXT NOT NULL DEFAULT '',
        recipients_json TEXT NOT NULL DEFAULT '[]',
        severity_filter_json TEXT NOT NULL DEFAULT '[]',
        firing_subject TEXT NOT NULL DEFAULT '',
        firing_body TEXT NOT NULL DEFAULT '',
        resolved_subject TEXT NOT NULL DEFAULT '',
        resolved_body TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS email_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        recipients_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        consumer TEXT NOT NULL,
        event_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (consumer, event_id)
      );
      CREATE TABLE IF NOT EXISTS stream_events (
        event_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        event_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        processed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS stream_counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT
      );
      CREATE TABLE IF NOT EXISTS consumer_status (
        consumer TEXT PRIMARY KEY,
        connected INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT,
        failures INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        locked_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS recovery_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        service TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        approved_at TEXT,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS recovery_runbooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', service TEXT NOT NULL,
        action_type TEXT NOT NULL, parameters_json TEXT NOT NULL DEFAULT '{}', timeout_seconds INTEGER NOT NULL DEFAULT 30,
        verification_endpoint TEXT NOT NULL DEFAULT '/health', max_attempts INTEGER NOT NULL DEFAULT 1, cooldown_seconds INTEGER NOT NULL DEFAULT 300,
        mode TEXT NOT NULL DEFAULT 'MANUAL', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, runbook_id INTEGER NOT NULL, service TEXT NOT NULL, action_type TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS dashboard_events (
        event_id TEXT PRIMARY KEY,
        incident_id TEXT,
        service_id TEXT,
        event_type TEXT NOT NULL,
        severity TEXT,
        status TEXT,
        occurred_at TEXT NOT NULL,
        related_record_type TEXT,
        related_record_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_time ON dashboard_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_incident ON dashboard_events(incident_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_service ON dashboard_events(service_id, occurred_at DESC);
      INSERT OR IGNORE INTO notification_settings (id) VALUES (1);
    `);
    const columns = this.db.prepare('PRAGMA table_info(notification_settings)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    for (const [name, definition] of [['firing_subject', "TEXT NOT NULL DEFAULT ''"], ['firing_body', "TEXT NOT NULL DEFAULT ''"], ['resolved_subject', "TEXT NOT NULL DEFAULT ''"], ['resolved_body', "TEXT NOT NULL DEFAULT ''"]] as const) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE notification_settings ADD COLUMN ${name} ${definition}`);
    }
    if (!existing.has('content')) this.db.exec("ALTER TABLE notification_settings ADD COLUMN content TEXT NOT NULL DEFAULT ''");
  }

  close(): void {
    this.db.close();
  }

  recordPublishedEvent(event: AlertEvent): void {
    this.db.prepare('INSERT OR IGNORE INTO stream_events (event_id, fingerprint, status, event_json, published_at) VALUES (?, ?, ?, ?, ?)').run(event.eventId, event.fingerprint, event.status, JSON.stringify(event), event.receivedAt);
    this.incrementCounter('published', event.receivedAt);
  }

  claimEvent(event: AlertEvent, consumer: string): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO processed_events (consumer, event_id, fingerprint, processed_at) VALUES (?, ?, ?, ?)').run(consumer, event.eventId, event.fingerprint, now());
    if (result.changes > 0) {
      this.db.prepare('UPDATE stream_events SET processed_at = COALESCE(processed_at, ?) WHERE event_id = ?').run(now(), event.eventId);
      this.incrementCounter('processed', now());
      return true;
    }
    return false;
  }

  recordStreamFailure(event: AlertEvent): void { this.incrementCounter('failures', event.receivedAt); }

  enqueueJob(kind: string, payload: unknown, availableAt = now()): number {
    const result = this.db.prepare('INSERT INTO jobs (kind, payload_json, available_at, created_at) VALUES (?, ?, ?, ?)').run(kind, JSON.stringify(payload), availableAt, now());
    return Number(result.lastInsertRowid);
  }

  claimJob(): { id: number; kind: string; payload: unknown; attempts: number } | undefined {
    const timestamp = now();
    const row = this.db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND available_at <= ? OR status = 'processing' AND locked_until < ? ORDER BY id LIMIT 1`).get(timestamp, timestamp) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const attempts = Number(row.attempts) + 1;
    this.db.prepare("UPDATE jobs SET status='processing', attempts=?, locked_until=? WHERE id=?").run(attempts, new Date(Date.now() + 30_000).toISOString(), row.id);
    return { id: Number(row.id), kind: String(row.kind), payload: parseJson(String(row.payload_json), {}), attempts };
  }

  completeJob(id: number): void { this.db.prepare("UPDATE jobs SET status='completed', completed_at=?, locked_until=NULL WHERE id=?").run(now(), id); }
  failJob(id: number, error: string, retryAt?: string): void { this.db.prepare("UPDATE jobs SET status=?, last_error=?, available_at=?, locked_until=NULL WHERE id=?").run(retryAt ? 'queued' : 'failed', error.slice(0, 1000), retryAt ?? now(), id); }

  jobStats(): { queued: number; processing: number; failed: number; completed: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all() as Array<{ status: string; count: number }>;
    const values = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return { queued: values.queued ?? 0, processing: values.processing ?? 0, failed: values.failed ?? 0, completed: values.completed ?? 0 };
  }

  requestRecovery(fingerprint: string, service: string): number {
    if (service !== 'test-service') throw new Error('Recovery is allowlisted only for test-service');
    const result = this.db.prepare("INSERT INTO recovery_actions (fingerprint, service, status, requested_at, result) VALUES (?, ?, 'pending_approval', ?, ?)").run(fingerprint, service, now(), 'Manual recovery required; Docker control is intentionally not mounted.');
    return Number(result.lastInsertRowid);
  }

  approveRecovery(id: number): boolean {
    const result = this.db.prepare("UPDATE recovery_actions SET status='approved_manual', approved_at=?, result=? WHERE id=? AND status='pending_approval'").run(now(), 'Approved for manual operator execution; no automatic container control is enabled.', id);
    return result.changes > 0;
  }

  recoveryHistory(): Array<Record<string, unknown>> { return this.db.prepare('SELECT * FROM recovery_actions ORDER BY id DESC LIMIT 100').all() as Array<Record<string, unknown>>; }

  listRunbooks(): RecoveryRunbook[] { return (this.db.prepare('SELECT * FROM recovery_runbooks ORDER BY updated_at DESC').all() as Array<Record<string,unknown>>).map((row)=>this.mapRunbook(row)); }
  getRunbook(id:number): RecoveryRunbook|undefined { const row=this.db.prepare('SELECT * FROM recovery_runbooks WHERE id=?').get(id) as Record<string,unknown>|undefined; return row?this.mapRunbook(row):undefined; }
  saveRunbook(runbook:Omit<RecoveryRunbook,'id'|'createdAt'|'updatedAt'>,id?:number):RecoveryRunbook { const t=now(); if(id){this.db.prepare('UPDATE recovery_runbooks SET name=?,description=?,service=?,action_type=?,parameters_json=?,timeout_seconds=?,verification_endpoint=?,max_attempts=?,cooldown_seconds=?,mode=?,enabled=?,updated_at=? WHERE id=?').run(runbook.name,runbook.description,runbook.service,runbook.actionType,JSON.stringify(runbook.parameters),runbook.timeoutSeconds,runbook.verificationEndpoint,runbook.maxAttempts,runbook.cooldownSeconds,runbook.mode,runbook.enabled?1:0,t,id);return this.getRunbook(id) as RecoveryRunbook;}const result=this.db.prepare('INSERT INTO recovery_runbooks (name,description,service,action_type,parameters_json,timeout_seconds,verification_endpoint,max_attempts,cooldown_seconds,mode,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(runbook.name,runbook.description,runbook.service,runbook.actionType,JSON.stringify(runbook.parameters),runbook.timeoutSeconds,runbook.verificationEndpoint,runbook.maxAttempts,runbook.cooldownSeconds,runbook.mode,runbook.enabled?1:0,t,t);return this.getRunbook(Number(result.lastInsertRowid)) as RecoveryRunbook; }
  createRecoveryExecution(runbook:RecoveryRunbook,mode:RecoveryMode,reason:string):number { const result=this.db.prepare('INSERT INTO recovery_executions (runbook_id,service,action_type,mode,status,reason,started_at) VALUES (?,?,?,?,?,?,?)').run(runbook.id,runbook.service,runbook.actionType,mode,'RUNNING',reason,now()); return Number(result.lastInsertRowid); }
  activeRecoveryForService(service:string):boolean { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM recovery_executions WHERE service=? AND status IN ('RUNNING','PENDING')").get(service) as {count:number}).count)>0; }
  finishRecoveryExecution(id:number,status:'SUCCESS'|'FAILED'|'TIMED_OUT',output:string):void { this.db.prepare('UPDATE recovery_executions SET status=?,output=?,completed_at=? WHERE id=?').run(status,output.slice(0,10000),now(),id); }
  recoveryExecutions():Array<Record<string,unknown>> { return this.db.prepare('SELECT * FROM recovery_executions ORDER BY id DESC LIMIT 100').all() as Array<Record<string,unknown>>; }

  recordDashboardEvent(event: LiveEvent): void {
    const data = event.data;
    const eventId = typeof data.eventId === 'string' ? data.eventId : `${event.type}:${String(data.executionId ?? data.deliveryId ?? data.jobId ?? data.fingerprint ?? 'state')}:${String(data.status ?? data.event ?? '')}`;
    const incidentId = typeof data.fingerprint === 'string' ? data.fingerprint : null;
    const service = typeof data.service === 'string' ? data.service : null;
    const severity = typeof data.severity === 'string' ? data.severity : null;
    const status = typeof data.status === 'string' ? data.status : null;
    const relatedId = data.executionId ?? data.deliveryId ?? data.jobId;
    this.db.prepare(`INSERT OR IGNORE INTO dashboard_events (event_id, incident_id, service_id, event_type, severity, status, occurred_at, related_record_type, related_record_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(eventId, incidentId, service, event.type, severity, status, event.timestamp, relatedId !== undefined ? event.type : null, relatedId !== undefined ? String(relatedId) : null, JSON.stringify(data));
  }

  dashboardEvents(filters: { service?: string; severity?: string; type?: string; since?: string; limit?: number; offset?: number } = {}): Array<Record<string, unknown>> {
    const conditions: string[] = []; const params: Record<string, unknown> = {};
    if (filters.service) { conditions.push('service_id = @service'); params.service = filters.service; }
    if (filters.severity) { conditions.push('severity = @severity'); params.severity = filters.severity; }
    if (filters.type) { conditions.push('event_type = @type'); params.type = filters.type; }
    if (filters.since) { conditions.push('occurred_at >= @since'); params.since = filters.since; }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500); const offset = Math.max(filters.offset ?? 0, 0);
    return this.db.prepare(`SELECT * FROM dashboard_events ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params) as Array<Record<string, unknown>>;
  }


  streamStats(): { published: number; processed: number; failures: number; recentEvents: AlertEvent[] } {
    const counters = this.db.prepare('SELECT name, value FROM stream_counters').all() as Array<{ name: string; value: number }>;
    const values = Object.fromEntries(counters.map((row) => [row.name, Number(row.value)]));
    const rows = this.db.prepare('SELECT event_json FROM stream_events ORDER BY published_at DESC LIMIT 50').all() as Array<{ event_json: string }>;
    return { published: values.published ?? 0, processed: values.processed ?? 0, failures: values.failures ?? 0, recentEvents: rows.flatMap((row) => { try { return [JSON.parse(row.event_json) as AlertEvent]; } catch { return []; } }) };
  }

  updateConsumerStatus(consumer: string, connected: boolean, eventAt?: string, failure = false): void {
    this.db.prepare(`INSERT INTO consumer_status (consumer, connected, last_event_at, failures, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(consumer) DO UPDATE SET connected=excluded.connected, last_event_at=COALESCE(excluded.last_event_at, consumer_status.last_event_at), failures=consumer_status.failures+excluded.failures, updated_at=excluded.updated_at`).run(consumer, connected ? 1 : 0, eventAt ?? null, failure ? 1 : 0, now());
  }

  consumerStatuses(): Record<string, { connected: boolean; lastEventAt?: string; failures: number }> {
    const rows = this.db.prepare('SELECT consumer, connected, last_event_at, failures FROM consumer_status').all() as Array<{ consumer: string; connected: number; last_event_at?: string; failures: number }>;
    return Object.fromEntries(rows.map((row) => [row.consumer, { connected: Boolean(row.connected), lastEventAt: row.last_event_at, failures: Number(row.failures) }]));
  }

  incidentFromEvent(event: AlertEvent): { record: AlertRecord; transitioned: boolean } {
    return this.upsertAlert({ status: event.status === 'FIRING' ? 'firing' : 'resolved', fingerprint: event.fingerprint, labels: { alertname: event.alertName, service: event.service, severity: event.severity }, annotations: { description: event.description }, startsAt: event.startsAt, endsAt: event.endsAt });
  }

  check(): boolean {
    return this.db.prepare('SELECT 1').get() !== undefined;
  }

  upsertAlert(alert: IncomingAlert): { record: AlertRecord; transitioned: boolean } {
    const existing = this.getAlert(alert.fingerprint);
    const receivedAt = now();
    const transitioned = !existing || existing.status !== alert.status;
    const resolvedAt = alert.status === 'resolved' ? (alert.endsAt ?? receivedAt) : undefined;

    this.db.prepare(`
      INSERT INTO alerts (fingerprint, status, labels_json, annotations_json, starts_at, ends_at, first_seen_at, last_seen_at, resolved_at)
      VALUES (@fingerprint, @status, @labels, @annotations, @startsAt, @endsAt, @firstSeenAt, @lastSeenAt, @resolvedAt)
      ON CONFLICT(fingerprint) DO UPDATE SET
        status=excluded.status,
        labels_json=excluded.labels_json,
        annotations_json=excluded.annotations_json,
        starts_at=COALESCE(alerts.starts_at, excluded.starts_at),
        ends_at=excluded.ends_at,
        last_seen_at=excluded.last_seen_at,
        resolved_at=excluded.resolved_at
    `).run({
      fingerprint: alert.fingerprint,
      status: alert.status,
      labels: JSON.stringify(alert.labels),
      annotations: JSON.stringify(alert.annotations),
      startsAt: alert.startsAt ?? null,
      endsAt: alert.endsAt ?? null,
      firstSeenAt: existing?.firstSeenAt ?? receivedAt,
      lastSeenAt: receivedAt,
      resolvedAt: resolvedAt ?? existing?.resolvedAt ?? null
    });

    this.db.prepare('INSERT INTO alert_events (fingerprint, status, payload_json, received_at) VALUES (?, ?, ?, ?)').run(
      alert.fingerprint,
      alert.status,
      JSON.stringify(alert),
      receivedAt
    );

    return { record: this.getAlert(alert.fingerprint) as AlertRecord, transitioned };
  }

  getAlert(fingerprint: string): AlertRecord | undefined {
    const row = this.db.prepare('SELECT * FROM alerts WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown> | undefined;
    return row ? this.mapAlert(row) : undefined;
  }

  listAlerts(filters: { status?: AlertStatus; service?: string; severity?: string; search?: string }): AlertRecord[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (filters.status) { conditions.push('status = @status'); params.status = filters.status; }
    if (filters.service) { conditions.push("json_extract(labels_json, '$.service') = @service"); params.service = filters.service; }
    if (filters.severity) { conditions.push("json_extract(labels_json, '$.severity') = @severity"); params.severity = filters.severity; }
    if (filters.search) {
      conditions.push("(json_extract(labels_json, '$.alertname') LIKE @search OR json_extract(labels_json, '$.service') LIKE @search OR annotations_json LIKE @search)");
      params.search = `%${filters.search}%`;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM alerts ${where} ORDER BY CASE status WHEN 'firing' THEN 0 ELSE 1 END, last_seen_at DESC`).all(params) as Record<string, unknown>[];
    return rows.map((row) => this.mapAlert(row));
  }

  getHistory(fingerprint: string): Array<{ status: AlertStatus; payload: IncomingAlert; receivedAt: string }> {
    const rows = this.db.prepare('SELECT status, payload_json, received_at FROM alert_events WHERE fingerprint = ? ORDER BY id DESC').all(fingerprint) as Array<Record<string, string>>;
    return rows.map((row) => ({ status: row.status as AlertStatus, payload: parseJson(row.payload_json, {} as IncomingAlert), receivedAt: row.received_at }));
  }

  getSettings(): NotificationSettings {
    const row = this.db.prepare('SELECT * FROM notification_settings WHERE id = 1').get() as Record<string, unknown>;
    return {
      enabled: Boolean(row.enabled),
      notifyFiring: Boolean(row.notify_firing),
      notifyResolved: Boolean(row.notify_resolved),
      smtpHost: String(row.smtp_host),
      smtpPort: Number(row.smtp_port),
      smtpSecure: Boolean(row.smtp_secure),
      smtpUsername: String(row.smtp_username),
      smtpPassword: row.smtp_password_encrypted ? decryptSecret(String(row.smtp_password_encrypted), this.encryptionKey) : '',
      fromEmail: String(row.from_email),
      recipients: parseJson(String(row.recipients_json), []),
      severityFilter: parseJson(String(row.severity_filter_json), []),
      firingSubject: String(row.firing_subject ?? ''),
      firingBody: String(row.firing_body ?? ''),
      resolvedSubject: String(row.resolved_subject ?? ''),
      resolvedBody: String(row.resolved_body ?? ''),
      content: String(row.content ?? '')
    };
  }

  saveSettings(settings: NotificationSettings): void {
    const encryptedPassword = settings.smtpPassword ? encryptSecret(settings.smtpPassword, this.encryptionKey) : '';
    this.db.prepare(`
      UPDATE notification_settings SET enabled=@enabled, notify_firing=@notifyFiring, notify_resolved=@notifyResolved,
      smtp_host=@smtpHost, smtp_port=@smtpPort, smtp_secure=@smtpSecure, smtp_username=@smtpUsername,
      smtp_password_encrypted=@password, from_email=@fromEmail, recipients_json=@recipients, severity_filter_json=@severityFilter,
      firing_subject=@firingSubject, firing_body=@firingBody, resolved_subject=@resolvedSubject, resolved_body=@resolvedBody, content=@content
      WHERE id=1
    `).run({
      enabled: settings.enabled ? 1 : 0,
      notifyFiring: settings.notifyFiring ? 1 : 0,
      notifyResolved: settings.notifyResolved ? 1 : 0,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure ? 1 : 0,
      smtpUsername: settings.smtpUsername,
      password: encryptedPassword,
      fromEmail: settings.fromEmail,
      recipients: JSON.stringify(settings.recipients),
      severityFilter: JSON.stringify(settings.severityFilter),
      firingSubject: settings.firingSubject ?? '',
      firingBody: settings.firingBody ?? '',
      resolvedSubject: settings.resolvedSubject ?? '',
      resolvedBody: settings.resolvedBody ?? '',
      content: settings.content ?? ''
    });
  }

  recordEmail(delivery: Omit<EmailDelivery, 'id' | 'createdAt'>): EmailDelivery {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO email_deliveries (fingerprint, event, status, recipients_json, subject, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      delivery.fingerprint ?? null, delivery.event, delivery.status, JSON.stringify(delivery.recipients), delivery.subject, delivery.error ?? null, createdAt
    );
    return { ...delivery, id: Number(result.lastInsertRowid), createdAt };
  }

  listEmails(): EmailDelivery[] {
    const rows = this.db.prepare('SELECT * FROM email_deliveries ORDER BY id DESC LIMIT 100').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), fingerprint: row.fingerprint ? String(row.fingerprint) : undefined, event: row.event as EmailDelivery['event'], status: row.status as EmailDelivery['status'], recipients: parseJson(String(row.recipients_json), []), subject: String(row.subject), error: row.error ? String(row.error) : undefined, createdAt: String(row.created_at) }));
  }

  private mapAlert(row: Record<string, unknown>): AlertRecord {
    return {
      fingerprint: String(row.fingerprint),
      status: row.status as AlertStatus,
      labels: parseJson(String(row.labels_json), {}),
      annotations: parseJson(String(row.annotations_json), {}),
      startsAt: row.starts_at ? String(row.starts_at) : undefined,
      endsAt: row.ends_at ? String(row.ends_at) : undefined,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined
    };
  }
  private mapRunbook(row:Record<string,unknown>):RecoveryRunbook { return {id:Number(row.id),name:String(row.name),description:String(row.description),service:String(row.service),actionType:row.action_type as RecoveryActionType,parameters:parseJson(String(row.parameters_json),{}),timeoutSeconds:Number(row.timeout_seconds),verificationEndpoint:String(row.verification_endpoint),maxAttempts:Number(row.max_attempts),cooldownSeconds:Number(row.cooldown_seconds),mode:row.mode as RecoveryMode,enabled:Boolean(row.enabled),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}; }


  private incrementCounter(name: string, eventAt: string): void {
    this.db.prepare(`INSERT INTO stream_counters (name, value, last_event_at) VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET value=value+1, last_event_at=excluded.last_event_at`).run(name, eventAt);
  }
}
