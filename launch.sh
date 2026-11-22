#!/usr/bin/env bash
# One-run launcher for secops.irc on a Linux host or VM.
#
#   ./launch.sh            # Docker Compose when available, otherwise local Node
#   ./launch.sh --docker   # require Docker Compose
#   ./launch.sh --local    # force local Node + MySQL/MariaDB
#
# The launcher only creates a fresh empty workspace. It never copies or ships
# agent chats, graphs, reports, knowledge nodes, tools, progress, accounts, or
# chat groups. Those live only in the MySQL database created on this machine.

set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-auto}"
COMPOSE=""

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
  current="$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -z "${current}" ] || printf '%s' "${current}" | grep -q '^replace-with'; then
    local value
    value="$(random "${length}")"
    if grep -qE "^${key}=" .env 2>/dev/null; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      printf '\n%s=%s\n' "${key}" "${value}" >> .env
    fi
    echo "Generated ${key}."
  fi
}

wait_for_http() {
  local url="$1"
  local tries="${2:-90}"
  for _ in $(seq 1 "${tries}"); do
    if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

db_value() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true
}

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

# Fresh, generated secrets. The database starts empty on a new machine.
ensure_secret API_PROXY_TOKEN 24
ensure_secret ADMIN_PASSWORD 12
ensure_secret JWT_SECRET 32
ensure_secret DB_ROOT_PASSWORD 16
ensure_secret DB_PASSWORD 16

ADMIN_USER="$(db_value ADMIN_USERNAME)"
ADMIN_PASS="$(db_value ADMIN_PASSWORD)"
DB_NAME_VALUE="$(db_value DB_NAME)"
DB_NAME_VALUE="${DB_NAME_VALUE:-secops_irc}"

if [ "$MODE" != "--local" ]; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  fi
fi

if [ "$MODE" = "--docker" ] && [ -z "$COMPOSE" ]; then
  echo "Docker Compose is required for --docker." >&2
  echo "Install Docker Engine and the Compose plugin, then run ./launch.sh --docker." >&2
  exit 1
fi

if [ -n "$COMPOSE" ] && [ "$MODE" != "--local" ] && ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to verify the web health endpoint." >&2
  exit 1
fi

if [ -n "$COMPOSE" ] && [ "$MODE" != "--local" ]; then
  echo "Launching secops.irc with Docker Compose..."
  $COMPOSE up -d --build

  if ! wait_for_http "http://127.0.0.1:5180/api/health" 120; then
    echo "The web console did not become healthy in time." >&2
    $COMPOSE ps >&2 || true
    $COMPOSE logs --tail=80 >&2 || true
    exit 1
  fi

  echo
  echo "secops.irc is running at http://localhost:5180"
  echo "LAN: http://<this-machine-ip>:5180"
  echo "Admin username: ${ADMIN_USER:-admin}"
  echo "Admin password: ${ADMIN_PASS:-see .env}"
  echo "Database: fresh ${DB_NAME_VALUE} volume (no agent data copied)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Local Node + MySQL/MariaDB path
# ---------------------------------------------------------------------------

for command in node npm curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    echo "Install Node.js 20+ and npm, or install Docker and rerun with --docker." >&2
    exit 1
  fi
done

if ! command -v mysql >/dev/null 2>&1 && ! command -v mariadb >/dev/null 2>&1; then
  echo "MySQL/MariaDB client not found." >&2
  echo "Install MariaDB/MySQL, or use Docker Compose: ./launch.sh --docker" >&2
  exit 1
fi

DB_HOST_VALUE="$(db_value DB_HOST)"; DB_HOST_VALUE="${DB_HOST_VALUE:-127.0.0.1}"
DB_PORT_VALUE="$(db_value DB_PORT)"; DB_PORT_VALUE="${DB_PORT_VALUE:-3306}"
DB_USER_VALUE="$(db_value DB_USER)"; DB_USER_VALUE="${DB_USER_VALUE:-acy}"
DB_PASS_VALUE="$(db_value DB_PASSWORD)"

if command -v mysqladmin >/dev/null 2>&1; then
  if ! mysqladmin --protocol=tcp -h "${DB_HOST_VALUE}" -P "${DB_PORT_VALUE}" \
      -u "${DB_USER_VALUE}" -p"${DB_PASS_VALUE}" ping >/dev/null 2>&1; then
    echo "Cannot reach MySQL/MariaDB at ${DB_HOST_VALUE}:${DB_PORT_VALUE} as ${DB_USER_VALUE}." >&2
    echo "Create the database/user in .env, or use Docker Compose: ./launch.sh --docker" >&2
    exit 1
  fi
fi

echo "Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "Initializing the fresh workspace..."
npm run db:init
npm run build

echo "Starting API and web console..."
nohup node server/index.js >/tmp/secops-irc-api.log 2>&1 &
nohup node server/serve.js >/tmp/secops-irc-web.log 2>&1 &

if ! wait_for_http "http://127.0.0.1:5180/api/health" 90; then
  echo "The local console did not become healthy in time." >&2
  tail -80 /tmp/secops-irc-api.log >&2 || true
  tail -80 /tmp/secops-irc-web.log >&2 || true
  exit 1
fi

echo
echo "secops.irc is running at http://localhost:5180"
echo "LAN: http://<this-machine-ip>:5180"
echo "Admin username: ${ADMIN_USER:-admin}"
echo "Admin password: ${ADMIN_PASS:-see .env}"
echo "Database: fresh ${DB_NAME_VALUE} (no agent data copied)"
echo "Logs: /tmp/secops-irc-api.log and /tmp/secops-irc-web.log"
