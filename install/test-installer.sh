#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${ROOT_DIR}/scripts/env-file.sh"
source "${ROOT_DIR}/scripts/runtime-env.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

assert_eq() { [[ "$1" == "$2" ]] || { echo "assertion failed" >&2; exit 1; }; }
assert_fails() { "$@" >/dev/null 2>"${TEST_DIR}/error" && { echo 'expected failure' >&2; exit 1; } || true; }

cat > "${TEST_DIR}/lf.env" <<'EOF'
# Compose dotenv syntax
SENTINELOPS_WEB_PORT=3005
PROMETHEUS_METRICS_APPLICATION=Test Service
QUOTED="a value # with spaces and !"
SINGLE='literal $value # text'
ESCAPED="line\nvalue"
EOF
load_env_file "${TEST_DIR}/lf.env"
env_value SENTINELOPS_WEB_PORT; assert_eq "$ENV_VALUE" 3005; validate_web_port "$ENV_VALUE"
env_value PROMETHEUS_METRICS_APPLICATION; assert_eq "$ENV_VALUE" 'Test Service'
env_value QUOTED; assert_eq "$ENV_VALUE" 'a value # with spaces and !'
env_value SINGLE; assert_eq "$ENV_VALUE" 'literal $value # text'
env_value ESCAPED; assert_eq "$ENV_VALUE" $'line\nvalue'

# The same configuration with Windows CRLF line endings must parse identically.
sed 's/$/\r/' "${TEST_DIR}/lf.env" > "${TEST_DIR}/crlf.env"
load_env_file "${TEST_DIR}/crlf.env"
env_value PROMETHEUS_METRICS_APPLICATION; assert_eq "$ENV_VALUE" 'Test Service'

for port in 0 80 65536 abc; do assert_fails validate_web_port "$port"; done
assert_fails validate_web_port ''
assert_fails load_env_file <(printf 'BROKEN\n')
printf 'PASSWORD=do-not-print\nBROKEN\n' > "${TEST_DIR}/malformed.env"
assert_fails load_env_file "${TEST_DIR}/malformed.env"
! grep -Fq 'do-not-print' "${TEST_DIR}/error" || { echo 'secret leaked in error' >&2; exit 1; }

# Runtime generation preserves user settings and only forces local security.
cp "${TEST_DIR}/lf.env" "${TEST_DIR}/.env"
mkdir "${TEST_DIR}/scripts"
cp "${ROOT_DIR}/scripts/env-file.sh" "${TEST_DIR}/scripts/env-file.sh"
prepare_runtime_env "${TEST_DIR}"
grep -Fxq 'SENTINELOPS_WEB_PORT=3005' "${TEST_DIR}/.env.runtime"
grep -Fxq 'PROMETHEUS_METRICS_APPLICATION=Test Service' "${TEST_DIR}/.env.runtime"
grep -Fxq 'SENTINELOPS_AUTH_ENABLED=false' "${TEST_DIR}/.env.runtime"

# Compose must receive dotenv values through --env-file, including spaces.
cat > "${TEST_DIR}/compose.yml" <<'EOF'
services:
  test:
    image: alpine:latest
    environment:
      APPLICATION: ${PROMETHEUS_METRICS_APPLICATION}
    ports:
      - "127.0.0.1:${SENTINELOPS_WEB_PORT}:8080"
EOF
if [[ "${RUN_COMPOSE_TEST:-0}" == 1 ]] && command -v docker >/dev/null 2>&1 && [[ "$(command -v docker)" != *docker.exe ]]; then
  docker compose --env-file "${TEST_DIR}/lf.env" -f "${TEST_DIR}/compose.yml" config > "${TEST_DIR}/compose.out"
else
  echo 'Linux Docker Compose CLI unavailable; skipped local interpolation check.' >&2
fi
if [[ -f "${TEST_DIR}/compose.out" ]]; then
  grep -Fq 'APPLICATION: Test Service' "${TEST_DIR}/compose.out"
  grep -Fq '127.0.0.1:3005:8080' "${TEST_DIR}/compose.out"
fi

# Re-running config generation must not replace an existing environment file.
before="$(sha256sum "${ROOT_DIR}/.env" | awk '{print $1}')"
"${ROOT_DIR}/scripts/generate-config.sh" >/dev/null
after="$(sha256sum "${ROOT_DIR}/.env" | awk '{print $1}')"
assert_eq "$before" "$after"

echo 'installer regression tests passed'
