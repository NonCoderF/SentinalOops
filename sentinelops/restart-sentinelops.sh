#!/usr/bin/env bash
set -euo pipefail

# Restart the SentinelOops Docker Compose project without removing volumes.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../install/docker-compose.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

echo "Stopping SentinelOops Compose services..."
docker compose -f "$COMPOSE_FILE" down

echo "Rebuilding and starting SentinelOops Compose services..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo "SentinelOops services restarted."
docker compose -f "$COMPOSE_FILE" ps
