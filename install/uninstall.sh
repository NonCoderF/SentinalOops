#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/docker-command.sh"
select_docker
[[ -f .env ]] || { echo 'No installation found.'; exit 0; }
set -a
source .env
set +a
source "${ROOT_DIR}/scripts/runtime-env.sh"
prepare_runtime_env "${ROOT_DIR}"
"${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml down
if [[ "${1:-}" == "--purge-data" ]]; then
  read -r -p 'Type DELETE to remove SentinelOps volumes and all stored data: ' confirmation
  [[ "${confirmation}" == DELETE ]] || { echo 'Aborted.'; exit 1; }
  "${DOCKER_BIN}" compose --env-file "${RUNTIME_ENV_FILE}" -f docker-compose.yml down -v
  echo 'SentinelOps volumes removed.'
else
  echo 'Containers stopped; persistent volumes preserved.'
fi
