import React, { useEffect, useState } from 'react';
import './setup.css';

type Endpoint = { id: number; applicationName: string; endpointUrl: string; method: 'GET' | 'HEAD'; expectedStatus: number; intervalSeconds: number; environment: string; authConfigured: boolean };
type Status = { configured: boolean; administratorCreated: boolean; authRequired: boolean; components: Record<string, boolean>; endpoints: Endpoint[] };
type FormState = { applicationName: string; endpointUrl: string; probeUrl: string; networkScope: 'external' | 'host' | 'docker'; method: 'GET' | 'HEAD'; expectedStatus: number; intervalSeconds: number; environment: string; authType: 'none'; authSecret: string };

class SetupRequestError extends Error { details: Record<string, unknown>; constructor(message: string, details: Record<string, unknown>) { super(message); this.details = details; } }

const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SetupRequestError(body.error ?? `Request failed (${response.status})`, body);
  return body as T;
};

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function Setup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem('sentinelops-admin-token') ?? '');
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [suggestedUrl, setSuggestedUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState<FormState>({ applicationName: '', endpointUrl: '', probeUrl: '', networkScope: 'external', method: 'GET', expectedStatus: 200, intervalSeconds: 30, environment: 'production', authType: 'none', authSecret: '' });

  const auth = () => adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
  const load = () => request<Status>('/api/setup/status').then(setStatus).catch((e) => setError(errorMessage(e, 'Unable to load setup status')));

  useEffect(() => { void load(); }, []);

  const bootstrap = async () => {
    setBusy('bootstrap'); setError(''); setMessage('');
    try {
      const result = await request<{ token: string }>('/api/setup/bootstrap', { method: 'POST', headers: { 'x-setup-token': token } });
      setAdminToken(result.token); sessionStorage.setItem('sentinelops-admin-token', result.token); setStep(3);
    } catch (e) { setError(errorMessage(e, 'Administrator setup failed')); } finally { setBusy(''); }
  };

  const testConnectivity = async () => {
    setBusy('test'); setError(''); setMessage(''); setSuggestedUrl('');
    try {
      const result = await request<{ reachable: boolean; status: number; statusText: string }>('/api/setup/endpoints/test', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!result.reachable) throw new Error(`Endpoint responded with HTTP ${result.status} ${result.statusText}; expected HTTP ${form.expectedStatus}.`);
      setMessage(`Connectivity test passed with HTTP ${result.status}.`);
    } catch (e) {
      const details = e instanceof SetupRequestError ? e.details : {};
      if (typeof details.suggestedUrl === 'string') setSuggestedUrl(details.suggestedUrl);
      setError(errorMessage(e, 'Connectivity test failed'));
    } finally { setBusy(''); }
  };

  const addEndpoint = async () => {
    setBusy('register'); setError(''); setMessage('');
    try {
      await request('/api/setup/endpoints', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      setForm({ ...form, applicationName: '', endpointUrl: '', probeUrl: '', networkScope: 'external', authSecret: '' }); await load(); setMessage('Endpoint registered.');
    } catch (e) { setError(errorMessage(e, 'Endpoint registration failed')); } finally { setBusy(''); }
  };

  const activate = async () => {
    setBusy('activate'); setError(''); setMessage('');
    try { await request('/api/setup/activate', { method: 'POST', headers: auth() }); await load(); setStep(5); }
    catch (e) { setError(errorMessage(e, 'Monitoring activation failed')); } finally { setBusy(''); }
  };

  if (!status) return <main className="setup-shell"><section className="setup-card"><p>Checking installation readiness...</p></section></main>;
  const disabled = Boolean(busy);

  return <main className="setup-shell"><section className="setup-card">
    <header className="setup-header"><span className="setup-mark">SO</span><div><strong>SentinelOps</strong><small>Infrastructure monitoring</small></div><span className="setup-step">STEP {step} / 5</span></header>
    {error && <div className="setup-error" role="alert">{error}{suggestedUrl && <button type="button" className="setup-secondary" onClick={() => { setForm({ ...form, probeUrl: suggestedUrl, networkScope: 'host' }); setMessage(`Using Docker host probe URL: ${suggestedUrl}`); setError(''); }}>Use {suggestedUrl}</button>}</div>}{message && <div className="setup-success" role="status">{message}</div>}
    {step === 1 && <><p className="setup-eyebrow">FIRST-RUN CONFIGURATION</p><h1>Welcome to SentinelOps</h1><p className="setup-lead">Let's configure your infrastructure monitoring.</p><div className="readiness">{[['sentinelops', 'SentinelOps'], ['prometheus', 'Prometheus'], ['grafana', 'Grafana'], ['blackboxExporter', 'Blackbox Exporter']].map(([key, label]) => <div key={key}><i className={status.components[key] ? 'ready' : ''} /><span>{label}</span><b>{status.components[key] ? 'Ready' : 'Unavailable'}</b></div>)}</div><button type="button" className="setup-primary" onClick={() => setStep(status.administratorCreated || !status.authRequired ? 3 : 2)}>Begin setup</button></>}
    {step === 2 && <><p className="setup-eyebrow">ADMINISTRATOR SETUP</p><h1>Secure your installation</h1><p className="setup-lead">Enter the one-time setup token printed by the installer. It is required before monitoring configuration can be changed.</p><label className="setup-label">One-time setup token<input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label><button type="button" className="setup-primary" disabled={disabled} onClick={() => void bootstrap()}>{busy === 'bootstrap' ? 'Creating session...' : 'Create administrator session'}</button></>}
    {step === 3 && <><p className="setup-eyebrow">REGISTER API ENDPOINTS</p><h1>What should we monitor?</h1><p className="setup-lead">Register GET or HEAD health endpoints. Host and Docker targets require an explicit probe address.</p><div className="setup-form"><label>Application name<input value={form.applicationName} onChange={e => setForm({ ...form, applicationName: e.target.value })} /></label><label>Endpoint URL<input placeholder="http://localhost:8080/health" value={form.endpointUrl} onChange={e => setForm({ ...form, endpointUrl: e.target.value })} /></label><label>Probe network<select value={form.networkScope} onChange={e => setForm({ ...form, networkScope: e.target.value as FormState['networkScope'] })}><option value="external">External URL</option><option value="host">Docker host</option><option value="docker">Docker service network</option></select></label><label>Probe URL<input placeholder="Optional, for example http://host.docker.internal:8080/health" value={form.probeUrl} onChange={e => setForm({ ...form, probeUrl: e.target.value })} /></label><label>Method<select value={form.method} onChange={e => setForm({ ...form, method: e.target.value as 'GET' | 'HEAD' })}><option>GET</option><option>HEAD</option></select></label><label>Expected HTTP status<input type="number" value={form.expectedStatus} onChange={e => setForm({ ...form, expectedStatus: Number(e.target.value) })} /></label><label>Interval seconds<input type="number" min="5" value={form.intervalSeconds} onChange={e => setForm({ ...form, intervalSeconds: Number(e.target.value) })} /></label><label>Environment<select value={form.environment} onChange={e => setForm({ ...form, environment: e.target.value })}><option>production</option><option>staging</option><option>development</option></select></label></div><button type="button" className="setup-secondary" disabled={disabled} onClick={() => void testConnectivity()}>{busy === 'test' ? 'Testing backend and Blackbox...' : 'Test connectivity'}</button><button type="button" className="setup-primary" disabled={disabled} onClick={() => void addEndpoint()}>{busy === 'register' ? 'Registering endpoint...' : 'Register endpoint'}</button><div className="endpoint-list">{status.endpoints.map(endpoint => <div key={endpoint.id}><span><strong>{endpoint.applicationName}</strong><small>{endpoint.endpointUrl} → {endpoint.probeUrl}</small></span><button type="button" onClick={() => void request(`/api/setup/endpoints/${endpoint.id}`, { method: 'DELETE', headers: auth() }).then(load)}>Remove</button></div>)}</div><button type="button" className="setup-link" onClick={() => setStep(4)}>Continue to monitoring</button></>}
    {step === 4 && <><p className="setup-eyebrow">MONITORING CONFIGURATION</p><h1>Activate monitoring</h1><p className="setup-lead">Prometheus will discover the registered endpoints through Blackbox Exporter. Configuration changes are applied without restarting Prometheus.</p><div className="configuration-summary"><b>{status.endpoints.length}</b><span>registered endpoint{status.endpoints.length === 1 ? '' : 's'}</span></div><button type="button" className="setup-primary" disabled={disabled} onClick={() => void activate()}>{busy === 'activate' ? 'Configuring monitoring...' : 'Configure Monitoring'}</button></>}
    {step === 5 && <><p className="setup-eyebrow">INSTALLATION COMPLETE</p><h1>SentinelOps Installed Successfully</h1><p className="setup-lead">Monitoring configuration is active and your endpoint targets are being discovered.</p><div className="setup-actions"><a href="/">Open Dashboard</a><button type="button" onClick={() => setStep(3)}>View Registered APIs</button></div></>}
  </section></main>;
}
