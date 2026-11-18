#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/docker-command.sh"
select_docker
[[ -f .env ]] || { echo 'No installation found; run install.sh first.' >&2; exit 1; }
set -a
source .env
set +a
source "${ROOT_DIR}/scripts/runtime-env.sh"
prepare_runtime_env "${ROOT_DIR}"
export SENTINELOPS_AUTH_ENABLED=false
export SENTINELOPS_ADMIN_TOKEN=
export SENTINELOPS_SETUP_TOKEN=
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml build sentinelops
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml up -d --remove-orphans
"${ROOT_DIR}/scripts/health-check.sh"
