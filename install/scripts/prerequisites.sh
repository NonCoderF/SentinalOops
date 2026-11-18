#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-command.sh"
select_docker
"${DOCKER_BIN}" compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
command -v awk >/dev/null || { echo 'awk is required.' >&2; exit 1; }
command -v sed >/dev/null || { echo 'sed is required.' >&2; exit 1; }
if [[ "$(uname -s)" != Linux ]]; then echo 'SentinelOps installation currently supports Linux hosts only.' >&2; exit 1; fi
echo "Prerequisites satisfied: $(uname -m)"
