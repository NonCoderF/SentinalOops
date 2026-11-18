#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
trap 'echo "Installation failed. Inspect compose logs." >&2' ERR
"${ROOT_DIR}/scripts/prerequisites.sh"
source "${ROOT_DIR}/scripts/docker-command.sh"
select_docker
"${ROOT_DIR}/scripts/generate-config.sh"
set -a
source .env
set +a
source "${ROOT_DIR}/scripts/runtime-env.sh"
prepare_runtime_env "${ROOT_DIR}"
# This installer is intentionally localhost-only and tokenless by default.
# Operators who expose the dashboard must enable authentication explicitly.
export SENTINELOPS_AUTH_ENABLED=false
export SENTINELOPS_ADMIN_TOKEN=
export SENTINELOPS_SETUP_TOKEN=
if ! [[ "${SENTINELOPS_WEB_PORT:-3005}" =~ ^[0-9]+$ ]] || (( SENTINELOPS_WEB_PORT < 1024 || SENTINELOPS_WEB_PORT > 65535 )); then echo 'Invalid web port.' >&2; exit 1; fi
if command -v df >/dev/null && (( $(df -Pk . | awk 'NR==2 {print $4}') < 5242880 )); then echo 'At least 5 GiB free disk space is recommended.' >&2; exit 1; fi
existing_container="$("${DOCKER_BIN}" compose --env-file .env -f docker-compose.yml ps -q sentinelops 2>/dev/null || true)"
if command -v ss >/dev/null && ss -ltn "sport = :${SENTINELOPS_WEB_PORT}" | grep -q LISTEN && [[ -z "${existing_container}" ]]; then echo "Port ${SENTINELOPS_WEB_PORT} is already in use." >&2; exit 1; fi
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml config >/dev/null
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml pull prometheus grafana blackbox-exporter
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml build sentinelops
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml up -d
for _ in $(seq 1 40); do if "${ROOT_DIR}/scripts/health-check.sh" >/dev/null 2>&1; then break; fi; sleep 3; done
"${ROOT_DIR}/scripts/health-check.sh"
echo "SentinelOps is installed."
echo "Dashboard: http://127.0.0.1:${SENTINELOPS_WEB_PORT:-3005}/"
echo "Setup wizard: http://127.0.0.1:${SENTINELOPS_WEB_PORT:-3005}/setup"
