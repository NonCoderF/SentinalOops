#!/bin/sh
set -eu

# The file-discovery volume is shared with Prometheus. Docker creates named
# volumes as root, so initialize its ownership before dropping privileges.
mkdir -p /etc/prometheus/file_sd /var/lib/sentinelops
chown -R sentinelops:sentinelops /etc/prometheus/file_sd /var/lib/sentinelops

exec su-exec sentinelops "$@"
