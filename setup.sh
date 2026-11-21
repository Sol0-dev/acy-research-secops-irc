#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

random() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

ensure_secret() {
  local key="$1"
  local length="$2"
  local current
  current="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  if [ -z "${current}" ] || printf '%s' "${current}" | grep -q '^replace-with'; then
    local value
    value="$(random "${length}")"
    if grep -qE "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      printf '\n%s=%s\n' "${key}" "${value}" >> .env
    fi
    echo "Generated ${key}."
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

# Backfill any missing or placeholder secrets so an existing .env is upgraded
# safely and Docker Compose never needs insecure defaults.
ensure_secret API_PROXY_TOKEN 24
ensure_secret ADMIN_PASSWORD 12
ensure_secret JWT_SECRET 32
ensure_secret DB_ROOT_PASSWORD 16
ensure_secret DB_PASSWORD 16

ADMIN_USER="$(grep '^ADMIN_USERNAME=' .env | cut -d= -f2-)"
ADMIN_PASS="$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "Starting with Docker Compose..."
  docker compose up -d --build
  echo
  echo "acy-research is starting at http://localhost:5180"
  echo "Admin menu: click the admin button in the header"
  echo "Admin username: ${ADMIN_USER:-admin}"
  echo "Admin password: ${ADMIN_PASS:-see .env}"
  exit 0
fi

echo "Docker not found. Falling back to a local Node install."
echo "You need a reachable MySQL/MariaDB and DB_* values in .env."
npm install
npm run db:init
npm run build
echo
echo "Build complete. Start it with:"
echo "  npm run server   # API on 127.0.0.1:8787"
echo "  npm start        # web on 0.0.0.0:5180"
echo
echo "Admin username: ${ADMIN_USER:-admin}"
echo "Admin password: ${ADMIN_PASS:-see .env}"
