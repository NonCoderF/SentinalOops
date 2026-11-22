#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/docker-command.sh"
select_docker
source "${ROOT_DIR}/scripts/env-file.sh"
load_env_file "${ROOT_DIR}/.env"
DEST="${1:-${ROOT_DIR}/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "${DEST}"
"${DOCKER_BIN}" run --rm -v sentinelops_install_data:/data:ro -v "${DEST}":/backup alpine sh -c 'cp -a /data/. /backup/'
cp .env "${DEST}/.env"
chmod 600 "${DEST}/.env"
echo "Backup written to ${DEST}"
