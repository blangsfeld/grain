/**
 * Grain Local Orchestrator — the last-mile vault daemon.
 *
 * Vercel handles ingest, extraction, briefing generation, and agent runs.
 * Everything lands in Supabase. This script runs locally and does the
 * things Vercel can't (no filesystem): write to the Obsidian vault, push
 * vault snapshots back to Supabase, and run Milli's wiki reflection pass.
 *
 * Idempotent — safe to re-run. Self-healing — if a date was missed, it
 * backfills on the next tick instead of leaving a permanent gap.
 *
 * Triggered by launchd (com.residence.grain-local). Logs to
 * ~/Library/Logs/grain-local.log.
 *
 * Manual run: cd ~/Documents/Apps/grain && npx tsx scripts/local-orchestrator.ts
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getSupabaseAdmin } from "@/lib/supabase";
import { exportDailyHighlightsToVault } from "@/lib/vault-export";
import { archiveBriefingToVault } from "@/lib/briefing-deliver";
import { generateWeeklyDigest } from "@/lib/weekly-digest";
import { refreshCompanyPages } from "@/lib/company-pages";
import { runAndWriteWikiLibrarian } from "@/lib/agents/wiki-librarian";
import { processInbox } from "@/lib/agents/wiki-triage";
import { beat } from "@/lib/heartbeat";
import { materializeHeartbeat } from "@/lib/heartbeat-render";

// Expected cadence per orchestrator phase (hours). Orchestrator fires at
// 06:45 + 19:45 local, so 18h slack before stale.
const PHASE_CADENCE_HOURS: Record<string, number> = {
  meetings: 18,
  briefings: 18,
  "vault-snapshots": 18,
  "weekly-digest": 200,   // Mondays only
  "company-pages": 200,   // Mondays only
  "milli-triage": 18,
  milli: 18,
  "heartbeat-sync": 18,
};

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const MEETINGS_DIR = join(VAULT_ROOT, "50-meetings");
const BRIEFINGS_DIR = join(VAULT_ROOT, "30-decisions/briefings");
const SELF_HEAL_DAYS = 14;

// Inline the same vault_snapshots logic as scripts/sync-vault.ts so the
// orchestrator is a single entry point.
import { readFileSync, readdirSync } from "fs";

type SnapshotKind =
  | "wiki_index"
  | "wiki_pages"
  | "project_summaries"
  | "active_priorities"
  | "recent_decisions"
  | "boot_context";

interface PhaseReport {
  phase: string;
  ok: boolean;
  summary: string;
  ms: number;
}

async function phase(name: string, fn: () => Promise<string>): Promise<PhaseReport> {
  const start = Date.now();
  try {
    const summary = await fn();
    const ms = Date.now() - start;
    console.log(`[${name}] OK (${ms}ms) — ${summary}`);
    // Mark as 'attention' if the phase ran pathologically long (>10 min for normal,
    // >30 min for weekly phases). Catches the 98-min meetings hang.
    const slowThreshold = PHASE_CADENCE_HOURS[name] && PHASE_CADENCE_HOURS[name] > 50 ? 30 * 60_000 : 10 * 60_000;
    const status = ms > slowThreshold ? "attention" : "ok";
    await beat({
      source: `orchestrator.${name}`,
      status,
      summary: status === "attention" ? `${summary} (slow: ${Math.round(ms / 1000)}s)` : summary,
      cadenceHours: PHASE_CADENCE_HOURS[name],
      metadata: { wall_ms: ms },
    });
    return { phase: name, ok: true, summary, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${name}] FAIL (${ms}ms) — ${msg}`);
    await beat({
      source: `orchestrator.${name}`,
      status: "failure",
      summary: msg.slice(0, 200),
      cadenceHours: PHASE_CADENCE_HOURS[name],
      metadata: { wall_ms: ms },
    });
    return { phase: name, ok: false, summary: msg, ms };
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().split("T")[0];
}

// ── Phase 1: Meeting highlights (14-day self-heal) ────

const PER_DAY_TIMEOUT_MS = 90_000; // 90s per day — stops a single hung fetch from
                                    // stalling the whole 14-day loop (the 2026-04-18
                                    // 98-minute hang that prompted heartbeat).

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function syncMeetingHighlights(): Promise<string> {
  const written: string[] = [];
  const skipped: string[] = [];
  const timedOut: string[] = [];

  for (let i = 1; i <= SELF_HEAL_DAYS; i++) {
    const date = daysAgo(i);
    const target = join(MEETINGS_DIR, `${date}.md`);
    if (existsSync(target)) {
      skipped.push(date);
      continue;
    }
    try {
      const path = await withTimeout(
        exportDailyHighlightsToVault(date),
        PER_DAY_TIMEOUT_MS,
        `exportDailyHighlightsToVault(${date})`,
      );
      if (path) written.push(date);
    } catch (err) {
      timedOut.push(date);
      console.error(`  [meetings] ${date} skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  const timedOutNote = timedOut.length > 0 ? `, timed out ${timedOut.length} (${timedOut.join(", ")})` : "";
  return `wrote ${written.length} (${written.join(", ") || "none"}), skipped ${skipped.length} existing${timedOutNote}`;
}

// ── Phase 2: Briefings (pull unseen from Supabase) ────

interface BriefingRow {
  type: "daily" | "monday_exec";
  title: string;
  content: string;
  token_count: number;
  time_range_start: string;
  metadata: { event_count?: number; mode?: string } | null;
}

async function syncBriefings(): Promise<string> {
  const db = getSupabaseAdmin();
  const sinceIso = new Date(Date.now() - SELF_HEAL_DAYS * 86_400_000).toISOString();

  const { data, error } = await db
    .from("dx_briefings")
    .select("type, title, content, token_count, time_range_start, metadata")
    .in("type", ["daily", "monday_exec"])
    .gte("time_range_start", sinceIso)
    .order("time_range_start", { ascending: false })
    .limit(50);

  if (error) throw new Error(`briefings query: ${error.message}`);
  if (!data || data.length === 0) return "no briefings in window";

  const written: string[] = [];
  const skipped: string[] = [];

  // Keep only the most recent row per date (guards against regenerated briefings).
  const byDate = new Map<string, BriefingRow>();
  for (const row of data as BriefingRow[]) {
    const date = row.time_range_start.split("T")[0];
    if (!byDate.has(date)) byDate.set(date, row);
  }

  for (const [date, row] of byDate) {
    const mode = row.type === "monday_exec" ? "monday" : "daily";
    const filename = mode === "monday" ? `${date}-monday.md` : `${date}.md`;
    const target = join(BRIEFINGS_DIR, filename);

    if (existsSync(target)) {
      skipped.push(date);
      continue;
    }

    const path = archiveBriefingToVault({
      content: row.content,
      date,
      mode,
      tokens: row.token_count ?? 0,
      eventCount: row.metadata?.event_count ?? 0,
    });
    if (path) written.push(date);
  }

  return `wrote ${written.length} (${written.join(", ") || "none"}), skipped ${skipped.length} existing`;
}

// ── Phase 3: Vault → Supabase snapshots (for Keys) ────

async function syncVaultToSupabase(): Promise<string> {
  const db = getSupabaseAdmin();

  async function upsert(kind: SnapshotKind, content: string, metadata: Record<string, unknown> = {}) {
    const { error } = await db
      .from("vault_snapshots")
      .upsert(
        { kind, content, metadata, updated_at: new Date().toISOString() },
        { onConflict: "kind" },
      );
    if (error) throw new Error(`upsert ${kind}: ${error.message}`);
  }

  function readIfExists(p: string): string | null {
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  }

  const kinds: SnapshotKind[] = [];

  // Wiki index
  const wikiIndex = readIfExists(join(VAULT_ROOT, "60-reference/wiki/index.md"));
  if (wikiIndex) {
    await upsert("wiki_index", wikiIndex, { source: "60-reference/wiki/index.md" });
    kinds.push("wiki_index");
  }

  // Wiki pages
  const wikiRoot = join(VAULT_ROOT, "60-reference/wiki");
  if (existsSync(wikiRoot)) {
    const pages: Array<{ slug: string; category: string; content: string }> = [];
    for (const dir of ["how-tos", "patterns", "capabilities"]) {
      const dirPath = join(wikiRoot, dir);
      if (!existsSync(dirPath)) continue;
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".md")) continue;
        pages.push({
          slug: file.replace(/\.md$/, ""),
          category: dir,
          content: readFileSync(join(dirPath, file), "utf-8"),
        });
      }
    }
    if (pages.length > 0) {
      const combined = pages.map((p) => `## ${p.slug} (${p.category})\n\n${p.content}`).join("\n\n---\n\n");
      await upsert("wiki_pages", combined, { page_count: pages.length });
      kinds.push("wiki_pages");
    }
  }

  // Project summaries
  const projectsDir = join(VAULT_ROOT, "10-projects");
  if (existsSync(projectsDir)) {
    const summaries: string[] = [];
    for (const file of readdirSync(projectsDir)) {
      if (!file.endsWith(".md")) continue;
      const content = readFileSync(join(projectsDir, file), "utf-8");
      summaries.push(`## ${file.replace(/\.md$/, "")}\n\n${content.slice(0, 800)}\n`);
    }
    if (summaries.length > 0) {
      await upsert("project_summaries", summaries.join("\n---\n\n"), { project_count: summaries.length });
      kinds.push("project_summaries");
    }
  }

  // Active priorities
  const priorities = readIfExists(join(VAULT_ROOT, "70-agents/active-priorities.md"));
  if (priorities) {
    await upsert("active_priorities", priorities);
    kinds.push("active_priorities");
  }

  // Recent decisions (last 30 days)
  const decisionsDir = join(VAULT_ROOT, "30-decisions");
  if (existsSync(decisionsDir)) {
    const cutoff = daysAgo(30);
    const recent: string[] = [];
    for (const file of readdirSync(decisionsDir).sort().reverse()) {
      if (!file.endsWith(".md")) continue;
      if (file.slice(0, 10) < cutoff) break;
      const content = readFileSync(join(decisionsDir, file), "utf-8");
      recent.push(`## ${file.replace(/\.md$/, "")}\n\n${content.slice(0, 600)}\n`);
    }
    if (recent.length > 0) {
      await upsert("recent_decisions", recent.join("\n---\n\n"), { decision_count: recent.length });
      kinds.push("recent_decisions");
    }
  }

  // Boot context
  const boot = readIfExists(join(VAULT_ROOT, "70-agents/boot-context.md"));
  if (boot) {
    await upsert("boot_context", boot);
    kinds.push("boot_context");
  }

  return kinds.length > 0 ? `synced ${kinds.join(", ")}` : "nothing to sync";
}

// ── Phase 4: Weekly digest (Mondays) ────

async function syncWeeklyDigest(): Promise<string> {
  const today = new Date();
  // Last Monday → last Sunday (complete week ending yesterday)
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - 7);
  const lastSunday = new Date(today);
  lastSunday.setDate(today.getDate() - 1);

  const weekStart = lastMonday.toISOString().split("T")[0];
  const weekEnd = lastSunday.toISOString().split("T")[0];

  const result = await generateWeeklyDigest(weekStart, weekEnd);
  if (!result.vault_path) return `no digest (${result.intel.meeting_count} meetings in range)`;
  return `wrote ${result.vault_path} (${result.intel.atom_count} atoms, ${result.tokens} tokens)`;
}

// ── Phase 5: Company pages (Mondays) ────

async function syncCompanyPages(): Promise<string> {
  const pages = await refreshCompanyPages();
  const updated = pages.filter((p) => p.updated);
  return `${updated.length}/${pages.length} updated: ${updated.map((p) => p.name).join(", ") || "none"}`;
}

// ── Phase 6a: Milli triage (process 00-inbox) ────

async function runMilliTriage(): Promise<string> {
  const t = await processInbox();
  const slugs = t.details
    .filter((d) => d.status === "processed" && d.slug)
    .map((d) => d.slug)
    .slice(0, 5)
    .join(", ");
  const detail = slugs ? ` (${slugs})` : "";
  return `scanned=${t.scanned} processed=${t.processed}${detail} review=${t.review} errors=${t.errors}`;
}

// ── Phase 6b: Milli reflection (daily) ────

async function runMilli(): Promise<string> {
  const { output_id, report } = await runAndWriteWikiLibrarian();
  return `severity=${report.severity} pages=${report.facts.total_pages} inbox=${report.facts.inbox} broken=${report.facts.broken_links} orphans=${report.facts.orphans} output=${output_id}`;
}

// ── Phase 7: Heartbeat → vault ────
// Render 70-agents/heartbeat.md from the pulse ledger so the vault shows
// what's alive, what's stale, and what failed. Runs last so it reflects
// this tick's phase pulses.

async function runHeartbeatSync(): Promise<string> {
  const res = await materializeHeartbeat();
  if (!res.ok) throw new Error(res.reason ?? "materialize failed");
  return `${res.pulses} pulses, ${res.anomalies} anomalies`;
}

// ── Main ────

async function main() {
  if (!existsSync(VAULT_ROOT)) {
    console.error(`[orchestrator] vault not found at ${VAULT_ROOT} — aborting`);
    process.exit(1);
  }

  const isMonday = new Date().getDay() === 1;
  console.log(`[orchestrator] run start ${new Date().toISOString()} (monday=${isMonday})`);

  const reports: PhaseReport[] = [];

  reports.push(await phase("meetings", syncMeetingHighlights));
  reports.push(await phase("briefings", syncBriefings));
  reports.push(await phase("vault-snapshots", syncVaultToSupabase));

  if (isMonday) {
    reports.push(await phase("weekly-digest", syncWeeklyDigest));
    reports.push(await phase("company-pages", syncCompanyPages));
  }

  reports.push(await phase("milli-triage", runMilliTriage));
  reports.push(await phase("milli", runMilli));
  reports.push(await phase("heartbeat-sync", runHeartbeatSync));

  const failed = reports.filter((r) => !r.ok);
  const total = reports.reduce((s, r) => s + r.ms, 0);

  console.log(`[orchestrator] done (${total}ms) — ${reports.length - failed.length}/${reports.length} ok`);

  if (failed.length > 0) {
    console.error(`[orchestrator] failures: ${failed.map((f) => f.phase).join(", ")}`);
    process.exit(2); // launchd will log but won't retry-loop on this
  }
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
