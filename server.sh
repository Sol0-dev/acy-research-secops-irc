#!/usr/bin/env bash
# Start, stop, restart, and inspect the secops.irc API and web console.
#
#   ./server.sh start            start the API and web console
#   ./server.sh stop             stop both processes
#   ./server.sh restart          stop then start
#   ./server.sh restart --build  rebuild the web bundle first, then restart
#   ./server.sh status           show whether each process is up
#   ./server.sh logs [api|web]   follow the API or web log
#   ./server.sh build            type-check and build the web bundle
#
# The API listens on 127.0.0.1:8787 and the public web console on 0.0.0.0:5180.
# Ports can be changed with PORT and WEB_PORT in .env.

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="secops-irc"
API_SCRIPT="server/index.js"
WEB_SCRIPT="server/serve.js"
RUN_DIR="${SECOPS_RUN_DIR:-/tmp/${APP_NAME}}"
API_PID_FILE="${RUN_DIR}/api.pid"
WEB_PID_FILE="${RUN_DIR}/web.pid"
API_LOG="${RUN_DIR}/api.log"
WEB_LOG="${RUN_DIR}/web.log"

mkdir -p "$RUN_DIR"

env_value() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true
}

API_PORT="${PORT:-$(env_value PORT)}"
API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-$(env_value WEB_PORT)}"
WEB_PORT="${WEB_PORT:-5180}"

DB_HOST="${DB_HOST:-$(env_value DB_HOST)}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-$(env_value DB_PORT)}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-$(env_value DB_USER)}"
DB_USER="${DB_USER:-acy}"
DB_PASSWORD="${DB_PASSWORD:-$(env_value DB_PASSWORD)}"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_runtime() {
  [ -f .env ] || fail ".env is missing; run ./launch.sh first"
  [ -f "$API_SCRIPT" ] || fail "$API_SCRIPT is missing"
  [ -f "$WEB_SCRIPT" ] || fail "$WEB_SCRIPT is missing"
  command -v node >/dev/null 2>&1 || fail "node is not installed"
  command -v npm >/dev/null 2>&1 || fail "npm is not installed"
  [ -d node_modules ] || fail "node_modules is missing; run npm install first"
}

