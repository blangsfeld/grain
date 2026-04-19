/**
 * Sync vault content to Supabase for Keys.
 * Pushes wiki index, wiki pages, project summaries, active priorities,
 * recent decisions, and boot context into vault_snapshots table.
 *
 * Usage: cd ~/Documents/Apps/grain && npx tsx scripts/sync-vault.ts
 * Run alongside Milli, or at /boot, or standalone.
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { materializeHeartbeat } from "@/lib/heartbeat-render";

const VAULT = join(process.env.HOME || "", "Documents/Obsidian/Studio");
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type SnapshotKind = "wiki_index" | "wiki_pages" | "project_summaries" | "active_priorities" | "recent_decisions" | "boot_context";

async function upsertSnapshot(kind: SnapshotKind, content: string, metadata: Record<string, unknown> = {}) {
  const { error } = await supabase
    .from("vault_snapshots")
    .upsert({ kind, content, metadata, updated_at: new Date().toISOString() }, { onConflict: "kind" });
  if (error) console.error(`  error on ${kind}: ${error.message}`);
  else console.log(`  ✓ ${kind} (${content.length} chars)`);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

// ── Wiki index ─────────────────────────────────────
async function syncWikiIndex() {
  const content = readIfExists(join(VAULT, "60-reference/wiki/index.md"));
  if (content) await upsertSnapshot("wiki_index", content, { source: "60-reference/wiki/index.md" });
}

// ── Wiki pages (full content of how-tos, patterns, capabilities) ──
async function syncWikiPages() {
  const wikiRoot = join(VAULT, "60-reference/wiki");
  if (!existsSync(wikiRoot)) return;

  const pages: Array<{ slug: string; category: string; content: string }> = [];
  const dirs = ["how-tos", "patterns", "capabilities"];

  for (const dir of dirs) {
    const dirPath = join(wikiRoot, dir);
    if (!existsSync(dirPath)) continue;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith(".md")) continue;
      const content = readFileSync(join(dirPath, file), "utf-8");
      pages.push({ slug: file.replace(/\.md$/, ""), category: dir, content });
    }
  }

  const combined = pages.map((p) =>
    `## ${p.slug} (${p.category})\n\n${p.content}`
  ).join("\n\n---\n\n");

  await upsertSnapshot("wiki_pages", combined, { page_count: pages.length, categories: dirs });
}

// ── Project summaries ──────────────────────────────
async function syncProjectSummaries() {
  const projectsDir = join(VAULT, "10-projects");
  if (!existsSync(projectsDir)) return;

  const summaries: string[] = [];
  for (const file of readdirSync(projectsDir)) {
    if (!file.endsWith(".md")) continue;
    const full = join(projectsDir, file);
    const content = readFileSync(full, "utf-8");
    // Extract first ~800 chars (frontmatter + What It Does + Current State)
    const truncated = content.slice(0, 800);
    summaries.push(`## ${file.replace(/\.md$/, "")}\n\n${truncated}\n`);
  }

  await upsertSnapshot("project_summaries", summaries.join("\n---\n\n"), { project_count: summaries.length });
}

// ── Active priorities ──────────────────────────────
async function syncActivePriorities() {
  const content = readIfExists(join(VAULT, "70-agents/active-priorities.md"));
  if (content) await upsertSnapshot("active_priorities", content);
}

// ── Recent decisions (last 30 days by filename prefix) ──
async function syncRecentDecisions() {
  const decisionsDir = join(VAULT, "30-decisions");
  if (!existsSync(decisionsDir)) return;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const recent: string[] = [];

  for (const file of readdirSync(decisionsDir).sort().reverse()) {
    if (!file.endsWith(".md")) continue;
    const datePrefix = file.slice(0, 10);
    if (datePrefix < thirtyDaysAgo) break;
    const content = readFileSync(join(decisionsDir, file), "utf-8");
    // First 600 chars per decision
    recent.push(`## ${file.replace(/\.md$/, "")}\n\n${content.slice(0, 600)}\n`);
  }

  await upsertSnapshot("recent_decisions", recent.join("\n---\n\n"), { decision_count: recent.length });
}

// ── Boot context ───────────────────────────────────
async function syncBootContext() {
  const content = readIfExists(join(VAULT, "70-agents/boot-context.md"));
  if (content) await upsertSnapshot("boot_context", content);
}

// ── Heartbeat → vault ──────────────────────────────
// Render the instrument panel alongside snapshot sync. /boot reads this.
async function syncHeartbeat() {
  const res = await materializeHeartbeat();
  if (res.ok) {
    console.log(`  ✓ heartbeat.md (${res.pulses} pulses, ${res.anomalies} anomalies)`);
  } else {
    console.log(`  ⚠ heartbeat: ${res.reason ?? "failed"}`);
  }
}

// ── Main ───────────────────────────────────────────
async function main() {
  console.log("Syncing vault → Supabase...");
  await Promise.all([
    syncWikiIndex(),
    syncWikiPages(),
    syncProjectSummaries(),
    syncActivePriorities(),
    syncRecentDecisions(),
    syncBootContext(),
  ]);
  await syncHeartbeat();
  console.log("Done.");
}

main().catch((err) => {
  console.error("sync error:", err);
  process.exit(1);
});
