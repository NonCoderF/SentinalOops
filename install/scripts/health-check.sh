#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/docker-command.sh"
select_docker
set -a; [[ -f .env ]] && source .env; set +a
source "${ROOT_DIR}/scripts/runtime-env.sh"
prepare_runtime_env "${ROOT_DIR}"
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml ps
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml ps --status running --services | grep -qx sentinelops
curl -fsS "http://127.0.0.1:${SENTINELOPS_WEB_PORT:-3005}/health" >/dev/null
echo "SentinelOps is healthy on port ${SENTINELOPS_WEB_PORT:-3005}."