is_running() {
  local pid_file="$1" pid
  [ -f "$pid_file" ] || return 1
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

pid_of() {
  cat "$1" 2>/dev/null || true
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q .
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "${port}" >/dev/null 2>&1
    return
  fi
  return 1
}

kill_port() {
  local port="$1"
  port_in_use "$port" || return 0
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    sleep 0.3
  fi
  if port_in_use "$port"; then
    say "warning: port ${port} is still in use"
  fi
}

stop_one() {
  local label="$1" pid_file="$2" port="$3" pid
  if is_running "$pid_file"; then
    pid="$(pid_of "$pid_file")"
    say "stopping ${label} (pid ${pid})"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "${label} did not exit; sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file"
  kill_port "$port"
}

start_one() {
  local label="$1" script="$2" log="$3" pid_file="$4" pid
  if is_running "$pid_file"; then
    say "${label} is already running (pid $(pid_of "$pid_file"))"
    return 0
  fi
  rm -f "$pid_file"
  : >"$log"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup node "$script" >>"$log" 2>&1 </dev/null &
  else
    nohup node "$script" >>"$log" 2>&1 </dev/null &
  fi
  pid=$!
  printf '%s\n' "$pid" >"$pid_file"
  sleep 0.5
  if ! kill -0 "$pid" 2>/dev/null; then
    say "${label} failed to start. Last log lines:" >&2
    tail -30 "$log" >&2 || true
    rm -f "$pid_file"
    return 1
  fi
  say "started ${label} (pid ${pid})"
}

health_ok() {
  curl -fsS --max-time 2 "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1
}

wait_health() {
  local tries="${1:-30}"
  for _ in $(seq 1 "$tries"); do
    if health_ok; then
      return 0
    fi
    if ! is_running "$API_PID_FILE" || ! is_running "$WEB_PID_FILE"; then
      return 1
    fi
    sleep 1
  done
  return 1
}

needs_build() {
  [ -f dist/index.html ] || return 0
  find src -type f -newer dist/index.html -print -quit 2>/dev/null | grep -q .
}

build_app() {
  require_runtime
  say "building (typecheck + vite build)..."
  npm run build
}

db_health() {
  if command -v mysqladmin >/dev/null 2>&1; then
    MYSQL_PWD="${DB_PASSWORD}" mysqladmin --protocol=tcp \
      -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" ping >/dev/null 2>&1
    return
  fi
  if command -v mysql >/dev/null 2>&1; then
    MYSQL_PWD="${DB_PASSWORD}" mysql --protocol=tcp \
      -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" \
      -e 'SELECT 1' >/dev/null 2>&1
    return
  fi
  return 0
}

require_database() {
  db_health && return 0
  say "database is not reachable at ${DB_HOST}:${DB_PORT} as ${DB_USER}" >&2
  say "start MySQL/MariaDB first, for example:" >&2
  say "  sudo systemctl start mariadb" >&2
  return 1
}

cmd_start() {
  require_runtime
  require_database || return 1
  if is_running "$API_PID_FILE" && is_running "$WEB_PID_FILE"; then
    say "secops.irc is already running"
    cmd_status
    return 0
  fi
  if [ ! -f dist/index.html ] || [ ! -d dist/assets ]; then
    say "dist is missing; building first"
    build_app
  fi
  if port_in_use "$API_PORT"; then
    fail "port ${API_PORT} is already in use; run ./server.sh stop or free the port"
  fi
  if port_in_use "$WEB_PORT"; then
    fail "port ${WEB_PORT} is already in use; run ./server.sh stop or free the port"
  fi
  if ! start_one "api" "$API_SCRIPT" "$API_LOG" "$API_PID_FILE"; then
    cmd_stop
    return 1
  fi
  if ! start_one "web" "$WEB_SCRIPT" "$WEB_LOG" "$WEB_PID_FILE"; then
    cmd_stop
    return 1
  fi
  if ! wait_health 30; then
    say "the console did not become healthy in time" >&2
    say "--- api log ---" >&2
    tail -40 "$API_LOG" >&2 || true
    say "--- web log ---" >&2
    tail -40 "$WEB_LOG" >&2 || true
    return 1
  fi
  if needs_build; then
    say "note: src is newer than dist; run ./server.sh restart --build to rebuild"
  fi
  say "secops.irc is up at http://127.0.0.1:${WEB_PORT}"
  say "logs: ${API_LOG} and ${WEB_LOG}"
}

cmd_stop() {
  stop_one "api" "$API_PID_FILE" "$API_PORT"
  stop_one "web" "$WEB_PID_FILE" "$WEB_PORT"
  say "stopped"
}

cmd_restart() {
  local build=0
  if [ "${1:-}" = "--build" ]; then
    build=1
  fi
  cmd_stop
  if [ "$build" -eq 1 ]; then
    build_app
  fi
  cmd_start
}

cmd_status() {
  local api_pid web_pid
  if is_running "$API_PID_FILE"; then
    api_pid="$(pid_of "$API_PID_FILE")"
    say "api: running (pid ${api_pid}) on 127.0.0.1:${API_PORT}"
  else
    say "api: stopped"
  fi
  if is_running "$WEB_PID_FILE"; then
    web_pid="$(pid_of "$WEB_PID_FILE")"
    say "web: running (pid ${web_pid}) on 0.0.0.0:${WEB_PORT}"
  else
    say "web: stopped"
  fi
  if db_health; then
    say "db: reachable (${DB_HOST}:${DB_PORT})"
  else
    say "db: unreachable (${DB_HOST}:${DB_PORT})"
  fi
  if health_ok; then
    say "health: ok (http://127.0.0.1:${WEB_PORT}/api/health)"
  else
    say "health: unavailable"
  fi
  say "logs: ${API_LOG} ${WEB_LOG}"
}

cmd_logs() {
  local which="${1:-both}"
  case "$which" in
    api)
      [ -f "$API_LOG" ] || fail "no api log at ${API_LOG}"
      tail -n 100 -f "$API_LOG"
      ;;
    web)
      [ -f "$WEB_LOG" ] || fail "no web log at ${WEB_LOG}"
      tail -n 100 -f "$WEB_LOG"
      ;;
    both)
      [ -f "$API_LOG" ] || fail "no api log at ${API_LOG}"
      [ -f "$WEB_LOG" ] || fail "no web log at ${WEB_LOG}"
      tail -n 50 -f "$API_LOG" "$WEB_LOG"
      ;;
    *)
      fail "usage: ./server.sh logs [api|web]"
      ;;
  esac
}

usage() {
  cat <<EOF
usage: ./server.sh <command> [option]

  start              start the API and web console
  stop               stop both processes
  restart            stop then start
  restart --build    rebuild the web bundle, then restart
  status             show process and health status
  logs [api|web]     follow the api or web log (default: both)
  build              type-check and build the web bundle

ports: api ${API_PORT} (loopback), web ${WEB_PORT} (public)
EOF
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) shift; cmd_restart "${1:-}" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-both}" ;;
  build) build_app ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
