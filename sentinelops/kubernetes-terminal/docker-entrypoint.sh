#!/bin/sh
set -eu

if [ "${DOCKER_HOST:-}" = "unix:///var/run/docker.sock" ] && [ -S /var/run/docker.sock ]; then
  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
  if ! getent group "${socket_gid}" >/dev/null 2>&1; then
    groupadd --gid "${socket_gid}" dockerhost
  fi
  group_name="$(getent group "${socket_gid}" | cut -d: -f1)"
  usermod -aG "${group_name}" terminal
  # kind keeps its control-plane network separate from Compose. Attach this
  # trusted terminal to it when the allowlisted lab network exists so the
  # exported kubeconfig can use the control-plane DNS name.
  docker network connect kind "$(hostname)" 2>/dev/null || true
fi

mkdir -p /home/terminal/.kube
chown -R terminal:terminal /workspace /home/terminal/.kube

exec su -s /bin/bash terminal -c 'exec node /app/server.mjs'
