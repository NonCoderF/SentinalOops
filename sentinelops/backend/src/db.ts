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
export type DockerControllerAction = 'START_CONTAINER' | 'RESTART_CONTAINER' | 'CHECK_CONTAINER_STATUS' | 'STOP_CONTAINER';
export type RecoveryMode = 'MANUAL' | 'AUTOMATIC';
export type RecoveryControllerMode = 'MANUAL' | 'KUBERNETES';
export interface RecoveryRunbook { id:number; name:string; description:string; service:string; actionType:RecoveryActionType; parameters:Record<string,string>; timeoutSeconds:number; verificationEndpoint:string; maxAttempts:number; cooldownSeconds:number; mode:RecoveryMode; enabled:boolean; createdAt:string; updatedAt:string; }
export type EndpointNetworkScope = 'external' | 'host' | 'docker';
export interface MonitoredEndpoint { id:number; applicationName:string; endpointUrl:string; probeUrl:string; networkScope:EndpointNetworkScope; method:'GET'|'HEAD'; expectedStatus:number; intervalSeconds:number; environment:'production'|'staging'|'development'; authType:'none'|'bearer'|'basic'; enabled:boolean; createdAt:string; updatedAt:string; }
export type ServicePriority = 'HIGH' | 'NORMAL' | 'LOW';
export type ServiceRecoveryAction = 'START_CONTAINER' | 'RESTART_CONTAINER';
export interface ServiceEndpoint { id:string; serviceId:string; friendlyName:string; url:string; expectedStatus:number; enabled:boolean; }
export interface RegisteredService { id:string; name:string; description:string; dockerEngine:string; containerId?:string; containerName?:string; monitoringEnabled:boolean; intervalSeconds:number; failureThreshold:number; timeoutSeconds:number; autoRecoveryEnabled:boolean; recoveryAction:ServiceRecoveryAction; priority:ServicePriority; cooldownSeconds:number; verificationTimeoutSeconds:number; maxAttempts:number; endpoints:ServiceEndpoint[]; createdAt:string; updatedAt:string; }
export type RecoveryQueueStatus = 'QUEUED' | 'RECOVERING' | 'VERIFYING' | 'RECOVERED' | 'FAILED' | 'SKIPPED';
export interface RecoveryQueueItem { id:number; serviceId:string; serviceName:string; containerKey?:string; incidentId:string; agentId?:string; priority:ServicePriority; action:ServiceRecoveryAction; status:RecoveryQueueStatus; attempts:number; availableAt:string; lockedUntil?:string; error?:string; createdAt:string; startedAt?:string; completedAt?:string; }


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
      CREATE TABLE IF NOT EXISTS installation_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_controller_modes (
        application TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        runtime TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application TEXT NOT NULL,
        mode TEXT NOT NULL,
        runtime TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS kubernetes_agent_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_seconds INTEGER NOT NULL DEFAULT 5,
        timeout_seconds INTEGER NOT NULL DEFAULT 2,
        failure_threshold INTEGER NOT NULL DEFAULT 3,
        cooldown_seconds INTEGER NOT NULL DEFAULT 60,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kubernetes_agents (
        agent_id TEXT PRIMARY KEY,
        pod_name TEXT,
        namespace TEXT,
        node_name TEXT,
        status TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS kubernetes_agent_incidents (
        incident_id TEXT PRIMARY KEY,
        monitor_id INTEGER NOT NULL,
        service TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        detected_at TEXT NOT NULL,
        recovered_at TEXT,
        last_error TEXT,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS kubernetes_agent_attempts (
        attempt_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        result_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS kubernetes_agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        incident_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS kubernetes_agent_leases (
        service TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monitored_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL DEFAULT 'GET',
        expected_status INTEGER NOT NULL DEFAULT 200,
        interval_seconds INTEGER NOT NULL DEFAULT 30,
        environment TEXT NOT NULL DEFAULT 'production',
        auth_type TEXT NOT NULL DEFAULT 'none',
        auth_secret_encrypted TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registered_services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        docker_engine TEXT NOT NULL DEFAULT 'default',
        container_id TEXT,
        container_name TEXT,
        monitoring_enabled INTEGER NOT NULL DEFAULT 1,
        interval_seconds INTEGER NOT NULL DEFAULT 5,
        failure_threshold INTEGER NOT NULL DEFAULT 3,
        timeout_seconds INTEGER NOT NULL DEFAULT 2,
        auto_recovery_enabled INTEGER NOT NULL DEFAULT 0,
        recovery_action TEXT NOT NULL DEFAULT 'RESTART_CONTAINER',
        priority TEXT NOT NULL DEFAULT 'NORMAL',
        cooldown_seconds INTEGER NOT NULL DEFAULT 60,
        verification_timeout_seconds INTEGER NOT NULL DEFAULT 60,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_endpoints (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES registered_services(id) ON DELETE CASCADE,
        friendly_name TEXT NOT NULL,
        url TEXT NOT NULL,
        expected_status INTEGER NOT NULL DEFAULT 200,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(service_id, url)
      );
      CREATE TABLE IF NOT EXISTS recovery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL REFERENCES registered_services(id),
        incident_id TEXT NOT NULL,
        container_key TEXT,
        agent_id TEXT,
        priority TEXT NOT NULL DEFAULT 'NORMAL',
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        locked_until TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_queue_active_incident ON recovery_queue(service_id, incident_id) WHERE status IN ('QUEUED','RECOVERING','VERIFYING');
      CREATE INDEX IF NOT EXISTS idx_recovery_queue_ready ON recovery_queue(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_time ON dashboard_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_incident ON dashboard_events(incident_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_service ON dashboard_events(service_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_monitored_endpoints_enabled ON monitored_endpoints(enabled, updated_at DESC);
      INSERT OR IGNORE INTO notification_settings (id) VALUES (1);
    `);
    for (const statement of [
      "ALTER TABLE monitored_endpoints ADD COLUMN probe_url TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE monitored_endpoints ADD COLUMN network_scope TEXT NOT NULL DEFAULT 'external'"
    ]) {
      try { this.db.exec(statement); } catch { /* existing installations already have the column */ }
    }
    const columns = this.db.prepare('PRAGMA table_info(notification_settings)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    for (const [name, definition] of [['firing_subject', "TEXT NOT NULL DEFAULT ''"], ['firing_body', "TEXT NOT NULL DEFAULT ''"], ['resolved_subject', "TEXT NOT NULL DEFAULT ''"], ['resolved_body', "TEXT NOT NULL DEFAULT ''"]] as const) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE notification_settings ADD COLUMN ${name} ${definition}`);
    }
    if (!existing.has('content')) this.db.exec("ALTER TABLE notification_settings ADD COLUMN content TEXT NOT NULL DEFAULT ''");
    this.migrateLegacyTestService();
  }

  close(): void {
    this.db.close();
  }

  getInstallationState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM installation_state WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setInstallationState(key: string, value: string): void {
    this.db.prepare('INSERT INTO installation_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, now());
  }

  listMonitoredEndpoints(): MonitoredEndpoint[] {
    const rows = this.db.prepare('SELECT * FROM monitored_endpoints ORDER BY id ASC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), applicationName: String(row.application_name), endpointUrl: String(row.endpoint_url), probeUrl: String(row.probe_url || row.endpoint_url), networkScope: (['external', 'host', 'docker'].includes(String(row.network_scope)) ? String(row.network_scope) : 'external') as MonitoredEndpoint['networkScope'], method: row.method === 'HEAD' ? 'HEAD' : 'GET', expectedStatus: Number(row.expected_status), intervalSeconds: Number(row.interval_seconds), environment: (['production', 'staging', 'development'].includes(String(row.environment)) ? String(row.environment) : 'production') as MonitoredEndpoint['environment'], authType: (['bearer', 'basic'].includes(String(row.auth_type)) ? String(row.auth_type) : 'none') as MonitoredEndpoint['authType'], enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  }

  listRegisteredServices(): RegisteredService[] {
    const services = this.db.prepare('SELECT * FROM registered_services ORDER BY name COLLATE NOCASE').all() as Array<Record<string, unknown>>;
    const endpoints = this.db.prepare('SELECT * FROM service_endpoints ORDER BY friendly_name COLLATE NOCASE').all() as Array<Record<string, unknown>>;
    return services.map((row) => this.mapService(row, endpoints.filter((endpoint) => String(endpoint.service_id) === String(row.id))));
  }

  getRegisteredService(id: string): RegisteredService | undefined {
    return this.listRegisteredServices().find((service) => service.id === id);
  }

  saveRegisteredService(input: Omit<RegisteredService, 'createdAt'|'updatedAt'>, id?: string): RegisteredService {
    const timestamp = now();
    const serviceId = id ?? input.id ?? crypto.randomUUID();
    const write = this.db.transaction(() => {
      if (id) this.db.prepare(`UPDATE registered_services SET name=?, description=?, docker_engine=?, container_id=?, container_name=?, monitoring_enabled=?, interval_seconds=?, failure_threshold=?, timeout_seconds=?, auto_recovery_enabled=?, recovery_action=?, priority=?, cooldown_seconds=?, verification_timeout_seconds=?, max_attempts=?, updated_at=? WHERE id=?`).run(input.name, input.description, input.dockerEngine, input.containerId ?? null, input.containerName ?? null, input.monitoringEnabled ? 1 : 0, input.intervalSeconds, input.failureThreshold, input.timeoutSeconds, input.autoRecoveryEnabled ? 1 : 0, input.recoveryAction, input.priority, input.cooldownSeconds, input.verificationTimeoutSeconds, input.maxAttempts, timestamp, serviceId);
      else this.db.prepare(`INSERT INTO registered_services (id,name,description,docker_engine,container_id,container_name,monitoring_enabled,interval_seconds,failure_threshold,timeout_seconds,auto_recovery_enabled,recovery_action,priority,cooldown_seconds,verification_timeout_seconds,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, input.name, input.description, input.dockerEngine, input.containerId ?? null, input.containerName ?? null, input.monitoringEnabled ? 1 : 0, input.intervalSeconds, input.failureThreshold, input.timeoutSeconds, input.autoRecoveryEnabled ? 1 : 0, input.recoveryAction, input.priority, input.cooldownSeconds, input.verificationTimeoutSeconds, input.maxAttempts, timestamp, timestamp);
      this.db.prepare('DELETE FROM service_endpoints WHERE service_id=?').run(serviceId);
      const insert = this.db.prepare('INSERT INTO service_endpoints (id,service_id,friendly_name,url,expected_status,enabled) VALUES (?,?,?,?,?,?)');
      for (const endpoint of input.endpoints) insert.run(endpoint.id || crypto.randomUUID(), serviceId, endpoint.friendlyName, endpoint.url, endpoint.expectedStatus, endpoint.enabled ? 1 : 0);
    });
    write();
    return this.getRegisteredService(serviceId) as RegisteredService;
  }

  deleteRegisteredService(id: string): boolean {
    return this.db.transaction(() => {
      // Unregistering a service must not leave recovery-queue rows pointing at
      // a deleted configuration. Incidents and dashboard events are stored
      // independently and remain available as historical records.
      this.db.prepare('DELETE FROM recovery_queue WHERE service_id=?').run(id);
      this.db.prepare('DELETE FROM service_endpoints WHERE service_id=?').run(id);
      return this.db.prepare('DELETE FROM registered_services WHERE id=?').run(id).changes > 0;
    })();
  }

  enqueueRecovery(service: RegisteredService, incidentId: string, agentId?: string): RecoveryQueueItem {
    const containerKey = service.containerId ? `${service.dockerEngine}:${service.containerId}` : undefined;
    const existing = this.db.prepare("SELECT id FROM recovery_queue WHERE service_id=? AND incident_id=? AND status IN ('QUEUED','RECOVERING','VERIFYING')").get(service.id, incidentId) as { id?: number } | undefined;
    if (existing?.id) return this.getRecoveryQueueItem(Number(existing.id)) as RecoveryQueueItem;
    const duplicate = containerKey ? this.db.prepare("SELECT id FROM recovery_queue WHERE container_key=? AND status IN ('QUEUED','RECOVERING','VERIFYING')").get(containerKey) as { id?: number } | undefined : undefined;
    if (duplicate?.id) return this.getRecoveryQueueItem(Number(duplicate.id)) as RecoveryQueueItem;
    const result = this.db.prepare('INSERT INTO recovery_queue (service_id,incident_id,container_key,agent_id,priority,action,status,available_at,created_at) VALUES (?,?,?,?,?,?,\'QUEUED\',?,?)').run(service.id, incidentId, containerKey ?? null, agentId ?? null, service.priority, service.recoveryAction, now(), now());
    return this.getRecoveryQueueItem(Number(result.lastInsertRowid)) as RecoveryQueueItem;
  }

  getRecoveryQueueItem(id: number): RecoveryQueueItem | undefined {
    const row = this.db.prepare('SELECT q.*, s.name AS service_name FROM recovery_queue q JOIN registered_services s ON s.id=q.service_id WHERE q.id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapQueueItem(row) : undefined;
  }

  listRecoveryQueue(limit = 100): RecoveryQueueItem[] {
    const rows = this.db.prepare(`SELECT q.*, s.name AS service_name FROM recovery_queue q JOIN registered_services s ON s.id=q.service_id ORDER BY CASE q.status WHEN 'RECOVERING' THEN 0 WHEN 'VERIFYING' THEN 1 WHEN 'QUEUED' THEN 2 ELSE 3 END, CASE q.priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, q.created_at ASC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapQueueItem(row));
  }

  claimNextRecovery(): RecoveryQueueItem | undefined {
    const timestamp = now();
    this.db.prepare("UPDATE recovery_queue SET status='FAILED', error='Recovery worker lease expired; manual review required', completed_at=? WHERE status IN ('RECOVERING','VERIFYING') AND locked_until < ?").run(timestamp, timestamp);
    const active = this.db.prepare("SELECT id FROM recovery_queue WHERE status IN ('RECOVERING','VERIFYING')").get();
    if (active) return undefined;
    const row = this.db.prepare(`SELECT q.*, s.name AS service_name FROM recovery_queue q JOIN registered_services s ON s.id=q.service_id WHERE q.status='QUEUED' AND q.available_at<=? ORDER BY CASE q.priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, q.created_at ASC LIMIT 1`).get(timestamp) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const lockedUntil = new Date(Date.now() + 120000).toISOString();
    this.db.prepare("UPDATE recovery_queue SET status='RECOVERING', attempts=attempts+1, locked_until=?, started_at=COALESCE(started_at,?) WHERE id=? AND status='QUEUED'").run(lockedUntil, now(), row.id);
    return this.getRecoveryQueueItem(Number(row.id));
  }

  updateRecoveryQueue(id: number, status: RecoveryQueueStatus, error?: string): void {
    this.db.prepare('UPDATE recovery_queue SET status=?, error=?, locked_until=NULL, completed_at=? WHERE id=?').run(status, error?.slice(0, 1000) ?? null, ['RECOVERED','FAILED','SKIPPED'].includes(status) ? now() : null, id);
  }

  private migrateLegacyTestService(): void {
    if (this.db.prepare('SELECT 1 FROM registered_services WHERE name=?').get('test-service')) return;
    const legacy = this.listMonitoredEndpoints();
    if (!legacy.length) return;
    const endpoints = legacy.map((endpoint) => ({ id: crypto.randomUUID(), serviceId: '', friendlyName: endpoint.applicationName, url: endpoint.probeUrl || endpoint.endpointUrl, expectedStatus: endpoint.expectedStatus, enabled: endpoint.enabled }));
    this.saveRegisteredService({ id: crypto.randomUUID(), name: 'test-service', description: 'Migrated legacy monitored service', dockerEngine: 'default', containerName: process.env.TEST_SERVICE_CONTAINER ?? 'sentinelops-test-service', monitoringEnabled: true, intervalSeconds: 5, failureThreshold: 3, timeoutSeconds: 2, autoRecoveryEnabled: false, recoveryAction: 'RESTART_CONTAINER', priority: 'NORMAL', cooldownSeconds: 60, verificationTimeoutSeconds: 60, maxAttempts: 1, endpoints });
  }

  saveMonitoredEndpoint(endpoint: Omit<MonitoredEndpoint, 'id' | 'createdAt' | 'updatedAt'> & { id?: number; authSecretEncrypted?: string }): MonitoredEndpoint {
    const timestamp = now();
    if (endpoint.id) this.db.prepare('UPDATE monitored_endpoints SET application_name=?, endpoint_url=?, probe_url=?, network_scope=?, method=?, expected_status=?, interval_seconds=?, environment=?, auth_type=?, auth_secret_encrypted=COALESCE(NULLIF(?, \'\'), auth_secret_encrypted), enabled=?, updated_at=? WHERE id=?').run(endpoint.applicationName, endpoint.endpointUrl, endpoint.probeUrl, endpoint.networkScope, endpoint.method, endpoint.expectedStatus, endpoint.intervalSeconds, endpoint.environment, endpoint.authType, endpoint.authSecretEncrypted ?? '', endpoint.enabled ? 1 : 0, timestamp, endpoint.id);
    else this.db.prepare('INSERT INTO monitored_endpoints (application_name, endpoint_url, probe_url, network_scope, method, expected_status, interval_seconds, environment, auth_type, auth_secret_encrypted, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(endpoint.applicationName, endpoint.endpointUrl, endpoint.probeUrl, endpoint.networkScope, endpoint.method, endpoint.expectedStatus, endpoint.intervalSeconds, endpoint.environment, endpoint.authType, endpoint.authSecretEncrypted ?? '', endpoint.enabled ? 1 : 0, timestamp, timestamp);
    const id = endpoint.id ?? Number((this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    return this.listMonitoredEndpoints().find((item) => item.id === id) as MonitoredEndpoint;
  }

  deleteMonitoredEndpoint(id: number): boolean { return this.db.prepare('DELETE FROM monitored_endpoints WHERE id = ?').run(id).changes > 0; }

  deleteMonitoredEndpointsForService(service: RegisteredService): number[] {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const serviceName = normalize(service.name);
    const urls = new Set(service.endpoints.map((endpoint) => endpoint.url));
    const rows = this.db.prepare('SELECT id, application_name, endpoint_url, probe_url FROM monitored_endpoints').all() as Array<{ id: number; application_name: string; endpoint_url: string; probe_url: string }>;
    const ids = rows.filter((row) => normalize(row.application_name) === serviceName && (urls.has(row.endpoint_url) || urls.has(row.probe_url))).map((row) => row.id);
    if (ids.length) this.db.prepare(`DELETE FROM monitored_endpoints WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return ids;
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(service)) throw new Error('Recovery requires a valid registered service name');
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
  getRecoveryControllerMode(application: string): { application: string; mode: RecoveryControllerMode; runtime: string; state: string; reason: string; updatedAt: string } {
    const row = this.db.prepare('SELECT * FROM recovery_controller_modes WHERE application=?').get(application) as Record<string, unknown> | undefined;
    if (!row) {
      this.setRecoveryControllerMode(application, 'KUBERNETES', 'kubernetes', 'KUBERNETES_ACTIVE', 'Kubernetes Recovery is the default active mode.');
      return { application, mode: 'KUBERNETES', runtime: 'kubernetes', state: 'KUBERNETES_ACTIVE', reason: 'Kubernetes Recovery is the default active mode.', updatedAt: now() };
    }
    return { application, mode: row.mode as RecoveryControllerMode, runtime: String(row.runtime), state: String(row.state), reason: String(row.reason), updatedAt: String(row.updated_at) };
  }
  setRecoveryControllerMode(application: string, mode: RecoveryControllerMode, runtime: string, state: string, reason = ''): void {
    this.db.prepare(`INSERT INTO recovery_controller_modes (application, mode, runtime, state, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(application) DO UPDATE SET mode=excluded.mode, runtime=excluded.runtime, state=excluded.state, reason=excluded.reason, updated_at=excluded.updated_at`).run(application, mode, runtime, state, reason, now());
  }
  createRecoveryOperation(application: string, mode: string, runtime: string, trigger: string, metadata: unknown = {}): number {
    const result = this.db.prepare('INSERT INTO recovery_operations (application, mode, runtime, trigger, status, started_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(application, mode, runtime, trigger, 'RUNNING', now(), JSON.stringify(metadata));
    return Number(result.lastInsertRowid);
  }
  finishRecoveryOperation(id: number, status: string, error?: string): void {
    const row = this.db.prepare('SELECT started_at FROM recovery_operations WHERE id=?').get(id) as { started_at?: string } | undefined;
    const duration = row?.started_at ? Math.max(0, Date.now() - new Date(row.started_at).getTime()) : null;
    this.db.prepare('UPDATE recovery_operations SET status=?, completed_at=?, duration_ms=?, error=? WHERE id=?').run(status, now(), duration, error ?? null, id);
  }
  recoveryOperations(application?: string): Array<Record<string, unknown>> {
    return (application ? this.db.prepare('SELECT * FROM recovery_operations WHERE application=? ORDER BY id DESC LIMIT 100').all(application) : this.db.prepare('SELECT * FROM recovery_operations ORDER BY id DESC LIMIT 100').all()) as Array<Record<string, unknown>>;
  }

  getKubernetesAgentPolicy(): Record<string, unknown> {
    let row = this.db.prepare('SELECT * FROM kubernetes_agent_policy WHERE id=1').get() as Record<string, unknown> | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO kubernetes_agent_policy (id, enabled, interval_seconds, timeout_seconds, failure_threshold, cooldown_seconds, max_attempts, updated_at) VALUES (1, 0, 5, 2, 3, 60, 3, ?)').run(now());
      row = this.db.prepare('SELECT * FROM kubernetes_agent_policy WHERE id=1').get() as Record<string, unknown>;
    }
    return { enabled: Boolean(row.enabled), intervalSeconds: Number(row.interval_seconds), timeoutSeconds: Number(row.timeout_seconds), failureThreshold: Number(row.failure_threshold), cooldownSeconds: Number(row.cooldown_seconds), maxAttempts: Number(row.max_attempts), updatedAt: String(row.updated_at) };
  }

  saveKubernetesAgentPolicy(input: { enabled?: boolean; intervalSeconds?: number; timeoutSeconds?: number; failureThreshold?: number; cooldownSeconds?: number; maxAttempts?: number }): Record<string, unknown> {
    const current = this.getKubernetesAgentPolicy();
    const value = {
      enabled: input.enabled ?? Boolean(current.enabled), intervalSeconds: input.intervalSeconds ?? Number(current.intervalSeconds),
      timeoutSeconds: input.timeoutSeconds ?? Number(current.timeoutSeconds), failureThreshold: input.failureThreshold ?? Number(current.failureThreshold),
      cooldownSeconds: input.cooldownSeconds ?? Number(current.cooldownSeconds), maxAttempts: input.maxAttempts ?? Number(current.maxAttempts)
    };
    this.db.prepare('UPDATE kubernetes_agent_policy SET enabled=?, interval_seconds=?, timeout_seconds=?, failure_threshold=?, cooldown_seconds=?, max_attempts=?, updated_at=? WHERE id=1').run(value.enabled ? 1 : 0, value.intervalSeconds, value.timeoutSeconds, value.failureThreshold, value.cooldownSeconds, value.maxAttempts, now());
    return this.getKubernetesAgentPolicy();
  }

  upsertKubernetesAgent(agent: { agentId: string; podName?: string; namespace?: string; nodeName?: string; status: string; metadata?: unknown }): void {
    this.db.prepare(`INSERT INTO kubernetes_agents (agent_id, pod_name, namespace, node_name, status, last_heartbeat, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET pod_name=excluded.pod_name, namespace=excluded.namespace, node_name=excluded.node_name, status=excluded.status, last_heartbeat=excluded.last_heartbeat, metadata_json=excluded.metadata_json`).run(agent.agentId, agent.podName ?? null, agent.namespace ?? null, agent.nodeName ?? null, agent.status, now(), JSON.stringify(agent.metadata ?? {}));
  }

  listKubernetesAgents(): Array<Record<string, unknown>> { return this.db.prepare('SELECT * FROM kubernetes_agents ORDER BY last_heartbeat DESC').all() as Array<Record<string, unknown>>; }
  recordKubernetesAgentEvent(agentId: string, eventType: string, payload: unknown, incidentId?: string): void { this.db.prepare('INSERT INTO kubernetes_agent_events (agent_id, incident_id, event_type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)').run(agentId, incidentId ?? null, eventType, now(), JSON.stringify(payload ?? {})); }
  listKubernetesAgentEvents(limit = 100): Array<Record<string, unknown>> { return this.db.prepare('SELECT * FROM kubernetes_agent_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>; }
  acquireKubernetesAgentLease(service: string, incidentId: string, ownerAgentId: string, ttlSeconds = 30): { acquired: boolean; service: string; incidentId: string; ownerAgentId: string; leaseToken?: string; expiresAt?: string } {
    const nowValue = now();
    const expiresAt = new Date(Date.now() + Math.min(Math.max(ttlSeconds, 10), 900) * 1000).toISOString();
    const token = crypto.randomUUID();
    this.db.prepare(`INSERT INTO kubernetes_agent_leases (service, incident_id, owner_agent_id, lease_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(service) DO UPDATE SET incident_id=excluded.incident_id, owner_agent_id=excluded.owner_agent_id, lease_token=excluded.lease_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at
      WHERE kubernetes_agent_leases.expires_at <= ? OR (kubernetes_agent_leases.owner_agent_id = ? AND kubernetes_agent_leases.incident_id = ?)`)
      .run(service, incidentId, ownerAgentId, token, expiresAt, nowValue, nowValue, ownerAgentId, incidentId);
    const row = this.db.prepare('SELECT * FROM kubernetes_agent_leases WHERE service=?').get(service) as Record<string, unknown> | undefined;
    const acquired = Boolean(row && row.owner_agent_id === ownerAgentId && row.incident_id === incidentId && row.lease_token === token);
    return { acquired, service, incidentId: String(row?.incident_id ?? incidentId), ownerAgentId: String(row?.owner_agent_id ?? ownerAgentId), leaseToken: acquired ? token : undefined, expiresAt: String(row?.expires_at ?? expiresAt) };
  }
  getKubernetesAgentLease(service: string): Record<string, unknown> | undefined { return this.db.prepare('SELECT * FROM kubernetes_agent_leases WHERE service=?').get(service) as Record<string, unknown> | undefined; }
  validateKubernetesAgentLease(service: string, incidentId: string, ownerAgentId: string, leaseToken: string): boolean {
    const row = this.getKubernetesAgentLease(service);
    return Boolean(row && row.incident_id === incidentId && row.owner_agent_id === ownerAgentId && row.lease_token === leaseToken && String(row.expires_at) > now());
  }
  releaseKubernetesAgentLease(service: string, incidentId: string, ownerAgentId: string, leaseToken: string): boolean {
    const result = this.db.prepare('DELETE FROM kubernetes_agent_leases WHERE service=? AND incident_id=? AND owner_agent_id=? AND lease_token=?').run(service, incidentId, ownerAgentId, leaseToken);
    return result.changes > 0;
  }
  listKubernetesAgentLeases(): Array<Record<string, unknown>> { return this.db.prepare('SELECT service, incident_id, owner_agent_id, expires_at, updated_at FROM kubernetes_agent_leases ORDER BY service').all() as Array<Record<string, unknown>>; }
  createKubernetesIncident(incidentId: string, monitorId: number|string, service: string, error: string, metadata: unknown = {}): boolean { const result = this.db.prepare('INSERT OR IGNORE INTO kubernetes_agent_incidents (incident_id, monitor_id, service, status, failure_count, detected_at, last_error, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(incidentId, monitorId, service, 'ACTIVE', 1, now(), error.slice(0, 1000), JSON.stringify(metadata)); return result.changes > 0; }
  getKubernetesIncident(incidentId: string): Record<string, unknown> | undefined { return this.db.prepare('SELECT * FROM kubernetes_agent_incidents WHERE incident_id=?').get(incidentId) as Record<string, unknown> | undefined; }
  updateKubernetesIncident(incidentId: string, update: { status?: string; failureCount?: number; error?: string; recoveryAttempts?: number; recoveredAt?: string | null }): void { const row = this.getKubernetesIncident(incidentId); if (!row) return; this.db.prepare('UPDATE kubernetes_agent_incidents SET status=?, failure_count=?, last_error=?, recovery_attempts=?, recovered_at=? WHERE incident_id=?').run(update.status ?? String(row.status), update.failureCount ?? Number(row.failure_count), update.error ?? row.last_error ?? null, update.recoveryAttempts ?? Number(row.recovery_attempts), update.recoveredAt === undefined ? row.recovered_at ?? null : update.recoveredAt, incidentId); }
  listKubernetesIncidents(limit = 100): Array<Record<string, unknown>> { return this.db.prepare('SELECT * FROM kubernetes_agent_incidents ORDER BY detected_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>; }
  createKubernetesAttempt(attemptId: string, incidentId: string): void { this.db.prepare('INSERT INTO kubernetes_agent_attempts (attempt_id, incident_id, status, requested_at) VALUES (?, ?, ?, ?)').run(attemptId, incidentId, 'REQUESTED', now()); }
  finishKubernetesAttempt(attemptId: string, status: string, error?: string, result: unknown = {}): void { this.db.prepare('UPDATE kubernetes_agent_attempts SET status=?, completed_at=?, error=?, result_json=? WHERE attempt_id=?').run(status, now(), error?.slice(0, 1000) ?? null, JSON.stringify(result), attemptId); }

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
  private mapService(row: Record<string, unknown>, endpointRows: Array<Record<string, unknown>>): RegisteredService {
    return { id: String(row.id), name: String(row.name), description: String(row.description ?? ''), dockerEngine: String(row.docker_engine ?? 'default'), containerId: row.container_id ? String(row.container_id) : undefined, containerName: row.container_name ? String(row.container_name) : undefined, monitoringEnabled: Boolean(row.monitoring_enabled), intervalSeconds: Number(row.interval_seconds), failureThreshold: Number(row.failure_threshold), timeoutSeconds: Number(row.timeout_seconds), autoRecoveryEnabled: Boolean(row.auto_recovery_enabled), recoveryAction: row.recovery_action === 'START_CONTAINER' ? 'START_CONTAINER' : 'RESTART_CONTAINER', priority: (['HIGH','NORMAL','LOW'].includes(String(row.priority)) ? String(row.priority) : 'NORMAL') as ServicePriority, cooldownSeconds: Number(row.cooldown_seconds), verificationTimeoutSeconds: Number(row.verification_timeout_seconds), maxAttempts: Number(row.max_attempts), endpoints: endpointRows.map((endpoint) => ({ id: String(endpoint.id), serviceId: String(endpoint.service_id), friendlyName: String(endpoint.friendly_name), url: String(endpoint.url), expectedStatus: Number(endpoint.expected_status), enabled: Boolean(endpoint.enabled) })), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  private mapQueueItem(row: Record<string, unknown>): RecoveryQueueItem {
    return { id: Number(row.id), serviceId: String(row.service_id), serviceName: String(row.service_name), containerKey: row.container_key ? String(row.container_key) : undefined, incidentId: String(row.incident_id), agentId: row.agent_id ? String(row.agent_id) : undefined, priority: (['HIGH','NORMAL','LOW'].includes(String(row.priority)) ? String(row.priority) : 'NORMAL') as ServicePriority, action: row.action === 'START_CONTAINER' ? 'START_CONTAINER' : 'RESTART_CONTAINER', status: String(row.status) as RecoveryQueueStatus, attempts: Number(row.attempts), availableAt: String(row.available_at), lockedUntil: row.locked_until ? String(row.locked_until) : undefined, error: row.error ? String(row.error) : undefined, createdAt: String(row.created_at), startedAt: row.started_at ? String(row.started_at) : undefined, completedAt: row.completed_at ? String(row.completed_at) : undefined };
  }


  private incrementCounter(name: string, eventAt: string): void {
    this.db.prepare(`INSERT INTO stream_counters (name, value, last_event_at) VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET value=value+1, last_event_at=excluded.last_event_at`).run(name, eventAt);
  }
}
