import WebSocket from 'ws';

const completionMarker = '__SENTINELOOPS_AGENT_DEPLOY_DONE__:';
const manifestMarker = '__SENTINELOOPS_AGENT_MANIFEST_REQUIRED__';
const kindConfig = `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
`;

const agentManifest = `apiVersion: v1
kind: Namespace
metadata:
  name: sentinelops-agent
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sentinelops-agent
  namespace: sentinelops-agent
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinelops-agent
  namespace: sentinelops-agent
spec:
  replicas: 1
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
              value: http://host.docker.internal:3005
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

export type AgentDeployResult = { output: string; exitCode: number };

export function deployAgentThroughTerminal(options: { context: string; clusterName: string; terminalUrl: string; terminalToken: string; onOutput?: (chunk: string) => void }): Promise<AgentDeployResult> {
  const encodedManifest = Buffer.from(agentManifest, 'utf8').toString('base64');
  const encodedKindConfig = Buffer.from(kindConfig, 'utf8').toString('base64');
  const command = `set +e; printf '%s' '${encodedKindConfig}' | base64 -d > /tmp/sentinelops-kind.yaml; kind get clusters 2>/dev/null | grep -Fxq '${options.clusterName}'; cluster_code=$?; if [ "$cluster_code" -ne 0 ]; then printf '\\nNo ${options.clusterName} cluster found. Creating the development kind cluster...\\n'; kind create cluster --name '${options.clusterName}' --config /tmp/sentinelops-kind.yaml; cluster_code=$?; fi; if [ "$cluster_code" -eq 0 ]; then docker network connect kind "$(hostname)" 2>/dev/null || true; kind export kubeconfig --name '${options.clusterName}' --kubeconfig /home/terminal/.kube/config; cluster_code=$?; fi; if [ "$cluster_code" -eq 0 ]; then export KUBECONFIG=/home/terminal/.kube/config; kubectl --context '${options.context}' cluster-info; cluster_code=$?; fi; if [ "$cluster_code" -eq 0 ]; then kubectl --context '${options.context}' create namespace sentinelops-agent --dry-run=client -o yaml | kubectl --context '${options.context}' apply -f -; cluster_code=$?; fi; if [ "$cluster_code" -eq 0 ]; then kind load docker-image sentinelops/kubernetes-agent:local --name '${options.clusterName}'; cluster_code=$?; fi; if [ "$cluster_code" -eq 0 ]; then stty -echo; printf '\\n${manifestMarker}\\n'; base64 -d | kubectl --context '${options.context}' apply -f -; cluster_code=$?; stty echo; fi; if [ "$cluster_code" -eq 0 ]; then kubectl --context '${options.context}' wait --for=condition=available deployment/sentinelops-agent -n sentinelops-agent --timeout=60s; cluster_code=$?; fi; code=$cluster_code; printf '\\n${completionMarker}%s\\n' "$code"`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(options.terminalUrl, { headers: { Authorization: `Bearer ${options.terminalToken}` } });
    let output = '';
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      reject(error);
    };
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve({ output, exitCode });
    };
    const timeout = setTimeout(() => finishReject(new Error('Agent bootstrap timed out in the trusted terminal')), 180_000);
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'input', data: `${command}\n` }));
    });
    socket.on('message', (data) => {
      const chunk = data.toString();
      output += chunk;
      options.onOutput?.(chunk);
      if (output.includes(manifestMarker) && !output.includes(`${manifestMarker}_SENT`)) {
        output += `${manifestMarker}_SENT`;
        socket.send(JSON.stringify({ type: 'input', data: `${encodedManifest}\n\u0004` }));
      }
      const markerIndex = output.indexOf(completionMarker);
      if (markerIndex < 0) return;
      const code = output.slice(markerIndex + completionMarker.length).match(/^(\d+)/)?.[1];
      if (code !== undefined) finish(Number(code));
    });
    socket.once('error', (error) => finishReject(new Error(`Trusted terminal unavailable: ${error.message}`)));
    socket.once('close', () => { if (!settled) finishReject(new Error('Trusted terminal disconnected before deployment completed')); });
  });
}
