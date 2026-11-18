# SentinelOops

## Independent components

- `test-service/` is an optional demo API on port 8080. It is never installed by SentinelOps.
- `sentinelops/` contains the monitoring product.
- `install/` deploys SentinelOps, Prometheus, Grafana, and Blackbox Exporter with persistent named volumes.

## Clean installation and verification

```bash
docker compose -f test-service/docker-compose.yml up -d --build
curl http://localhost:8080/api/health
curl http://localhost:8080/api/users
curl http://localhost:8080/api/products
curl http://localhost:8080/metrics

chmod +x install/install.sh
./install/install.sh
```

Open `http://localhost:3005/setup` and register the demo endpoints through the wizard. The installer does not register or assume them. To scrape real demo metrics, set `PROMETHEUS_METRICS_TARGET=host.docker.internal:8080` and `PROMETHEUS_METRICS_APPLICATION=demo-service` in `install/.env` before installation. Docker Desktop on Windows/macOS supports `host.docker.internal`; Linux users can use the installer host-gateway mapping or a reachable Docker-network DNS name. Remote targets must be explicitly authorized.

PowerShell:

```powershell
docker compose -f test-service/docker-compose.yml up -d --build
docker compose --env-file install/.env -f install/docker-compose.yml up -d --build
Start-Process http://localhost:3005/setup
```

## Observe. Detect. Recover.

