#!/usr/bin/env bash
set -Eeuo pipefail

# Run from anywhere; the existing CLI and reports live at the repository root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

COMMAND="${COMMAND:-benchmark}"
TARGET="${TARGET:-http://localhost:8080/}"
VUS="${VUS:-50}"
RATE="${RATE:-250}"
DURATION="${DURATION:-}"
TOTAL="${TOTAL:-}"
FOREVER="${FOREVER:-0}"

usage() {
  cat <<'EOF'
Usage:
  ./load-testing/run-load-test.sh [smoke|benchmark|stress|billion]

Environment variables:
  TARGET=http://localhost:8080/   Local target URL
  VUS=50                          Concurrent virtual users (max 500)
  RATE=250                        Aggregate request rate
  TOTAL=100000                    Override the command request target
  DURATION=60                     Optional duration limit in seconds
  FOREVER=1                       Repeat runs until Ctrl+C

Examples:
  ./load-testing/run-load-test.sh smoke
  VUS=100 RATE=1000 DURATION=300 ./load-testing/run-load-test.sh stress
  FOREVER=1 VUS=50 RATE=250 ./load-testing/run-load-test.sh benchmark
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

COMMAND="${1:-${COMMAND}}"
case "${COMMAND}" in
  smoke|benchmark|stress|billion) ;;
  *) echo "Unsupported load-test command: ${COMMAND}" >&2; usage >&2; exit 2 ;;
esac

if [[ "${FOREVER}" == "1" ]]; then
  trap 'npm run loadtest -- stop >/dev/null 2>&1 || true; exit 130' INT TERM
fi

run_once() {
  local args=("${COMMAND}" "--target=${TARGET}" "--vus=${VUS}" "--rate=${RATE}" "--yes")
  [[ -n "${TOTAL}" ]] && args+=("--total=${TOTAL}")
  [[ -n "${DURATION}" ]] && args+=("--duration=${DURATION}")
  npm run loadtest -- "${args[@]}"
}

if [[ "${FOREVER}" == "1" ]]; then
  while true; do
    run_once
    echo "Run completed; starting the next run. Press Ctrl+C to stop."
  done
else
  run_once
fi
