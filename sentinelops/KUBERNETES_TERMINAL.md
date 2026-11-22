# Kubernetes terminal

The Kubernetes Recovery terminal is a real bash PTY in the `kubernetes-terminal`
Compose service. It is not a simulated command prompt. The browser connects to
it through the authenticated SentinelOops WebSocket gateway.

## Normal terminal

```powershell
docker compose -f install/docker-compose.yml up -d --build kubernetes-terminal sentinelops
```

The terminal has a persistent `/workspace` volume and includes bash, curl, git,
kubectl, Helm, kind, and the Docker CLI. Docker Engine access is intentionally
disabled in this mode.

## Explicit Docker Engine access

Docker socket access grants host-level Docker control. Enable it only for an
isolated local administrator session:

```powershell
docker compose `
  -f install/docker-compose.yml `
  -f install/docker-compose.kubernetes-terminal-docker.yml `
  up -d --build kubernetes-terminal sentinelops
```

The override mounts only `/var/run/docker.sock`, sets
`DOCKER_HOST=unix:///var/run/docker.sock`, and starts the shell as the
non-root `terminal` user after matching the socket group. It does not expose a
Docker TCP port and does not use `chmod 666`.

## Kubernetes access

Kubernetes credentials are not mounted by the base Compose file. To opt into a
dedicated kubeconfig, copy the example override and set `KUBECONFIG_PATH` to a
least-privilege kubeconfig file. The override attaches the terminal to the
existing `kind` Docker network so the kubeconfig's kind API hostname remains
resolvable. TLS and certificate verification remain controlled by kubeconfig;
the terminal does not enable `insecure-skip-tls-verify`.

```powershell
$env:KUBECONFIG_PATH = 'C:\path\to\dedicated\kind-sentinelops-dev.kubeconfig'
docker compose `
  -f install/docker-compose.yml `
  -f install/docker-compose.kubernetes-terminal-kubeconfig.example.yml `
  up -d --build kubernetes-terminal sentinelops
```

The base terminal remains usable for normal Linux commands even without this
optional kubeconfig. No cluster is created, deleted, or modified by startup.

## Reaching the host-published Test Service

Inside the Linux terminal container, `127.0.0.1` and `localhost` refer to the
terminal container, not Windows. To reach the Test Service published on host
port 8080, use Docker Desktop's host gateway:

```bash
curl -i http://host.docker.internal:8080/api/health
```

The Compose service explicitly maps `host.docker.internal` to the host gateway.
This keeps the route explicit and prevents a local container from masking which
runtime owns the Test Service.

The terminal also provides a container-local loopback proxy, so this works from
inside the shell without changing the host's port ownership:

```bash
curl -i http://127.0.0.1:8080/api/health
```

The actual Test Service health route is `/api/health`; `/health` is not a
configured route in the current Test Service.
