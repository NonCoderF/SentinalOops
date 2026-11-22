#!/usr/bin/env bash
set -Eeuo pipefail
prepare_runtime_env() {
  local root_dir="$1"
  local source_file="${root_dir}/.env"
  local runtime_file="${root_dir}/.env.runtime"
  source "${root_dir}/scripts/env-file.sh"
  load_env_file "${source_file}"
  # Normalize CRLF while preserving all user configuration. Remove only the
  # three installer-controlled security keys, then append safe local values.
  awk 'BEGIN { IGNORECASE=0 } { line=$0; sub(/\r$/, "", line); if (line !~ /^[[:space:]]*(SENTINELOPS_AUTH_ENABLED|SENTINELOPS_ADMIN_TOKEN|SENTINELOPS_SETUP_TOKEN)[[:space:]]*=/) print line }' "${source_file}" > "${runtime_file}"
  printf '%s\n' 'SENTINELOPS_AUTH_ENABLED=false' 'SENTINELOPS_ADMIN_TOKEN=' 'SENTINELOPS_SETUP_TOKEN=' >> "${runtime_file}"
  chmod 600 "${runtime_file}"
  # docker.exe resolves Compose paths from the Windows working directory;
  # keep the CLI argument relative while writing to the absolute WSL path.
  RUNTIME_ENV_FILE=".env.runtime"
  export RUNTIME_ENV_FILE
}
