#!/bin/sh
set -eu

if [ "${DOCKER_HOST:-}" = "unix:///var/run/docker.sock" ] && [ -S /var/run/docker.sock ]; then
  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
  if ! getent group "${socket_gid}" >/dev/null 2>&1; then
    groupadd --gid "${socket_gid}" dockerhost
  fi
  group_name="$(getent group "${socket_gid}" | cut -d: -f1)"
  usermod -aG "${group_name}" terminal
fi

chown -R terminal:terminal /workspace

exec su -s /bin/bash terminal -c 'exec node /app/server.mjs'
