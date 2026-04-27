# Grain local daemon

`com.residence.grain-local.plist` is the launchd job that runs `scripts/local-orchestrator.ts` twice a day (06:45 and 19:45 local) to sync Supabase ↔ Obsidian vault.

The orchestrator does the last mile Vercel can't: write to the local vault, push vault snapshots back to Supabase for Keys, run Milli's wiki reflection.

> **Note (2026-04-27):** Vercel Hobby tier allows only 2 cron jobs at daily-or-less frequency. Of grain's 13 declared crons, 11 were silently never firing. They've been migrated to Mac Studio launchd (see "Migrated cron jobs" below). Vercel still hosts the route handlers; only the *trigger* moved local.

## Install

```bash
cp scripts/launchd/com.residence.grain-local.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.residence.grain-local.plist
```

## Verify

```bash
launchctl list | grep grain-local          # should show the label
launchctl print gui/$(id -u)/com.residence.grain-local   # detailed status
```

## Fire it manually

```bash
launchctl kickstart -k gui/$(id -u)/com.residence.grain-local
# or directly:
cd ~/Documents/Apps/grain && npx tsx scripts/local-orchestrator.ts
```

## Logs

- Stdout: `~/Library/Logs/grain-local.log`
- Stderr: `~/Library/Logs/grain-local.error.log`

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.residence.grain-local.plist
rm ~/Library/LaunchAgents/com.residence.grain-local.plist
```

## What each run does

Every run:
1. **meetings** — backfill missing `50-meetings/YYYY-MM-DD.md` for the last 14 days
2. **briefings** — pull unseen rows from `dx_briefings` → write to `30-decisions/briefings/`
3. **vault-snapshots** — push wiki / projects / priorities / decisions / boot context → `vault_snapshots` table so Keys has fresh context
4. **milli** — wiki-librarian reflection pass (inventory, broken links, inbox)

Mondays only:
5. **weekly-digest** — last week's emerging-narratives synthesis → `40-patterns/weekly/`
6. **company-pages** — refresh living company profiles → `10-projects/`

All phases are idempotent and self-healing. If a day is missed (laptop closed, network out), the next run catches it up within the 14-day window.

---

# Network Pulse — morning brief

`com.benlangsfeld.network-pulse.plist` runs `scripts/network-pulse-morning.ts` weekdays at 7:03am local. Pulls Granola + Calendar + Slack + Gmail, asks Claude to synthesize a chief-of-staff memo across the eight Network companies, writes HTML + markdown to `~/Vault/80-pulse/YYYY-MM-DD.{md,html}`, pings Telegram with the topline.

Migrated from a Cowork SKILL.md scheduled task — the prompt lives in `SYSTEM_PROMPT` inside the script. Same spec, durable runtime.

## Install

```bash
cp scripts/launchd/com.benlangsfeld.network-pulse.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.benlangsfeld.network-pulse.plist
```

## Fire manually (smoke test)

```bash
# any date:
cd ~/Documents/Apps/grain && npx tsx scripts/network-pulse-morning.ts

# specific date:
npx tsx scripts/network-pulse-morning.ts 2026-04-28

# via launchd:
launchctl kickstart -k gui/$(id -u)/com.benlangsfeld.network-pulse
```

## Prerequisites on Mac Studio

- `.env.local` in `~/Documents/Apps/grain/` with: `GRANOLA_API_KEY`, `GRAIN_ANTHROPIC_KEY` (or `ANTHROPIC_API_KEY`), `SLACK_USER_TOKEN`, `MY_SLACK_USER_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`.
- `.google-tokens.json` in `~/Documents/Apps/grain/` — copy from laptop. Without it, Calendar + Gmail return "(unavailable)" and the synthesis still runs against Granola + Slack only.

## Logs

- Stdout: `~/Library/Logs/network-pulse.log`
- Stderr: `~/Library/Logs/network-pulse.err.log`

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.benlangsfeld.network-pulse.plist
rm ~/Library/LaunchAgents/com.benlangsfeld.network-pulse.plist
```

---

# Migrated cron jobs (Vercel Hobby workaround)

