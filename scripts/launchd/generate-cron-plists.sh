#!/usr/bin/env bash
# Generate launchd plists for grain crons that moved off Vercel Hobby (2-cron limit).
# Emits one plist per cron in scripts/launchd/com.benlangsfeld.grain-cron-<name>.plist.
#
# Schedules are local Mac Studio time (Eastern). Source-of-truth is each
# original Vercel UTC schedule, converted to America/New_York (EDT in summer,
# EST in winter — DST drift of ±1 hour on UTC time is acceptable).
#
# To add or change a cron: edit CRONS below, re-run this script, commit the
# resulting plist files. Then bootstrap via the launchd README.

set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Helper lives in ~/.local/bin (outside ~/Documents) because macOS TCC blocks
# launchd-spawned processes from executing scripts in ~/Documents without
# Full Disk Access. The repo's scripts/cron-curl.sh is the canonical source;
# `bash scripts/launchd/install.sh` (or the README's install block) copies it
# to ~/.local/bin/grain-cron-curl.
HELPER="$HOME/.local/bin/grain-cron-curl"

# Format: name|route_path|schedule_spec
# schedule_spec is one or more semicolon-separated entries of the form:
#   weekdays:HH:MM   — fire on weekdays 1-5 (Mon-Fri) at HH:MM local
#   daily:HH:MM      — fire every day at HH:MM
#   wd<N>:HH:MM      — fire on weekday N (0=Sun, 1=Mon, ..., 6=Sat) at HH:MM
# Multiple specs per cron run for each spec.
CRONS=(
  "daily|/api/cron/daily|weekdays:08:03"
  "weekly|/api/cron/weekly|wd6:22:17"
  "weekly-lint|/api/cron/weekly-lint|wd1:10:00"
  "grain-steward|/api/cron/grain-steward|daily:08:53"
  "ea|/api/cron/ea|daily:09:07"
  "security-steward|/api/cron/security-steward|daily:09:23"
  "what-if|/api/cron/what-if|wd1:10:37"
  "columnist|/api/cron/columnist|wd3:10:47"
  "notion-steward|/api/cron/notion-steward|wd1:10:27"
  "pulse|/api/cron/pulse|wd2:12:00;wd5:12:00"
)

emit_calendar_entry() {
  local spec="$1"
  case "$spec" in
    weekdays:*)
      local hm="${spec#weekdays:}"
      local h="${hm%:*}" m="${hm#*:}"
      for wd in 1 2 3 4 5; do
        printf '        <dict><key>Weekday</key><integer>%d</integer><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' "$wd" "$((10#$h))" "$((10#$m))"
      done
      ;;
    daily:*)
      local hm="${spec#daily:}"
      local h="${hm%:*}" m="${hm#*:}"
      printf '        <dict><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' "$((10#$h))" "$((10#$m))"
      ;;
    wd*)
      local wd_part="${spec%%:*}"        # wd1
      local hm="${spec#*:}"              # 10:00
      local wd="${wd_part#wd}"
      local h="${hm%:*}" m="${hm#*:}"
      printf '        <dict><key>Weekday</key><integer>%d</integer><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' "$wd" "$((10#$h))" "$((10#$m))"
      ;;
    *)
      echo "unknown schedule spec: $spec" >&2
      exit 1
      ;;
  esac
}

generate_plist() {
  local name="$1" route="$2" schedule="$3"
  local label="com.benlangsfeld.grain-cron-${name}"
  local out="$OUT_DIR/${label}.plist"

  local entries=""
  IFS=';' read -ra specs <<< "$schedule"
  for spec in "${specs[@]}"; do
    entries+="$(emit_calendar_entry "$spec")"$'\n'
  done

  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${HELPER}</string>
        <string>${route}</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
${entries%$'\n'}
    </array>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>/Users/ben/Library/Logs/grain-cron-${name}.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/ben/Library/Logs/grain-cron-${name}.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>

    <key>Nice</key>
    <integer>5</integer>
</dict>
</plist>
EOF
  echo "  ✓ $out"
}

echo "Generating launchd plists in $OUT_DIR"
for entry in "${CRONS[@]}"; do
  IFS='|' read -r name route schedule <<< "$entry"
  generate_plist "$name" "$route" "$schedule"
done
echo "Done. ${#CRONS[@]} plists generated."
