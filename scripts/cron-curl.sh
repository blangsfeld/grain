#!/usr/bin/env bash
# Trigger a Vercel cron route from local launchd.
# Replaces Vercel's own cron scheduling (which Hobby tier limits to 2/daily).
# Mac Studio launchd handles the timing; Vercel still runs the route handler.

set -euo pipefail

ROUTE_PATH="${1:?usage: cron-curl.sh /api/cron/<name>}"
GRAIN_DIR="$HOME/Documents/Apps/grain"
ENV_FILE="$GRAIN_DIR/.env.local"

[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }

# shellcheck source=/dev/null
set -a; source "$ENV_FILE"; set +a

: "${CRON_SECRET:?CRON_SECRET not set in .env.local}"

BASE_URL="${VERCEL_BASE_URL:-https://grain-one-swart.vercel.app}"

# Vercel functions cap at 300s; max-time slightly under to surface our own error.
exec curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Accept: application/json" \
  --max-time 290 \
  --retry 2 --retry-delay 10 --retry-connrefused \
  "$BASE_URL$ROUTE_PATH"
