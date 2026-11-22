import { useEffect, useState } from 'react';
import { KubernetesTerminal } from './kubernetes-terminal';
import './kubernetes-setup.css';
import './kubernetes-agent-topology.css';
import './kubernetes-observe.css';

type TestServiceStatus = { container: 'RUNNING' | 'STOPPED' | 'NOT_FOUND' | 'UNKNOWN'; api: 'REACHABLE' | 'UNREACHABLE'; statusCode: number | null; latencyMs: number; checkedAt: string; target: string; error: string | null };
type KubernetesTopology = { context: string; namespace: string; nodes: Array<Record<string, any>>; pods: Array<Record<string, any>>; observedAt: string };
type AgentObserveStatus = { policy: { enabled: boolean; failureThreshold: number; cooldownSeconds: number }; mode: { mode: string }; agents: Array<Record<string, any>>; incidents: Array<Record<string, any>>; events?: Array<Record<string, any>> };

const api = async <T,>(url: string): Promise<T> => {
  const token = sessionStorage.getItem('sentinelops-admin-token');
  const response = await fetch(url, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
};

export function KubernetesRecovery() {
  const [testService, setTestService] = useState<TestServiceStatus | null>(null);
  const [topology, setTopology] = useState<KubernetesTopology | null>(null);
  const [topologyError, setTopologyError] = useState('');
  const [agentStatus, setAgentStatus] = useState<AgentObserveStatus | null>(null);
  const [error, setError] = useState('');
  const [clusterName, setClusterName] = useState('sentinelops-dev');
  const [workerNodes, setWorkerNodes] = useState(3);
  const [agentPods, setAgentPods] = useState(3);
  const [namespace, setNamespace] = useState('sentinelops-system');
  const [setupBusy, setSetupBusy] = useState('');
  const [setupOutput, setSetupOutput] = useState('');
  const [setupMessage, setSetupMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try { const status = await api<TestServiceStatus>('/api/test-service/status'); const agents = await api<AgentObserveStatus>('/api/kubernetes/agent/status'); if (!cancelled) { setTestService(status); setAgentStatus(agents); setError(''); } }
      catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Test Service status unavailable'); }
      try { const snapshot = await api<KubernetesTopology>('/api/kubernetes/topology'); if (!cancelled) { setTopology(snapshot); setTopologyError(''); } }
      catch (reason) { if (!cancelled) setTopologyError(reason instanceof Error ? reason.message : 'Kubernetes topology unavailable'); }
    };
    void refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const runSetup = async (operation: string) => {
    setSetupBusy(operation); setSetupOutput(''); setSetupMessage('');
    try {
      const token = sessionStorage.getItem('sentinelops-admin-token');
      const response = await fetch(`/api/kubernetes/setup/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ clusterName, workerNodes, agentPods, namespace }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Operation failed (${response.status})`);
      setSetupOutput(result.output ?? ''); setSetupMessage(`${operation.replaceAll('-', ' ')} completed.`);
    } catch (reason) { setSetupMessage(reason instanceof Error ? reason.message : 'Kubernetes setup failed'); }
    finally { setSetupBusy(''); }
  };
  return <section className="kubernetes-recovery">
    <div className="kubernetes-page-header"><div><span className="eyebrow">KUBERNETES OPERATIONS</span><h2>Kubernetes Recovery</h2><p>Interactive shell for the isolated Kubernetes terminal environment.</p></div><span className={`kube-connection ${error ? 'error' : 'ready'}`}><i /> {error ? 'STATUS UNAVAILABLE' : 'TERMINAL READY'}</span></div>
    <section className="panel kube-setup-card"><div className="panel-head"><div><span className="eyebrow">CLUSTER SETUP</span><h3>Create or inspect the kind cluster</h3></div><span className="muted">Each button runs one real operation</span></div><div className="kube-setup-fields"><label>Cluster name<input value={clusterName} onChange={(event) => setClusterName(event.target.value)} /></label><label>Worker nodes<input type="number" min="0" max="10" value={workerNodes} onChange={(event) => setWorkerNodes(Number(event.target.value))} /></label><label>Agent Pods<input type="number" min="1" max="20" value={agentPods} onChange={(event) => setAgentPods(Number(event.target.value))} /></label><label>Namespace<input value={namespace} onChange={(event) => setNamespace(event.target.value)} /></label></div><p className="muted">1 control-plane + {workerNodes} workers = {workerNodes + 1} total nodes.</p><div className="kube-setup-buttons"><button className="primary" disabled={!!setupBusy} onClick={() => void runSetup('create-cluster')}>Create Cluster</button><button disabled={!!setupBusy} onClick={() => void runSetup('check-cluster')}>Check Cluster</button><button disabled={!!setupBusy} onClick={() => void runSetup('create-namespace')}>Create Namespace</button><button disabled={!!setupBusy} onClick={() => void runSetup('deploy-agent')}>Deploy Agent Pods</button></div>{setupBusy && <p className="kube-setup-running">Running {setupBusy.replaceAll('-', ' ')}… output is also streamed in the terminal.</p>}{setupMessage && <p className="kube-service-error">{setupMessage}</p>}{setupOutput && <pre className="kube-setup-output">{setupOutput}</pre>}</section>
    <section className="panel kube-agent-topology"><div className="panel-head"><div><span className="eyebrow">READ-ONLY LIVE TOPOLOGY</span><h3>Kubernetes Agent Topology</h3></div><span className="muted">{topology ? `Observed ${new Date(topology.observedAt).toLocaleTimeString()}` : 'Waiting for Kubernetes'}</span></div>{topologyError ? <p className="kube-service-error">{topologyError}</p> : topology ? <div className="kube-topology-flow"><div className="kube-topology-cluster"><strong>KUBERNETES CLUSTER</strong><small>{topology.context} · {topology.namespace}</small><div className="kube-topology-nodes">{topology.nodes.map((node) => { const name = String(node.metadata?.name ?? 'unknown'); const controlPlane = Boolean(node.metadata?.labels?.['node-role.kubernetes.io/control-plane'] || node.metadata?.labels?.['node-role.kubernetes.io/master']); const pods = topology.pods.filter((pod) => pod.spec?.nodeName === name); const ready = node.status?.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True'); return <div className={`kube-topology-node ${ready ? 'ready' : 'not-ready'}`} key={name}><strong>{name}</strong><small>{controlPlane ? 'CONTROL PLANE' : 'WORKER'} · {ready ? 'READY' : 'NOT READY'}</small><div className="kube-topology-pods">{pods.length ? pods.map((pod) => <span key={pod.metadata?.name} className="kube-topology-pod"><b>{String(pod.metadata?.name)}</b><small>{String(pod.status?.phase ?? 'UNKNOWN')} · {pod.status?.containerStatuses?.every((container: any) => container.ready) ? 'READY' : 'NOT READY'}</small></span>) : <em>No Agent Pods assigned</em>}</div></div>; })}</div></div><div className="kube-topology-external"><strong>EXTERNAL TEST SERVICE</strong><small>Docker · {testService?.api ?? 'UNKNOWN'}</small><span>Monitoring and authorized recovery communication</span></div></div> : <p className="muted">Loading actual Kubernetes nodes and Agent Pods…</p>}</section>
    <section className="kube-terminal panel"><div className="kube-terminal-head"><div><span className="eyebrow">LIVE SHELL</span><h3>SentinelOops Kubernetes terminal</h3></div><span className="muted">bash · /workspace · persistent session</span></div><KubernetesTerminal /><p className="kube-terminal-note">Commands run inside the dedicated <code>kubernetes-terminal</code> container. Docker Engine access is disabled unless explicitly configured.</p></section>
    <section className="panel kube-service-status"><div className="panel-head"><div><span className="eyebrow">TEST SERVICE STATUS</span><h3>Independent Test Service</h3></div><span className={`kube-status-badge ${testService?.api === 'REACHABLE' ? 'healthy' : 'down'}`}>{testService?.api ?? 'UNKNOWN'}</span></div><div className="kube-service-grid"><div><span>Container</span><strong>{testService?.container ?? 'UNKNOWN'}</strong></div><div><span>API</span><strong>{testService?.statusCode ?? 'N/A'} · {testService?.latencyMs ?? 'N/A'}ms</strong></div><div><span>Last health check</span><strong>{testService ? new Date(testService.checkedAt).toLocaleTimeString() : 'N/A'}</strong></div><div><span>Endpoint</span><strong>{testService?.target ?? 'http://localhost:8080'}</strong></div></div>{testService?.error && <p className="kube-service-error">{testService.error}</p>}</section>
    <section className="panel kube-observe-recovery"><div className="panel-head"><div><span className="eyebrow">OBSERVE &amp; RECOVERY</span><h3>Agent recovery status</h3></div><span className={`kube-status-badge ${agentStatus?.policy.enabled ? 'healthy' : 'down'}`}>{agentStatus?.policy.enabled ? 'ENABLED' : 'DISABLED'}</span></div><div className="kube-service-grid"><div><span>Mode</span><strong>{agentStatus?.mode.mode ?? 'UNKNOWN'}</strong></div><div><span>Agent Pods</span><strong>{agentStatus?.agents.length ?? 0}</strong></div><div><span>Active incidents</span><strong>{agentStatus?.incidents.filter((incident) => ['ACTIVE', 'RECOVERING'].includes(String(incident.status))).length ?? 0}</strong></div><div><span>Recovered incidents</span><strong>{agentStatus?.incidents.filter((incident) => incident.status === 'RECOVERED').length ?? 0}</strong></div></div><p className="muted">Agents observe the Test Service, detect consecutive health failures, acquire recovery ownership, and request authorized container recovery through SentinelOops.</p>{agentStatus?.events?.[0] && <p className="kube-observe-event">Latest event: <b>{String(agentStatus.events[0].event_type)}</b> · {String(agentStatus.events[0].occurred_at)}</p>}</section>
  </section>;
}
