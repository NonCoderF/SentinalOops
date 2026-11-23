import WebSocket from 'ws';

export type KubernetesSetupOperation = 'create-cluster' | 'check-cluster' | 'cluster-status' | 'topology' | 'create-namespace' | 'deploy-agent' | 'check-agent-pods' | 'agent-logs' | 'delete-agent-pod' | 'scale-agents-zero' | 'delete-cluster' | 'inspect-node' | 'stop-worker' | 'start-worker';
export type SetupOptions = { operation: KubernetesSetupOperation; clusterName: string; context: string; namespace: string; workerNodes?: number; agentPods?: number; podName?: string; nodeName?: string; terminalUrl: string; terminalToken: string; onOutput?: (chunk: string) => void };

const manifestMarker = '__SENTINELOOPS_SETUP_MANIFEST_REQUIRED__';
const completionMarker = '__SENTINELOOPS_SETUP_DONE__:';

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const contextFor = (clusterName: string) => `kind-${clusterName}`;

function agentManifest(namespace: string, replicas: number): string {
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: sentinelops-agent
  namespace: ${namespace}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinelops-agent
  namespace: ${namespace}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: sentinelops-agent
  template:
    metadata:
      labels:
        app: sentinelops-agent
    spec:
      serviceAccountName: sentinelops-agent
      containers:
        - name: agent
          image: sentinelops/kubernetes-agent:local
          imagePullPolicy: IfNotPresent
          env:
            - name: SENTINELOOPS_BACKEND_URL
              value: http://sentinelops:8081
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 3
            periodSeconds: 15
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 128Mi
`;
}

function buildCommand(options: SetupOptions): { command: string; manifest?: string } {
  const c = quote(options.context);
  const n = quote(options.namespace);
  const cluster = quote(options.clusterName);
  const workerNodes = options.workerNodes ?? 0;
  const pods = options.agentPods ?? 1;
  const prepare = `docker network connect kind "$(hostname)" 2>/dev/null || true; backend=$(docker ps --filter label=com.docker.compose.service=sentinelops --format '{{.Names}}' | head -1); if [ -n "$backend" ]; then docker network connect --alias sentinelops kind "$backend" 2>/dev/null || true; fi; export KUBECONFIG=/home/terminal/.kube/config; kind export kubeconfig --name ${cluster} --kubeconfig /home/terminal/.kube/config >/dev/null 2>&1; kubectl config set-cluster ${c} --server=https://${options.clusterName}-control-plane:6443 >/dev/null 2>&1`;
  const kube = `kubectl --context ${c}`;
  const signal = (value: string) => `$(printf '%s' '${Buffer.from(value, 'utf8').toString('base64')}' | base64 -d)`;
  const manifestSignal = signal(manifestMarker);
  const completionSignal = signal(completionMarker);
  switch (options.operation) {
    case 'create-cluster': {
      const config = [`kind: Cluster`, `apiVersion: kind.x-k8s.io/v1alpha4`, `nodes:`, `  - role: control-plane`, ...Array.from({ length: workerNodes }, () => `  - role: worker`), ``].join('\n');
      const encoded = Buffer.from(config, 'utf8').toString('base64');
      return { command: `printf '%s' '${encoded}' | base64 -d > /tmp/sentinelops-kind.yaml; if kind get clusters 2>/dev/null | grep -Fxq ${cluster}; then printf '\nCluster already exists: ${options.clusterName}. No changes made.\n'; code=3; else kind create cluster --name ${cluster} --config /tmp/sentinelops-kind.yaml; code=$?; fi; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    }
    case 'check-cluster': return { command: `kind get clusters; ${prepare}; ${kube} get nodes -o wide; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'cluster-status': return { command: `if kind get clusters 2>/dev/null | grep -Fxq ${cluster}; then ${prepare}; ${kube} get nodes >/dev/null 2>&1; node_code=$?; if [ "$node_code" -eq 0 ]; then state=READY; else state=UNREACHABLE; fi; ${kube} get namespace ${n} >/dev/null 2>&1; namespace_code=$?; if [ "$namespace_code" -eq 0 ]; then namespace_state=PRESENT; agent_count=$(${kube} -n ${n} get pods -l app=sentinelops-agent --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l); else namespace_state=MISSING; agent_count=0; fi; else state=ABSENT; namespace_state=MISSING; agent_count=0; node_code=0; fi; printf '\n__SENTINELOOPS_CLUSTER_STATE__:%s\n__SENTINELOOPS_NAMESPACE_STATE__:%s\n__SENTINELOOPS_AGENT_COUNT__:%s\n%s%s\n' "$state" "$namespace_state" "$agent_count" "${completionSignal}" "$node_code"` };
    case 'topology': return { command: `${prepare}; printf '\n__SENTINELOOPS_NODES_JSON__\n'; ${kube} get nodes -o json; nodes_code=$?; printf '\n__SENTINELOOPS_PODS_JSON__\n'; ${kube} -n ${n} get pods -l app=sentinelops-agent -o json; pods_code=$?; code=$nodes_code; if [ "$pods_code" -ne 0 ]; then code=$pods_code; fi; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'create-namespace': return { command: `${prepare}; ${kube} create namespace ${n} --dry-run=client -o yaml | ${kube} apply -f -; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'deploy-agent': {
      const manifest = agentManifest(options.namespace, pods);
      const encoded = Buffer.from(manifest, 'utf8').toString('base64');
      return { command: `${prepare}; ${kube} get namespace ${n} >/dev/null 2>&1; code=$?; if [ "$code" -eq 0 ]; then kind load docker-image sentinelops/kubernetes-agent:local --name ${cluster}; code=$?; fi; if [ "$code" -eq 0 ]; then printf '%s' '${encoded}' | base64 -d | ${kube} apply -f -; code=$?; fi; if [ "$code" -eq 0 ]; then ${kube} -n ${n} rollout status deployment/sentinelops-agent --timeout=120s; code=$?; fi; printf '\n%s%s\n' "${completionSignal}" "$code"`, manifest: encoded };
    }
    case 'check-agent-pods': return { command: `${prepare}; ${kube} -n ${n} get deployment sentinelops-agent -o wide; ${kube} -n ${n} get pods -l app=sentinelops-agent -o wide; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'agent-logs': return { command: `${prepare}; ${kube} -n ${n} logs ${quote(options.podName ?? '')} --tail=500; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'delete-agent-pod': return { command: `${prepare}; ${kube} -n ${n} delete pod ${quote(options.podName ?? '')}; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'scale-agents-zero': return { command: `${prepare}; ${kube} -n ${n} scale deployment/sentinelops-agent --replicas=0; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'delete-cluster': return { command: `kind delete cluster --name ${cluster}; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'inspect-node': return { command: `${prepare}; ${kube} get node ${quote(options.nodeName ?? '')} -o wide; code=$?; printf '\n%s%s\n' "${completionSignal}" "$code"` };
    case 'stop-worker':
    case 'start-worker': {
      const action = options.operation === 'stop-worker' ? 'stop' : 'start';
      const node = quote(options.nodeName ?? '');
      return { command: `role=$(docker inspect -f '{{index .Config.Labels "io.x-k8s.kind.role"}}' ${node} 2>/dev/null); cluster=$(docker inspect -f '{{index .Config.Labels "io.x-k8s.kind.cluster"}}' ${node} 2>/dev/null); if [ "$role" != "worker" ] || [ "$cluster" != ${cluster} ]; then printf '\nWorker operation blocked: target is not an allowlisted kind worker.\n'; code=2; else docker ${action} ${node}; code=$?; fi; printf '\n%s%s\n' "${completionSignal}" "$code"` };
  }
}

}

export function runKubernetesSetup(options: SetupOptions): Promise<{ output: string; exitCode: number }> {
  const built = buildCommand(options);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(options.terminalUrl, { headers: { Authorization: `Bearer ${options.terminalToken}` } });
    let output = '';
    let settled = false;
    let manifestSent = false;
    const timeout = setTimeout(() => finishReject(new Error('Kubernetes setup operation timed out')), 180_000);
    const sendInput = (data: string): Promise<void> => new Promise((resolve) => {
      let offset = 0;
      const sendChunk = () => {
        if (settled || offset >= data.length) { resolve(); return; }
        const next = data.slice(offset, offset + 96);
        offset += next.length;
        socket.send(JSON.stringify({ type: 'input', data: next }));
        setTimeout(sendChunk, 8);
      };
      sendChunk();
    });
    const finishReject = (error: Error) => { if (settled) return; settled = true; clearTimeout(timeout); socket.close(); reject(error); };
    const finish = (exitCode: number) => { if (settled) return; settled = true; clearTimeout(timeout); socket.close(); resolve({ output, exitCode }); };
    socket.once('open', () => {
      // Setup scripts run through the terminal service's non-interactive
      // executor. This preserves real streaming output without relying on
      // bash line-editing, which can corrupt long pasted commands in a PTY.
      socket.send(JSON.stringify({ type: 'exec', command: built.command }));
    });
    socket.on('message', (data) => {
      const chunk = data.toString(); output += chunk; options.onOutput?.(chunk);
      try {
        const message = JSON.parse(chunk) as { type?: string; code?: number };
        if (message.type === 'exec-exit') { finish(Number.isInteger(message.code) ? Number(message.code) : 1); return; }
      } catch { /* command output is plain text */ }
      // The PTY echoes the command before executing it. The command itself
      // contains these markers, so always react to the last occurrence: the
      // final occurrence is the marker emitted by the running shell.
      if (built.manifest && !manifestSent && output.lastIndexOf(manifestMarker) > 0) { manifestSent = true; void sendInput(`${built.manifest}\n\u0004`); }
      const marker = output.lastIndexOf(completionMarker); if (marker < 0) return;
      const code = output.slice(marker + completionMarker.length).match(/^(\d+)/)?.[1]; if (code !== undefined) finish(Number(code));
    });
    socket.once('error', (error) => finishReject(new Error(`Trusted terminal unavailable: ${error.message}`)));
    socket.once('close', () => { if (!settled) finishReject(new Error('Trusted terminal disconnected before operation completed')); });
  });
}
