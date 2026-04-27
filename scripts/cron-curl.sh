#!/usr/bin/env bash
# Trigger a Vercel cron route from local launchd.
# Replaces Vercel's own cron scheduling (which Hobby tier limits to 2/daily).
# Mac Studio launchd handles the timing; Vercel still runs the route handler.
#
# IMPORTANT: macOS TCC blocks launchd-spawned processes from reading files
# under ~/Documents without Full Disk Access. Therefore:
#   - This script is INSTALLED to ~/.local/bin/grain-cron-curl (not invoked
#     directly from the repo path).
#   - CRON_SECRET is read from ~/.config/grain/cron.env (not .env.local).
# See scripts/launchd/README.md for the install procedure.

set -euo pipefail

ROUTE_PATH="${1:?usage: grain-cron-curl /api/cron/<name>}"
ENV_FILE="$HOME/.config/grain/cron.env"

[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }

# shellcheck source=/dev/null
set -a; source "$ENV_FILE"; set +a

: "${CRON_SECRET:?CRON_SECRET not set in $ENV_FILE}"

BASE_URL="${VERCEL_BASE_URL:-https://grain-one-swart.vercel.app}"

exec curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Accept: application/json" \
  --max-time 290 \
  --retry 2 --retry-delay 10 --retry-connrefused \
  "$BASE_URL$ROUTE_PATH"
