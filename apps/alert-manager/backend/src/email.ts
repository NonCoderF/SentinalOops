import nodemailer from 'nodemailer';
import type { AlertRecord, EmailDelivery, NotificationSettings } from './db.js';

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function serviceName(alert: AlertRecord): string {
  return alert.labels.service ?? alert.labels.job ?? 'unknown-service';
}

function severity(alert: AlertRecord): string {
  return (alert.labels.severity ?? 'info').toUpperCase();
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(service|severity|alertName|description|timestamp|status|duration|dashboardUrl|subject)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

export function formatAlertEmail(alert: AlertRecord, event: 'firing' | 'resolved', dashboardUrl?: string, settings?: NotificationSettings): EmailMessage {
  const service = serviceName(alert);
  const description = alert.annotations.description ?? alert.annotations.summary ?? 'No description provided.';
  const isResolved = event === 'resolved';
  const defaultSubject = isResolved
    ? `[RESOLVED] SentinelOps — ${service} recovered`
    : `[${severity(alert)}] SentinelOps — ${service} ${alert.labels.alertname === 'ServiceDown' ? 'DOWN' : alert.labels.alertname ?? 'alert'}`;
  const occurredAt = isResolved ? (alert.resolvedAt ?? alert.endsAt ?? new Date().toISOString()) : (alert.startsAt ?? alert.firstSeenAt);
  const duration = isResolved && alert.startsAt && occurredAt
    ? `${Math.max(0, new Date(occurredAt).getTime() - new Date(alert.startsAt).getTime()) / 1000}s`
    : undefined;
  const link = dashboardUrl ? `\nDashboard: ${dashboardUrl}` : '';
  const defaultText = isResolved
    ? `${defaultSubject}\n\nService: ${service}\nRecovery time: ${occurredAt}\nIncident duration: ${duration ?? 'unknown'}\nDescription: ${description}${link}`
    : `${defaultSubject}\n\nService: ${service}\nSeverity: ${severity(alert)}\nAlert: ${alert.labels.alertname ?? 'unknown'}\nDescription: ${description}\nFailure detected: ${occurredAt}\nStatus: FIRING${link}`;
  const values = { service, severity: severity(alert), alertName: alert.labels.alertname ?? 'unknown', description, timestamp: occurredAt, status: isResolved ? 'RESOLVED' : 'FIRING', duration: duration ?? 'unknown', dashboardUrl: dashboardUrl ?? '', subject: defaultSubject };
  const subject = renderTemplate(isResolved ? (settings?.resolvedSubject || defaultSubject) : (settings?.firingSubject || defaultSubject), values);
  const text = settings?.content
    ? renderTemplate(settings.content, { ...values, subject })
    : renderTemplate(isResolved ? (settings?.resolvedBody || defaultText) : (settings?.firingBody || defaultText), { ...values, subject });
  const rows = [
    ['Service', service],
    ['Severity', isResolved ? 'RESOLVED' : severity(alert)],
    ['Alert', alert.labels.alertname ?? 'unknown'],
    ['Description', description],
    [isResolved ? 'Recovery time' : 'Failure detected', occurredAt],
    ...(duration ? [['Incident duration', duration]] : []),
    ['Status', isResolved ? 'RESOLVED' : 'FIRING']
  ];
  const htmlRows = rows.map(([label, value]) => `<tr><td style="padding:8px 12px;color:#94a3b8">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#e2e8f0">${escapeHtml(value)}</td></tr>`).join('');
  const details = `<table style="width:100%;border-collapse:collapse">${htmlRows}</table>`;
  const html = `<div style="background:#0f172a;padding:24px;font-family:Arial,sans-serif;color:#e2e8f0"><div style="max-width:680px;margin:auto;background:#111827;border:1px solid #334155;border-radius:12px;padding:24px"><h2 style="margin-top:0;color:${isResolved ? '#34d399' : '#f87171'}">${escapeHtml(subject)}</h2><pre style="white-space:pre-wrap;font:inherit;color:#e2e8f0">${escapeHtml(text)}</pre>${details}${dashboardUrl ? `<p style="margin-bottom:0"><a style="color:#60a5fa" href="${escapeHtml(dashboardUrl)}">Open SentinelOps dashboard</a></p>` : ''}</div></div>`;
  return { subject, text, html };
}

function shouldNotify(settings: NotificationSettings, event: 'firing' | 'resolved', alert: AlertRecord): boolean {
  if (!settings.enabled) return false;
  if (event === 'firing' && !settings.notifyFiring) return false;
  if (event === 'resolved' && !settings.notifyResolved) return false;
  const alertSeverity = alert.labels.severity ?? 'info';
  return settings.severityFilter.length === 0 || settings.severityFilter.includes(alertSeverity);
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sendAlertEmail(
  alert: AlertRecord,
  event: 'firing' | 'resolved',
  settings: NotificationSettings,
  dashboardUrl: string | undefined,
  record: (delivery: Omit<EmailDelivery, 'id' | 'createdAt'>) => EmailDelivery,
  transportFactory: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<EmailDelivery | undefined> {
  if (!shouldNotify(settings, event, alert)) return undefined;
  const message = formatAlertEmail(alert, event, dashboardUrl, settings);
  const recipients = settings.recipients;
  let lastError = 'SMTP delivery failed';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const transport = transportFactory({ host: settings.smtpHost, port: settings.smtpPort, secure: settings.smtpSecure, auth: settings.smtpUsername ? { user: settings.smtpUsername, pass: settings.smtpPassword } : undefined });
      await transport.sendMail({ from: settings.fromEmail, to: recipients.join(', '), subject: message.subject, text: message.text, html: message.html });
      return record({ fingerprint: alert.fingerprint, event, status: 'sent', recipients, subject: message.subject });
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'SMTP delivery failed';
      if (attempt < 2) await pause(250 * (2 ** attempt));
    }
  }
  return record({ fingerprint: alert.fingerprint, event, status: 'failed', recipients, subject: message.subject, error: lastError });
}

export async function sendTestEmail(
  settings: NotificationSettings,
  dashboardUrl: string | undefined,
  record: (delivery: Omit<EmailDelivery, 'id' | 'createdAt'>) => EmailDelivery,
  transportFactory: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<EmailDelivery> {
  const now = new Date().toISOString();
  const alert: AlertRecord = {
    fingerprint: 'test-email',
    status: 'firing',
    labels: { alertname: 'SentinelOpsTestEmail', service: 'sentinelops', severity: 'info' },
    annotations: { description: 'This is a SentinelOps SMTP configuration test.' },
    startsAt: now,
    firstSeenAt: now,
    lastSeenAt: now
  };
  const message = formatAlertEmail(alert, 'firing', dashboardUrl, settings);
  let lastError = 'SMTP delivery failed';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const transport = transportFactory({ host: settings.smtpHost, port: settings.smtpPort, secure: settings.smtpSecure, auth: settings.smtpUsername ? { user: settings.smtpUsername, pass: settings.smtpPassword } : undefined });
      await transport.sendMail({ from: settings.fromEmail, to: settings.recipients.join(', '), subject: `[TEST] ${message.subject}`, text: message.text, html: message.html });
      return record({ event: 'test', status: 'sent', recipients: settings.recipients, subject: `[TEST] ${message.subject}` });
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'SMTP delivery failed';
      if (attempt < 2) await pause(250 * (2 ** attempt));
    }
  }
  return record({ event: 'test', status: 'failed', recipients: settings.recipients, subject: `[TEST] ${message.subject}`, error: lastError });
}

export function validateEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
