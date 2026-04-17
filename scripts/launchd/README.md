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
