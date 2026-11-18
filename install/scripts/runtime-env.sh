#!/usr/bin/env bash
set -Eeuo pipefail
prepare_runtime_env() {
  local root_dir="$1"
  local source_file="${root_dir}/.env"
  local runtime_file="${root_dir}/.env.runtime"
  sed -e 's/^SENTINELOPS_AUTH_ENABLED=.*/SENTINELOPS_AUTH_ENABLED=false/' \
      -e 's/^SENTINELOPS_ADMIN_TOKEN=.*/SENTINELOPS_ADMIN_TOKEN=/' \
      -e 's/^SENTINELOPS_SETUP_TOKEN=.*/SENTINELOPS_SETUP_TOKEN=/' \
      "${source_file}" > "${runtime_file}"
  chmod 600 "${runtime_file}"
  # docker.exe resolves Compose paths from the Windows working directory;
  # keep the CLI argument relative while writing to the absolute WSL path.
  RUNTIME_ENV_FILE=".env.runtime"
  export RUNTIME_ENV_FILE
}
