#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pg_ctl -D pgdata stop 2>/dev/null || true
echo "PostgreSQL stopped."
