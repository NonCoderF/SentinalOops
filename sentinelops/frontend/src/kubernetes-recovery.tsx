import { useEffect, useMemo, useState } from 'react';
import { KubernetesTerminal } from './kubernetes-terminal';
import './kubernetes-setup.css';
import './kubernetes-agent-topology.css';
import './kubernetes-observe.css';
import './kubernetes-outage-card.css';

type TestServiceStatus = { container: 'RUNNING' | 'STOPPED' | 'NOT_FOUND' | 'UNKNOWN'; api: 'REACHABLE' | 'UNREACHABLE'; statusCode: number | null; latencyMs: number; checkedAt: string; target: string; error: string | null };
type RegisteredServiceStatus = { serviceId: string; service: string; container: string; containerState: string; api: 'REACHABLE' | 'UNREACHABLE' | 'UNKNOWN'; statusCode: number | null; endpoint: string | null; error: string | null; monitoringEnabled: boolean; autoRecoveryEnabled: boolean; authorizedRecovery: boolean; recoveryStatus: string | null; responsibleAgent: string | null };
type KubernetesTopology = { context: string; namespace: string; nodes: Array<Record<string, any>>; pods: Array<Record<string, any>>; observedAt: string };
type AgentObserveStatus = { policy: { enabled: boolean; failureThreshold: number; cooldownSeconds: number }; mode: { mode: string }; agents: Array<Record<string, any>>; incidents: Array<Record<string, any>>; events?: Array<Record<string, any>> };
type ClusterDiscovery = { state: 'ready' | 'absent' | 'error'; context: string; clusterName: string; namespace: string; reachable: boolean; namespaceExists: boolean; agentPods: number };
type AgentViewState = 'MONITORING' | 'RECOVERING' | 'RECOVERED' | 'FAILED' | 'OFFLINE';

