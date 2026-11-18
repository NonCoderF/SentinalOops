# SentinelOps standalone installation

This directory installs the SentinelOps application with Prometheus, Grafana, and Blackbox Exporter. It never installs or runs the independent `test-service`. Docker recovery control is opt-in through the `recovery` Compose profile because it requires a narrowly configured container allowlist and Docker socket access.

## Requirements

Linux, Docker Engine, Docker Compose v2, curl, awk, sed, and at least 5 GiB free disk space. The installer does not install Docker or modify the firewall. The dashboard binds to `127.0.0.1` by default on port 3005; change `SENTINELOPS_WEB_PORT` in `.env` before installation if required.

## Install

```bash
chmod +x install/install.sh install/*.sh install/scripts/*.sh
./install/install.sh
```

Open the `/setup` URL. The default installation is bound to localhost and does not require a token. Register GET or HEAD endpoints and activate monitoring. Targets are written atomically to the shared Prometheus file-discovery volume and Prometheus reloads them without restarting.

## Operations

```bash
./install/scripts/health-check.sh
./install/scripts/backup.sh
./install/update.sh
./install/uninstall.sh
./install/uninstall.sh --purge-data
```

Prometheus, Grafana, and Blackbox Exporter are internal-only. Grafana dashboards use real `probe_success`, `probe_http_duration_seconds`, and related Blackbox metrics. HTTP probing does not create CPU, memory, request-rate, or application latency metrics; those require application instrumentation or exporters.

To scrape an instrumented application's Prometheus endpoint, set `PROMETHEUS_METRICS_TARGET` and `PROMETHEUS_METRICS_APPLICATION` in `install/.env`. The target is written to Prometheus file discovery atomically by SentinelOps; no demo service is assumed.

For endpoints on the Docker host, use a host address reachable from containers, such as `host.docker.internal` where supported, or configure a Linux host-gateway explicitly. Endpoint validation rejects loopback, link-local, private, and metadata destinations by default.

Persistent data lives in named volumes `sentinelops_install_data`, `sentinelops_install_prometheus`, `sentinelops_install_grafana`, and `sentinelops_install_file_sd`. Never delete them unless data removal is intended.

Troubleshooting:

```bash
docker compose --env-file install/.env -f install/docker-compose.yml ps
docker compose --env-file install/.env -f install/docker-compose.yml logs --tail=100 sentinelops
```