`com.benlangsfeld.grain-cron-*.plist` are 11 launchd jobs that fire on schedule and `curl` the corresponding Vercel route. They replace the Vercel-side cron scheduling for routes that exceeded the Hobby 2-cron limit.

The route handlers themselves remain on Vercel — only the trigger is local. Mac Studio is always-on, has no cron count limit, no frequency limit, and no DST hassle worth caring about (±1 hour drift on UTC is fine for these jobs).

## What stays on Vercel

`vercel.json` declares only 2 crons (the Hobby-allowed maximum):
- `/api/ingest/granola` — daily 11:30 UTC
- `/api/cron/closure-sync` — daily 12:45 UTC

Both are pure API-to-API, no vault dependency, no heavy LLM. They're the "safe" two.

## What moved local (11 plists)

| Plist | Route | Local schedule |
|---|---|---|
| `grain-cron-daily` | `/api/cron/daily` | M-F 08:03 |
| `grain-cron-weekly` | `/api/cron/weekly` | Sat 22:17 |
| `grain-cron-weekly-lint` | `/api/cron/weekly-lint` | Mon 10:00 |
| `grain-cron-grain-steward` | `/api/cron/grain-steward` (Guy) | daily 08:53 |
| `grain-cron-ea` | `/api/cron/ea` (Buddy) | daily 09:07 |
| `grain-cron-security-steward` | `/api/cron/security-steward` (Dood) | daily 09:23 |
| `grain-cron-what-if` | `/api/cron/what-if` (Bruh) | Mon 10:37 |
| `grain-cron-columnist` | `/api/cron/columnist` (Clark) | Wed 10:47 |
| `grain-cron-notion-steward` | `/api/cron/notion-steward` (Timi) | Mon 10:27 |
| `grain-cron-buddy-surface` | `/api/cron/buddy-surface` | Mon 09:15 |
| `grain-cron-pulse` | `/api/cron/pulse` | Tue/Fri 12:00 |

## How they work

Each plist runs `scripts/cron-curl.sh /api/cron/<name>`. The helper:
1. Sources `~/Documents/Apps/grain/.env.local` to load `CRON_SECRET`.
2. Curls the Vercel route with `Authorization: Bearer $CRON_SECRET`.
3. Retries twice on connection refused, 290s max-time (Vercel functions cap at 300s).

## Install all 11

```bash
# Copy plists into LaunchAgents
cp ~/Documents/Apps/grain/scripts/launchd/com.benlangsfeld.grain-cron-*.plist ~/Library/LaunchAgents/

# Bootstrap each into the user's launchd domain
for plist in ~/Library/LaunchAgents/com.benlangsfeld.grain-cron-*.plist; do
  launchctl bootstrap gui/$(id -u) "$plist"
done

# Verify they registered
launchctl list | grep grain-cron
```

## Smoke-test one cron manually

```bash
# Direct invocation — fastest way to verify CRON_SECRET works
~/Documents/Apps/grain/scripts/cron-curl.sh /api/cron/grain-steward

# Via launchd kickstart
launchctl kickstart -k gui/$(id -u)/com.benlangsfeld.grain-cron-grain-steward
```

## Logs

- `~/Library/Logs/grain-cron-<name>.log` — stdout
- `~/Library/Logs/grain-cron-<name>.err.log` — stderr

## Regenerate plists after schedule changes

Edit `CRONS=(...)` in `scripts/launchd/generate-cron-plists.sh`, then:

```bash
bash ~/Documents/Apps/grain/scripts/launchd/generate-cron-plists.sh
# then re-bootstrap any plists whose schedules changed
```

## Uninstall all 11

```bash
for plist in ~/Library/LaunchAgents/com.benlangsfeld.grain-cron-*.plist; do
  launchctl bootout gui/$(id -u) "$plist" 2>/dev/null || true
  rm "$plist"
done
```

## Prerequisites on Mac Studio

- `~/Documents/Apps/grain/.env.local` must contain `CRON_SECRET` (pulled via `vercel env pull --environment=production`)
- `vercel` CLI installed (`bun add -g vercel`) and project linked (`vercel link --project grain`)
- Mac Studio always-on (Energy Saver: prevent automatic sleeping)