const api = async <T,>(url: string): Promise<T> => {
  const token = sessionStorage.getItem('sentinelops-admin-token');
  const response = await fetch(url, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
};
const payloadOf = (event: Record<string, any>): Record<string, any> => { try { return typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : (event.payload_json ?? {}); } catch { return {}; } };
const eventAgentId = (event: Record<string, any>): string => String(event.agent_id ?? payloadOf(event).agentId ?? '');
const eventTime = (event: Record<string, any>): number => Date.parse(String(event.occurred_at ?? '')) || 0;
const eventText = (event: Record<string, any>, label: string, podName?: string): string => {
  const type = String(event.event_type ?? 'event'); const suffix = podName ? ` (${podName})` : '';
  if (type === 'api.unhealthy' || type === 'incident.created') return `${String(payloadOf(event).service ?? 'Registered service')} unavailable — detected by ${label}${suffix}`;
  if (type === 'recovery.ownership_acquired') return `Recovering by ${label}${suffix}`;
  if (type === 'recovery.requested') return `${label} requested Docker recovery${suffix}`;
  if (type === 'recovery.started') return `Docker recovery started for ${label}${suffix}`;
  if (type === 'recovery.succeeded' || type === 'incident.resolved') return `API healthy — Recovered by ${label}${suffix}`;
  if (type === 'recovery.failed') return `Recovery failed for ${label}${suffix}`;
  return `${type} — ${label}${suffix}`;
};

export function KubernetesRecovery() {
  const [discovery, setDiscovery] = useState<ClusterDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [screen, setScreen] = useState<'setup' | 'console'>('setup');
  const [screenInitialized, setScreenInitialized] = useState(false);
  const [testService, setTestService] = useState<TestServiceStatus | null>(null);
  const [serviceStatuses, setServiceStatuses] = useState<RegisteredServiceStatus[]>([]);
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
  const [outageBusy, setOutageBusy] = useState(false);
  const [outageMessage, setOutageMessage] = useState('');
  const [outagePending, setOutagePending] = useState(false);
  const [outageStartedAt, setOutageStartedAt] = useState(0);

  const loadDiscovery = async (showLoading = true) => {
    if (showLoading) setDiscoveryLoading(true);
    setDiscoveryError('');
    try {
      const result = await api<ClusterDiscovery>('/api/kubernetes/discovery');
      setDiscovery(result);
      if (!screenInitialized) setScreen(result.state === 'ready' ? 'console' : 'setup');
      setScreenInitialized(true);
    } catch (reason) {
      setDiscoveryError(reason instanceof Error ? reason.message : 'Kubernetes cluster discovery failed');
      setScreenInitialized(true);
    } finally { if (showLoading) setDiscoveryLoading(false); }
  };

  useEffect(() => { void loadDiscovery(); }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!discovery || discovery.state !== 'ready') return;
      try { const [status, agents, registered] = await Promise.all([api<TestServiceStatus>('/api/test-service/status'), api<AgentObserveStatus>('/api/kubernetes/agent/status'), api<{ services: RegisteredServiceStatus[] }>('/api/kubernetes/registered-services/status')]); if (!cancelled) { setTestService(status); setAgentStatus(agents); setServiceStatuses(registered.services); setError(''); } }
      catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Test Service status unavailable'); }
      try { const snapshot = await api<KubernetesTopology>('/api/kubernetes/topology'); if (!cancelled) { setTopology(snapshot); setTopologyError(''); } }
      catch (reason) { if (!cancelled) setTopologyError(reason instanceof Error ? reason.message : 'Kubernetes topology unavailable'); }
    };
    void refresh(); const timer = window.setInterval(refresh, 5000); return () => { cancelled = true; window.clearInterval(timer); };
  }, [discovery]);

  useEffect(() => {
    if (!outagePending || !outageStartedAt || testService?.api !== 'REACHABLE') return;
    const recovered = (agentStatus?.events ?? []).some((event) => {
      const type = String(event.event_type);
      return eventTime(event) >= outageStartedAt && ['recovery.succeeded', 'incident.resolved'].includes(type);
    });
    if (!recovered) return;
    setOutageMessage('');
    setOutagePending(false);
    setOutageStartedAt(0);
  }, [agentStatus, outagePending, outageStartedAt, testService]);

  const agentLabels = useMemo(() => {
    const stored = JSON.parse(localStorage.getItem('sentinelops-agent-labels') ?? '{}') as Record<string, string>;
    const identities = (topology?.pods ?? []).map((pod) => { const podName = String(pod.metadata?.name ?? ''); const agent = agentStatus?.agents.find((item) => String(item.pod_name ?? '') === podName); return { key: String(agent?.agent_id ?? podName) }; }).filter((item) => item.key).sort((a, b) => a.key.localeCompare(b.key));
    let next = Object.values(stored).map((value) => Number(value.replace('Agent ', ''))).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), 0) + 1;
    for (const identity of identities) if (!stored[identity.key]) stored[identity.key] = `Agent ${next++}`;
    localStorage.setItem('sentinelops-agent-labels', JSON.stringify(stored)); return stored;
  }, [topology, agentStatus]);

  const podView = (pod: Record<string, any>): { label: string; state: AgentViewState } => {
    const podName = String(pod.metadata?.name ?? 'unknown'); const row = agentStatus?.agents.find((item) => String(item.pod_name ?? '') === podName); const agentId = String(row?.agent_id ?? '');
    const label = agentLabels[agentId || podName] ?? 'Agent ?'; const relevant = (agentStatus?.events ?? []).filter((event) => eventAgentId(event) === agentId).sort((a, b) => eventTime(b) - eventTime(a)); const latest = relevant.find((event) => String(event.event_type).startsWith('recovery.') || event.event_type === 'incident.resolved'); const age = latest ? Date.now() - eventTime(latest) : Number.POSITIVE_INFINITY;
    let state: AgentViewState = row && Date.now() - Date.parse(String(row.last_heartbeat ?? '')) < 30000 ? 'MONITORING' : 'OFFLINE';
    if (latest && ['recovery.ownership_acquired', 'recovery.requested', 'recovery.started'].includes(String(latest.event_type)) && age < 120000) state = 'RECOVERING';
    if (latest && ['recovery.succeeded', 'incident.resolved'].includes(String(latest.event_type)) && age < 30000) state = 'RECOVERED';
    if (latest?.event_type === 'recovery.failed' && age < 120000) state = 'FAILED'; return { label, state };
  };

  const recoveryLog = useMemo(() => {
    const seenDetections = new Set<string>();
    return (agentStatus?.events ?? []).filter((event) => ['api.unhealthy', 'incident.created', 'recovery.ownership_acquired', 'recovery.requested', 'recovery.started', 'recovery.succeeded', 'recovery.failed', 'incident.resolved'].includes(String(event.event_type))).filter((event) => {
      const type = String(event.event_type);
      if (!['api.unhealthy', 'incident.created'].includes(type)) return true;
      const service = String(payloadOf(event).service ?? 'registered-service');
      if (seenDetections.has(service)) return false;
      seenDetections.add(service);
      return true;
    }).slice(0, 30).map((event) => {
    const agentId = eventAgentId(event); const row = agentStatus?.agents.find((item) => String(item.agent_id) === agentId); const podName = row?.pod_name ? String(row.pod_name) : undefined; const label = agentLabels[agentId] ?? 'Unknown Agent'; return { ...event, text: eventText(event, label, podName) };
    });
  }, [agentStatus, agentLabels]);

  const runSetup = async (operation: string) => {
    setSetupBusy(operation); setSetupOutput(''); setSetupMessage('');
    try { const token = sessionStorage.getItem('sentinelops-admin-token'); const response = await fetch(`/api/kubernetes/setup/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ clusterName, workerNodes, agentPods, namespace }) }); const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error ?? `Operation failed (${response.status})`); setSetupOutput(result.output ?? ''); setSetupMessage(`${operation.replaceAll('-', ' ')} completed.`); void loadDiscovery(false); }
    catch (reason) { setSetupMessage(reason instanceof Error ? reason.message : 'Kubernetes setup failed'); } finally { setSetupBusy(''); }
  };

  const shutdownCluster = async () => {
    if (!window.confirm(`Shutdown cluster ${discovery?.clusterName ?? clusterName}? This permanently deletes its control-plane and worker nodes. Continue?`)) return;
    setSetupBusy('delete-cluster'); setSetupOutput(''); setSetupMessage('');
    try {
      const token = sessionStorage.getItem('sentinelops-admin-token');
      const response = await fetch('/api/kubernetes/setup/delete-cluster', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ clusterName: discovery?.clusterName ?? clusterName, workerNodes, agentPods, namespace: discovery?.namespace ?? namespace }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Cluster shutdown failed (${response.status})`);
      setSetupOutput(result.output ?? '');
      setSetupMessage(`Cluster ${clusterName} was shut down. Control-plane and workers were deleted.`);
      setScreen('setup');
      void loadDiscovery(false);
    } catch (reason) { setSetupMessage(reason instanceof Error ? reason.message : 'Cluster shutdown failed'); }
    finally { setSetupBusy(''); }
  };

  const goToConsole = () => {
    setScreen('console');
    if (!discovery || discovery.state !== 'ready') setSetupMessage('Warning: the Kubernetes cluster is not currently reachable. Console access is available, but live cluster data may be unavailable.');
    else if (discovery.agentPods === 0) setSetupMessage('Warning: no Agent Pods are running. Use the setup actions to create the namespace and deploy Agents.');
  };

  const performOutage = async () => {
    const target = testService?.container ?? 'the allowlisted development Test Service';
    if (!window.confirm(`Stop ${target} now? Kubernetes Agents must detect and recover it. The action will not restart the container directly.`)) return;
    setOutageBusy(true); setOutageMessage('');
    try {
      const token = sessionStorage.getItem('sentinelops-admin-token');
      const response = await fetch('/api/kubernetes/failure-test/stop-service', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Outage request failed (${response.status})`);
      setOutagePending(true);
      setOutageStartedAt(Date.now());
      const stopped = Array.isArray(result.services) ? result.services.map((item: { service?: string }) => item.service).join(', ') : result.targetContainer ?? result.service;
      setOutageMessage(`Outage initiated for ${stopped}. Agents will detect failures and recover registered services sequentially.`);
    } catch (reason) { setOutagePending(false); setOutageMessage(reason instanceof Error ? reason.message : 'Outage request failed'); }
    finally { setOutageBusy(false); }
  };

  const performServiceOutage = async (service: RegisteredServiceStatus) => {
    if (!window.confirm(`Stop ${service.service} (${service.container}) now? Kubernetes Agents must detect and recover this service.`)) return;
    setOutageBusy(true); setOutageMessage('');
    try {
      const token = sessionStorage.getItem('sentinelops-admin-token');
      const response = await fetch('/api/kubernetes/failure-test/stop-service', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ serviceId: service.serviceId }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Outage request failed (${response.status})`);
      setOutagePending(true); setOutageStartedAt(Date.now());
      setOutageMessage(`${service.service} outage initiated. Agents will recover it through the sequential queue.`);
    } catch (reason) { setOutagePending(false); setOutageMessage(reason instanceof Error ? reason.message : 'Outage request failed'); }
    finally { setOutageBusy(false); }
  };

  const monitoredServiceCard = <section className="panel kube-monitored-service-card"><div className="panel-head"><div><span className="eyebrow">MONITORED SERVICE</span><h3>Independent Test Service</h3></div><span className={`kube-status-badge ${testService?.api === 'REACHABLE' ? 'healthy' : 'down'}`}>{testService?.api ?? 'UNKNOWN'}</span></div><div className="kube-service-grid"><div><span>Container</span><strong>{testService?.container ?? 'UNKNOWN'}</strong></div><div><span>API</span><strong>{testService?.statusCode ?? 'N/A'} · {testService?.latencyMs ?? 'N/A'}ms</strong></div><div><span>Agent monitoring</span><strong>{topology?.pods.length ?? 0} Agent Pods</strong></div><div><span>Recovery mode</span><strong>{agentStatus?.mode.mode ?? 'UNKNOWN'}</strong></div><div><span>Last health check</span><strong>{testService ? new Date(testService.checkedAt).toLocaleTimeString() : 'N/A'}</strong></div><div><span>Endpoint</span><strong>{testService?.target ?? 'http://localhost:8080'}</strong></div></div>{testService?.error && <p className="kube-service-error">{testService.error}</p>}<div className="kube-service-actions"><button className="danger" disabled={outageBusy || agentStatus?.mode.mode !== 'KUBERNETES' || !agentStatus?.policy.enabled} onClick={() => void performOutage()}>{outageBusy ? 'Starting outage…' : 'Perform Outage'}</button><span className="muted">Stops only the explicitly allowlisted development container; Agents perform recovery.</span></div>{outageMessage && <p className="kube-service-error">{outageMessage}</p>}</section>;
  const compactRegisteredServiceCard = <section className="panel kube-monitored-service-card"><div className="panel-head"><div><span className="eyebrow">MONITORED SERVICES</span><h3>Registered external services</h3></div><span className="kube-status-badge healthy">{serviceStatuses.length} SERVICES</span></div><div className="kube-registered-services compact-service-list">{serviceStatuses.length ? serviceStatuses.map((service) => <article className="kube-registered-service" key={service.serviceId}><div><strong>{service.service}</strong><small>{service.container} · {service.containerState}</small></div><span className={`kube-status-badge ${service.api === 'REACHABLE' ? 'healthy' : 'down'}`}>{service.api}</span><button className="danger" disabled={outageBusy || agentStatus?.mode.mode !== 'KUBERNETES' || !agentStatus?.policy.enabled || !service.authorizedRecovery} onClick={() => void performServiceOutage(service)}>{outageBusy ? 'Starting…' : 'Perform Outage'}</button></article>) : <p className="muted">No registered services configured.</p>}</div>{outageMessage && <p className="kube-service-error">{outageMessage}</p>}</section>;
  const registeredServiceCard = <section className="panel kube-monitored-service-card"><div className="panel-head"><div><span className="eyebrow">MONITORED SERVICES</span><h3>Registered external services</h3></div><span className="kube-status-badge healthy">{serviceStatuses.length} SERVICES</span></div><div className="kube-registered-services">{serviceStatuses.length ? serviceStatuses.map((service) => <article className="kube-registered-service" key={service.serviceId}><div className="panel-head"><div><strong>{service.service}</strong><small>{service.container} · {service.containerState}</small></div><span className={`kube-status-badge ${service.api === 'REACHABLE' ? 'healthy' : 'down'}`}>{service.api}</span></div><div className="kube-service-grid"><div><span>API</span><strong>{service.statusCode ?? 'N/A'}</strong></div><div><span>Endpoint</span><strong>{service.endpoint ?? 'N/A'}</strong></div><div><span>Agent monitoring</span><strong>{service.monitoringEnabled ? 'ENABLED' : 'DISABLED'}</strong></div><div><span>Recovery</span><strong>{service.autoRecoveryEnabled && service.authorizedRecovery ? service.recoveryStatus ?? 'AUTHORIZED' : 'NOT AUTHORIZED'}</strong></div></div>{service.error && <p className="kube-service-error">{service.error}</p>}</article>) : <p className="muted">No registered services configured.</p>}</div><div className="kube-service-actions"><button className="danger" disabled={outageBusy || agentStatus?.mode.mode !== 'KUBERNETES' || !agentStatus?.policy.enabled} onClick={() => void performOutage()}>{outageBusy ? 'Starting outage…' : 'Perform Outage — all registered services'}</button><span className="muted">Stops registered authorized targets only; Agents recover them one at a time by priority and queue order.</span></div>{outageMessage && <p className="kube-service-error">{outageMessage}</p>}</section>;
  const serviceFlow = <section className="panel kube-service-flow"><div className="panel-head"><div><span className="eyebrow">EXTERNAL SERVICES / RECOVERY BRANCH</span><h3>Agent to registered service</h3></div><span className="muted">Sequential queue · concurrency 1</span></div><div className="kube-service-flow-grid">{serviceStatuses.map((service) => <div className={`kube-service-flow-item ${service.recoveryStatus === 'RECOVERING' || service.recoveryStatus === 'VERIFYING' ? 'active' : service.api === 'REACHABLE' ? 'healthy' : 'unreachable'}`} key={service.serviceId}><strong>AGENTS</strong><span>↓</span><b>{service.service}</b><small>Docker · {service.api}</small><small>{service.container} · {service.recoveryStatus ?? (service.authorizedRecovery ? 'AUTHORIZED RECOVERY READY' : 'MONITORING ONLY')}</small></div>)}</div></section>;

   if (discoveryLoading) return <section className="kubernetes-recovery"><div className="panel kube-discovery-state">Checking Kubernetes cluster status…</div></section>;
   if (discoveryError) return <section className="kubernetes-recovery"><div className="panel kube-discovery-state"><p className="kube-service-error">{discoveryError}</p><button className="primary" type="button" onClick={() => void loadDiscovery()}>Retry</button></div></section>;

   return <section className={`kubernetes-recovery ${screen === 'setup' ? 'setup-view' : 'console-view'}`}>
      <div className="kubernetes-page-header"><div><span className="eyebrow">KUBERNETES OPERATIONS</span><h2>{screen === 'setup' ? 'Cluster Setup' : 'Recovery Console'}</h2><p>{screen === 'setup' ? 'Configure the isolated kind cluster and SentinelOps Agent Pods.' : 'Interactive recovery console for the isolated Kubernetes environment.'}</p></div><div className="kubernetes-page-actions">{screen === 'console' && <button className="shutdown-button" type="button" onClick={() => void shutdownCluster()} title="Shutdown and delete this Kubernetes cluster" aria-label="Shutdown and delete cluster">⏻</button>}<span className={`kube-connection ${error ? 'error' : 'ready'}`}><i /> {error ? 'STATUS UNAVAILABLE' : 'TERMINAL READY'}</span></div></div>
     {screen === 'console' && setupMessage && <p className="kube-service-error">{setupMessage}</p>}
      {screen === 'console' && discovery.state === 'ready' && (!discovery.namespaceExists || discovery.agentPods === 0) && <p className="kube-service-error">Agent setup warning: {!discovery.namespaceExists && 'the namespace is not deployed. '}{discovery.agentPods === 0 && 'No Agent Pods are running.'} Use the shutdown control to return to setup.</p>}
     {screen === 'console' && compactRegisteredServiceCard}
      {screen === 'setup' && <section className="panel kube-setup-card"><div className="panel-head"><div><span className="eyebrow">CLUSTER SETUP</span><h3>Create or inspect the kind cluster</h3></div><span className="muted">Each button runs one real operation</span></div><div className="kube-setup-fields"><label>Cluster name<input value={clusterName} onChange={(event) => setClusterName(event.target.value)} /></label><label>Worker nodes<input type="number" min="0" max="10" value={workerNodes} onChange={(event) => setWorkerNodes(Number(event.target.value))} /></label><label>Agent Pods<input type="number" min="1" max="20" value={agentPods} onChange={(event) => setAgentPods(Number(event.target.value))} /></label><label>Namespace<input value={namespace} onChange={(event) => setNamespace(event.target.value)} /></label></div><p className="muted">1 control-plane + {workerNodes} workers = {workerNodes + 1} total nodes.</p><div className="kube-setup-buttons"><button className="primary" disabled={!!setupBusy} onClick={() => void runSetup('create-cluster')}>Create Cluster</button><button disabled={!!setupBusy} onClick={() => void runSetup('check-cluster')}>Check Cluster</button><button disabled={!!setupBusy} onClick={() => void runSetup('create-namespace')}>Create Namespace</button><button disabled={!!setupBusy} onClick={() => void runSetup('deploy-agent')}>Deploy Agent Pods</button><button type="button" onClick={goToConsole}>Go to Console</button></div>{discovery.state === 'ready' && (!discovery.namespaceExists || discovery.agentPods === 0) && <p className="kube-service-error">Missing prerequisites: {!discovery.namespaceExists && 'namespace is not deployed. '}{discovery.agentPods === 0 && 'No Agent Pods are running.'}</p>}{setupBusy && <p className="kube-setup-running">Running {setupBusy.replaceAll('-', ' ')}… output is also streamed in the terminal.</p>}{setupMessage && <p className="kube-service-error">{setupMessage}</p>}{setupOutput && <pre className="kube-setup-output">{setupOutput}</pre>}</section>}
    <section className="panel kube-agent-topology"><div className="panel-head"><div><span className="eyebrow">READ-ONLY LIVE TOPOLOGY</span><h3>Kubernetes Agent Topology</h3></div><span className="muted">{topology ? `Observed ${new Date(topology.observedAt).toLocaleTimeString()}` : 'Waiting for Kubernetes'}</span></div>{topologyError ? <p className="kube-service-error">{topologyError}</p> : topology ? <><div className="kube-topology-flow"><div className="kube-topology-cluster"><strong>KUBERNETES CLUSTER</strong><small>{topology.context} · {topology.namespace}</small><div className="kube-topology-branch">↓</div><div className="kube-topology-nodes">{topology.nodes.map((node) => { const name = String(node.metadata?.name ?? 'unknown'); const controlPlane = Boolean(node.metadata?.labels?.['node-role.kubernetes.io/control-plane'] || node.metadata?.labels?.['node-role.kubernetes.io/master']); const pods = topology.pods.filter((pod) => pod.spec?.nodeName === name); const ready = node.status?.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True'); return <div className={`kube-topology-node ${ready ? 'ready' : 'not-ready'}`} key={name}><strong>{name}</strong><small>{controlPlane ? 'CONTROL PLANE' : 'WORKER'} · {ready ? 'READY' : 'NOT READY'}</small><div className="kube-topology-branch">↓</div><div className="kube-topology-pods">{pods.length ? pods.map((pod) => { const view = podView(pod); return <span key={pod.metadata?.name} className={`kube-topology-pod agent-${view.state.toLowerCase()}`}><b>{view.label}</b><strong>{String(pod.metadata?.name)}</strong><small>{String(pod.status?.phase ?? 'UNKNOWN')} · {view.state} · {pod.status?.containerStatuses?.every((container: any) => container.ready) ? 'READY' : 'NOT READY'}</small></span>; }) : <em>No Agent Pods assigned</em>}</div></div>; })}</div></div><div className="kube-topology-external"><strong>EXTERNAL TEST SERVICE</strong><small>Docker · {testService?.api ?? 'UNKNOWN'}</small><span>Monitoring and authorized recovery communication</span></div></div><div className="kube-recovery-log"><div className="kube-recovery-log-head"><span className="eyebrow">LIVE RECOVERY LOG</span><span className="muted">Persisted Agent events</span></div>{recoveryLog.length ? recoveryLog.slice(0, 12).map((event) => <div className={`kube-recovery-log-row event-${String(event.event_type).replaceAll('.', '-')}`} key={`${event.id}-${event.incident_id ?? ''}`}><time>{new Date(event.occurred_at).toLocaleTimeString()}</time><span>{event.text}</span></div>) : <p className="muted">No recovery events observed.</p>}</div></> : <p className="muted">Loading actual Kubernetes nodes and Agent Pods…</p>}</section>
     {screen === 'console' && serviceFlow}
     <section id="kubernetes-console" className="kube-terminal panel"><div className="kube-terminal-head"><div><span className="eyebrow">LIVE SHELL</span><h3>SentinelOops Kubernetes terminal</h3></div><span className="muted">bash · /workspace · persistent session</span></div><KubernetesTerminal /><p className="kube-terminal-note">Commands run inside the dedicated <code>kubernetes-terminal</code> container. Docker Engine access is disabled unless explicitly configured.</p></section>
    <section className="panel kube-service-status"><div className="panel-head"><div><span className="eyebrow">TEST SERVICE STATUS</span><h3>Independent Test Service</h3></div><span className={`kube-status-badge ${testService?.api === 'REACHABLE' ? 'healthy' : 'down'}`}>{testService?.api ?? 'UNKNOWN'}</span></div><div className="kube-service-grid"><div><span>Container</span><strong>{testService?.container ?? 'UNKNOWN'}</strong></div><div><span>API</span><strong>{testService?.statusCode ?? 'N/A'} · {testService?.latencyMs ?? 'N/A'}ms</strong></div><div><span>Last health check</span><strong>{testService ? new Date(testService.checkedAt).toLocaleTimeString() : 'N/A'}</strong></div><div><span>Endpoint</span><strong>{testService?.target ?? 'http://localhost:8080'}</strong></div></div>{testService?.error && <p className="kube-service-error">{testService.error}</p>}</section>
    <section className="panel kube-observe-recovery"><div className="panel-head"><div><span className="eyebrow">OBSERVE &amp; RECOVERY</span><h3>Agent recovery status</h3></div><span className={`kube-status-badge ${agentStatus?.policy.enabled ? 'healthy' : 'down'}`}>{agentStatus?.policy.enabled ? 'ENABLED' : 'DISABLED'}</span></div><div className="kube-service-grid"><div><span>Mode</span><strong>{agentStatus?.mode.mode ?? 'UNKNOWN'}</strong></div><div><span>Agent Pods</span><strong>{topology?.pods.length ?? 0}</strong></div><div><span>Active incidents</span><strong>{agentStatus?.incidents.filter((incident) => ['ACTIVE', 'RECOVERING'].includes(String(incident.status))).length ?? 0}</strong></div><div><span>Recovered incidents</span><strong>{agentStatus?.incidents.filter((incident) => incident.status === 'RECOVERED').length ?? 0}</strong></div></div><p className="muted">Agents observe the Test Service, detect consecutive health failures, acquire recovery ownership, and request authorized container recovery through SentinelOops.</p></section>
  </section>;
}
