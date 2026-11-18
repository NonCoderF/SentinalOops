#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
umask 077
random_secret() { if command -v openssl >/dev/null; then openssl rand -hex 32; else head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
if [[ -e "${ENV_FILE}" ]]; then echo "Using existing ${ENV_FILE}"; exit 0; fi
cp "${ROOT_DIR}/.env.example" "${ENV_FILE}"
sed -i "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$(random_secret)|" "${ENV_FILE}"
sed -i "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=$(random_secret)|" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
echo "Generated ${ENV_FILE} with fresh secrets."