SentinelOops is a local-first infrastructure monitoring and incident-response project. It combines a Node.js test service, Prometheus metrics and alert rules, Grafana dashboards, a custom Alert Manager, and a restricted recovery controller into a reproducible Docker Compose workflow.

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111827)](https://react.dev/)
[![Prometheus](https://img.shields.io/badge/Prometheus-2.55-E6522C?logo=prometheus&logoColor=white)](https://prometheus.io/)
[![Grafana](https://img.shields.io/badge/Grafana-11-F46800?logo=grafana&logoColor=white)](https://grafana.com/)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-supported-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

Repository: [github.com/jimmy007bond/SentinelOops](https://github.com/jimmy007bond/SentinelOops)

## Overview

SentinelOops makes the complete failure loop visible in a small, reproducible environment:

1. The test service exposes health and Prometheus metrics.
2. Prometheus scrapes the service every two seconds and evaluates alert rules.
3. Alert Manager polls Prometheus, records firing and resolved incidents, and exposes a live dashboard.
4. Optional SMTP notifications are queued and recorded in SQLite.
5. Approved recovery runbooks can call a private, allowlisted recovery controller.

The project is intended for local development, observability demonstrations, and engineering portfolio review. It is not presented as a production deployment blueprint.

## Demo

No checked-in video or screenshot assets were found in the repository. These are clearly labeled placeholders rather than fabricated media.

- Demo video: Not included; add a real recording link here.
- Dashboard screenshot: Not included; add an image under docs/assets when available.
- Incident detection screenshot: Not included; add an image under docs/assets when available.
- Recovery screenshot: Not included; add an image under docs/assets when available.

## Key Features

- Real service health monitoring through /health and Prometheus /metrics.
- Two-second Prometheus scraping and evaluation intervals.
- Grafana dashboard provisioned with availability, CPU, memory, request-rate, and latency panels.
- Alert Manager incident polling with FIRING and RESOLVED lifecycle detection.
- SQLite-backed incident, notification, job, and recovery execution state.
- SMTP configuration through the dashboard, with encrypted saved settings and Nodemailer delivery.
- Server-Sent Events plus polling for live dashboard updates.
- Structured recovery runbooks with manual execution and optional automatic mode.
- Private recovery controller restricted to the Compose test-service container and approved actions.
- Recovery verification through the service health endpoint and persisted execution history.

## Architecture

~~~mermaid
flowchart LR
    B[Browser]
    T[test-service<br/>Node.js / TypeScript]
    P[Prometheus<br/>2s scrape + rules]
    G[Grafana<br/>provisioned dashboard]
    A[Alert Manager<br/>Fastify + React + SQLite]
    R[Recovery Controller<br/>private internal API]
    D[Docker Engine API]
    S[SMTP server]
    V1[(Prometheus volume)]
    V2[(Grafana volume)]
    V3[(SentinelOps SQLite volume)]

    T -- /metrics --> P
    T -- /health --> A
    P -- query API --> A
    P -- PromQL --> G
    A -- SSE / polling --> B
    B -- dashboard and settings --> A
    A -- queued email --> S
    A -- restricted recovery request --> R
    R -- start/restart/status --> D
    R -- health verification --> T
    P --- V1
    G --- V2
    A --- V3
~~~

The production installation is defined by `install/docker-compose.yml` and deploys SentinelOps, Prometheus, Grafana, and Blackbox Exporter. The optional demo service is defined separately in `test-service/docker-compose.yml`.

## Technology Stack

| Area | Verified technologies |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, TypeScript, Fastify |
| Persistence | SQLite, better-sqlite3, WAL mode |
| Email | Nodemailer, configurable SMTP |
| Observability | Prometheus, PromQL, Grafana |
| Recovery | Dedicated Node.js controller, Docker Engine API |
| Infrastructure | Docker, Docker Compose, named volumes |
| Validation | Node test runner, TypeScript builds, promtool |

### Stack Summary

- Frontend: React, TypeScript, and Vite.
- Backend: Node.js, TypeScript, and Fastify.
- Persistence: SQLite with better-sqlite3 and WAL mode.
- Email: Nodemailer with configurable SMTP delivery.
- Monitoring: Prometheus and PromQL.
- Dashboards: Grafana.
- Recovery: Node.js recovery controller using the Docker Engine API.
- Infrastructure: Docker, Docker Compose, and persistent named volumes.
- Validation: Node.js test runner, TypeScript builds, and Prometheus promtool.

The current active Compose stack does not require PostgreSQL, Kafka, Kubernetes, or an active Alertmanager container.

## Getting Started

### Prerequisites

- Docker Desktop with Docker Compose v2.
- Node.js 22 and npm for local repository checks.
- An SMTP account or app password if email notifications are required.

### Clone and configure

~~~powershell
git clone https://github.com/jimmy007bond/SentinelOops.git
cd SentinelOops
Copy-Item .env.example .env
~~~

Review .env before starting. Use development-only values and never commit the file:

~~~dotenv
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=change-this-locally
RECOVERY_CONTROLLER_TOKEN=replace-with-a-long-random-token
SENTINELOPS_AUTH_ENABLED=false
SENTINELOPS_ADMIN_TOKEN=change-this-locally
SETTINGS_ENCRYPTION_KEY=replace-with-a-long-random-key
EMAIL_ENABLED=false
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=sender@example.com
SMTP_PASSWORD=app-password
SMTP_FROM=sender@example.com
SMTP_RECIPIENTS=operator@example.com
~~~

SMTP_PASSWORD is only a placeholder. Do not paste a real credential into source control or logs.

### Start the stack

~~~powershell
docker compose up -d --build --remove-orphans
docker compose ps
~~~

| Component | URL |
| --- | --- |
| Test service | [http://localhost:8080](http://localhost:8080) |
| Prometheus | [http://localhost:9090](http://localhost:9090) |
| Grafana | [http://localhost:3000](http://localhost:3000) |
| Alert Manager | [http://localhost:3005](http://localhost:3005) |

The recovery controller listens only on the internal Docker network at port 8090; it is not published to the host.

### Check health

~~~powershell
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod http://localhost:3005/health
Invoke-RestMethod http://localhost:3005/ready
docker compose config --quiet
~~~

Open Grafana and select the provisioned SentinelOops - Service Monitoring dashboard. Prometheus should show the sentinelops-test-service target as UP at http://localhost:9090/targets.

### Stop the stack

~~~powershell
docker compose down
~~~

Do not add --volumes unless you intentionally want to delete Prometheus, Grafana, and SQLite data volumes.

## Incident Recovery Walkthrough

1. Start the stack and open Alert Manager at http://localhost:3005.
2. Configure SMTP settings in the dashboard if notifications are needed.
3. In Recovery, create an enabled runbook targeting test-service. Choose START_CONTAINER for a stopped service or RESTART_CONTAINER for a running service, configure /health, and keep execution manual.
4. Simulate an outage without deleting data:

~~~powershell
docker compose stop test-service
~~~

5. After the alert rule pending period, Alert Manager records ServiceDown as FIRING and the dashboard updates through its live stream and polling path.
6. Open the incident or Recovery panel, approve the displayed action, and execute the runbook.
7. The private recovery controller validates the Compose project, service label, image, action, and token before using the Docker Engine API. It does not execute a user-provided shell command.
8. Alert Manager checks the service health endpoint twice before recording SUCCESS.
9. Verify the result:

~~~powershell
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod http://localhost:3005/api/recovery/executions
docker compose ps
~~~

The recovery socket is mounted only into recovery-controller, not into the public-facing Alert Manager process. Docker socket access is highly privileged and should be limited to local development.

## Load Testing

The repository includes a manually launched, localhost-only load-testing CLI under load-testing/. It targets the implemented test-service route at http://localhost:8080/ and never starts automatically. It supports smoke, benchmark, stress, billion, stop, and report commands with bounded virtual users, request rate, timeouts, failure limits, latency limits, duration limits, emergency stop, and large-test confirmation.

```powershell
npm run loadtest -- smoke
npm run loadtest -- benchmark --vus=20 --rate=250
npm run loadtest -- stop
npm run loadtest -- report
```

The billion command is available for a deliberately approved local experiment only; it is not run during setup or validation. Tests over one million requests require typing RUN or passing --yes. Reports are generated as JSON and Markdown under load-testing/reports/ and are ignored by Git.

While a test is running, aggregate metrics are exposed at http://localhost:9464/metrics and scraped by Prometheus. The provisioned SentinelOops - Load Testing Grafana dashboard shows request rate, total requests, error rate, latency percentiles, active virtual users, load-generator CPU and memory, response-byte throughput, and progress. Metrics use bounded labels and do not create one database record per request.

## Project Structure

~~~text
SentinelOps/
├── apps/
│   ├── alert-manager/
│   │   ├── backend/src/       # Fastify API, polling, jobs, SQLite, recovery API
│   │   ├── frontend/src/      # React dashboard
│   │   └── backend/test/      # Backend tests
│   ├── alert-receiver/        # Earlier standalone receiver; inactive in root Compose
│   ├── recovery-controller/   # Restricted Docker recovery API
│   └── test-service/          # Monitored Node.js service
├── monitoring/
│   ├── grafana/               # Datasource and dashboard provisioning
│   ├── prometheus/            # Prometheus config and alert rules
│   └── alertmanager/          # Earlier unused Alertmanager configuration
├── alert-manager/             # Legacy/planned modular app folders
├── load-testing/              # Manual localhost-only load generator and reports
├── compose.yaml
├── Dockerfile
├── .env.example
├── package.json
└── README.md
~~~

## Security Considerations

- Compose bindings are localhost-oriented for local development, but should not be treated as an internet-facing deployment.
- Keep .env out of version control. SMTP passwords, Grafana credentials, controller tokens, and encryption keys are secrets.
- SETTINGS_ENCRYPTION_KEY protects saved SMTP settings at rest; protect the key itself through the environment or a secret manager.
- Keep management authentication enabled and replace development tokens before sharing the application.
- The recovery controller validates the exact Compose project and service identity and supports a small approved action set. It does not provide arbitrary command execution.
- Docker Engine socket access can provide broad control over the Docker host. The socket is isolated to the controller, but the controller remains a privileged trust boundary.
- Avoid printing .env, resolved Compose configuration, or SMTP settings in support logs.

## Roadmap

The following are future improvements, not current dependencies or implemented guarantees:

- Hardened external control boundary with a separately deployable policy-enforcing service.
- Stronger user authentication, sessions, roles, and audit views.
- PostgreSQL-backed persistence for multi-instance deployments.
- More detailed incident timelines and notification analytics.
- Browser-level end-to-end coverage and checked-in demonstration media.
- Deployment guidance for additional environments, including Kubernetes only if a future deployment requires it.

## Validation

~~~powershell
npm test
npm run build:frontend
docker compose config --quiet
docker compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose exec -T prometheus promtool check rules /etc/prometheus/alert-rules.yml
~~~

The repository test command covers the existing Node.js and TypeScript test suites. The frontend build and Compose/Prometheus checks are listed separately so failures are easier to identify.

## Author

**Nizamuddin Ali Ahmed**

- Portfolio: [nizamuddin.online](https://nizamuddin.online)
- GitHub: [NonCoderF](https://github.com/NonCoderF)
- LinkedIn: [nizamuddin-ahmed-827024428](https://www.linkedin.com/in/nizamuddin-ahmed-827024428/)
