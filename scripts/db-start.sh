#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d pgdata ]; then
  echo "Creating local PostgreSQL cluster in pgdata/"
  initdb -D pgdata -U "${USER}" -A trust --no-locale --encoding=UTF8 >/dev/null
fi

pg_ctl -D pgdata -l pg.log -o "-p 5433 -k /tmp" start 2>/dev/null || true
sleep 1
createdb -h /tmp -p 5433 -U "${USER}" portal 2>/dev/null || true
echo "PostgreSQL is running on port 5433 (local project cluster)."
