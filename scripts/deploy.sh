#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${DOMAIN:-photo.svhw.tech}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
SERVICE_NAME="${SERVICE_NAME:-photo-story}"
WEB_ROOT="${WEB_ROOT:-/var/www/photo-story}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
WEB_DIST="${PROJECT_ROOT}/apps/web/dist"
SERVER_ENTRY="${PROJECT_ROOT}/apps/server/dist/server.js"

if ((EUID == 0)); then
  SUDO=()
else
  SUDO=(sudo)
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

for command_name in node npm curl systemctl; do
  require_command "${command_name}"
done
if ((${#SUDO[@]})); then
  require_command sudo
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if ((NODE_MAJOR < 22)); then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

if ! "${SUDO[@]}" systemctl cat "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  echo "Missing one-time systemd configuration: ${SERVICE_NAME}.service" >&2
  exit 1
fi

echo "Building frontend and backend..."
cd "${PROJECT_ROOT}"
npm ci
npm run build

if [[ ! -f "${WEB_DIST}/index.html" || ! -f "${SERVER_ENTRY}" ]]; then
  echo "Build output is incomplete." >&2
  exit 1
fi

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-$$"
RELEASE_DIR="${WEB_ROOT}/releases/${RELEASE_ID}"
CURRENT_LINK="${WEB_ROOT}/current"

"${SUDO[@]}" install -d -m 0755 "${WEB_ROOT}/releases" "${RELEASE_DIR}"
"${SUDO[@]}" cp -a "${WEB_DIST}/." "${RELEASE_DIR}/"
"${SUDO[@]}" ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}.new"
"${SUDO[@]}" mv -Tf "${CURRENT_LINK}.new" "${CURRENT_LINK}"

"${SUDO[@]}" systemctl restart "${SERVICE_NAME}.service"

curl --fail --silent --show-error \
  --retry 10 --retry-all-errors --retry-delay 1 \
  "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" >/dev/null
curl --fail --silent --show-error \
  "https://${DOMAIN}/api/health" >/dev/null

echo "Deployment complete: https://${DOMAIN}"
