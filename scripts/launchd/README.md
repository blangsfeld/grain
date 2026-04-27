# Grain local daemon

`com.residence.grain-local.plist` is the launchd job that runs `scripts/local-orchestrator.ts` twice a day (06:45 and 19:45 local) to sync Supabase ↔ Obsidian vault.

Vercel handles ingest, extraction, briefings, and agent runs. Everything lands in Supabase. The orchestrator does the last mile Vercel can't: write to the local vault, push vault snapshots back to Supabase for Keys, run Milli's wiki reflection.

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
