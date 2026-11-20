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

if [ ! -f .env ]; then
  cp .env.example .env
  PROXY_TOKEN="$(random 24)"
  ADMIN_PASSWORD="$(random 12)"
  JWT_SECRET="$(random 32)"
  sed -i "s|^API_PROXY_TOKEN=.*|API_PROXY_TOKEN=${PROXY_TOKEN}|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PASSWORD}|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
  echo "Created .env with generated secrets."
fi

ADMIN_USER="$(grep '^ADMIN_USERNAME=' .env | cut -d= -f2-)"
ADMIN_PASS="$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "Starting with Docker Compose..."
  docker compose up -d --build
  echo
  echo "acy-research is starting at http://localhost:5180"
  echo "Admin shortcut: Ctrl+Shift+A"
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
