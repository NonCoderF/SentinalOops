#!/usr/bin/env bash
set -Eeuo pipefail

select_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER_BIN="docker"
  elif command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
    DOCKER_BIN="docker.exe"
  else
    echo 'Cannot connect to the Docker daemon.' >&2
    echo 'Start Docker Desktop or enable WSL integration for this distribution.' >&2
    return 1
  fi
  export DOCKER_BIN
}
