import { useEffect, useState } from 'react';
import { KubernetesTerminal } from './kubernetes-terminal';

type TestServiceStatus = { container: 'RUNNING' | 'STOPPED' | 'NOT_FOUND' | 'UNKNOWN'; api: 'REACHABLE' | 'UNREACHABLE'; statusCode: number | null; latencyMs: number; checkedAt: string; target: string; error: string | null };

const api = async <T,>(url: string): Promise<T> => {
  const token = sessionStorage.getItem('sentinelops-admin-token');
  const response = await fetch(url, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
};

export function KubernetesRecovery() {
  const [testService, setTestService] = useState<TestServiceStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try { const status = await api<TestServiceStatus>('/api/test-service/status'); if (!cancelled) { setTestService(status); setError(''); } }
      catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Test Service status unavailable'); }
    };
    void refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  return <section className="kubernetes-recovery">
    <div className="kubernetes-page-header"><div><span className="eyebrow">KUBERNETES OPERATIONS</span><h2>Kubernetes Recovery</h2><p>Interactive shell for the isolated Kubernetes terminal environment.</p></div><span className={`kube-connection ${error ? 'error' : 'ready'}`}><i /> {error ? 'STATUS UNAVAILABLE' : 'TERMINAL READY'}</span></div>
    <section className="kube-terminal panel"><div className="kube-terminal-head"><div><span className="eyebrow">LIVE SHELL</span><h3>SentinelOops Kubernetes terminal</h3></div><span className="muted">bash · /workspace · persistent session</span></div><KubernetesTerminal /><p className="kube-terminal-note">Commands run inside the dedicated <code>kubernetes-terminal</code> container. Docker Engine access is disabled unless explicitly configured.</p></section>
    <section className="panel kube-service-status"><div className="panel-head"><div><span className="eyebrow">TEST SERVICE STATUS</span><h3>Independent Test Service</h3></div><span className={`kube-status-badge ${testService?.api === 'REACHABLE' ? 'healthy' : 'down'}`}>{testService?.api ?? 'UNKNOWN'}</span></div><div className="kube-service-grid"><div><span>Container</span><strong>{testService?.container ?? 'UNKNOWN'}</strong></div><div><span>API</span><strong>{testService?.statusCode ?? 'N/A'} · {testService?.latencyMs ?? 'N/A'}ms</strong></div><div><span>Last health check</span><strong>{testService ? new Date(testService.checkedAt).toLocaleTimeString() : 'N/A'}</strong></div><div><span>Endpoint</span><strong>{testService?.target ?? 'http://localhost:8080'}</strong></div></div>{testService?.error && <p className="kube-service-error">{testService.error}</p>}</section>
  </section>;
}
