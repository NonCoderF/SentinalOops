# Kubernetes Agent recovery (Phase 1)

The Agent is a single, lightweight Pod that monitors the already registered
Test Service endpoints. It never receives Docker access and cannot execute
commands. Recovery requests are validated by SentinelOops;
the existing recovery-controller is the only Docker control boundary.

## Enable the backend boundary

Set these values in the Compose environment before starting the recovery
profile:

```powershell
$env:RECOVERY_ALLOWED_SERVICE = 'test-service'
$env:RECOVERY_ALLOWED_IMAGE = 'sentinelops/test-service:local'
docker compose -f install/docker-compose.yml --profile recovery up -d --build sentinelops recovery-controller
```

Automatic recovery also requires an enabled `AUTOMATIC` runbook for the
`test-service` service and Kubernetes Recovery to be the active mode. The
dashboard policy switch is disabled by default and must be explicitly enabled.

## Build and load the Agent for kind

```powershell
docker build -f sentinelops/kubernetes-agent/Dockerfile `
  -t sentinelops/kubernetes-agent:local sentinelops/kubernetes-agent
kind load docker-image sentinelops/kubernetes-agent:local --name sentinelops-dev
kubectl create namespace sentinelops-agent --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f sentinelops/kubernetes-agent/k8s/agent.yaml
```

The Compose backend uses `host.docker.internal` to translate registered
`localhost` probe URLs for the Agent. The manifest uses
`http://host.docker.internal:3005` for the local Docker
Desktop path. Verify that the Agent Pod can resolve and reach that address.
Set `SENTINELOPS_BACKEND_URL` in the ConfigMap to a reachable backend address
for other environments. Configure monitored endpoint `probeUrl` values to a
URL reachable from the Pod, such as
`http://host.docker.internal:8080/api/health`; a Pod's `localhost` is the Pod,
not the Windows host.

## Safety and verification

The Agent has no Docker socket, Kubernetes RBAC permissions, or terminal
credentials. Its readiness reports configuration/bootstrap state, not the
external Test Service health, so the monitor remains alive during an outage.
Do not stop a live container for the demonstration without explicit approval.
When approved, inspect the Agent and backend events while using the existing
Docker recovery controller to stop/start only the configured Test Service.
