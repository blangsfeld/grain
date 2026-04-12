/**
 * GET /api/cron/weekly-lint — Vault health lint.
 *
 * Runs Monday at 14:00 UTC. Scans all grain-managed entity directories,
 * flags stale/overdue/dormant/orphaned/malformed entities, and writes a
 * report to 70-agents/vault-health.md.
 *
 * On Vercel (no vault filesystem): returns the report as JSON only.
 */

import { NextRequest, NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const maxDuration = 300;

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");

function vaultAvailable(): boolean {
  return existsSync(VAULT_ROOT);
}

const TENSIONS_DIR = join(VAULT_ROOT, "50-tensions");
const LOOPS_DIR = join(VAULT_ROOT, "50-loops");
const PEOPLE_DIR = join(VAULT_ROOT, "20-network/people");
const ORGS_DIR = join(VAULT_ROOT, "20-network/companies");
const DECISIONS_DIR = join(VAULT_ROOT, "30-decisions");
const AGENTS_DIR = join(VAULT_ROOT, "70-agents");
const HEALTH_PATH = join(AGENTS_DIR, "vault-health.md");

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const report = runLint();
    const markdown = buildReport(report);

    if (vaultAvailable()) {
      if (!existsSync(AGENTS_DIR)) {
        const { mkdirSync } = await import("fs");
        mkdirSync(AGENTS_DIR, { recursive: true });
      }
      writeFileSync(HEALTH_PATH, markdown, "utf-8");
    }

    return NextResponse.json({ ok: true, report, vault_written: vaultAvailable() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── Lint categories ──────────────────────────────

interface LintReport {
  generated_at: string;
  stale_tensions: string[];        // last_evidence_at > 30 days ago
  overdue_loops: string[];         // deadline past + status: open
  dormant_people: string[];        // last_seen > 60 days ago
  orphaned_pages: string[];        // zero inbound wikilinks
  unresolved_tentative_decisions: string[];  // tentative + created > 14 days ago
  unmanaged_files: string[];       // entity path, no grain_managed: true
  malformed_managed_files: string[]; // grain_managed: true but no Evidence markers
}

function runLint(): LintReport {
  const today = new Date().toISOString().slice(0, 10);
  const report: LintReport = {
    generated_at: new Date().toISOString(),
    stale_tensions: [],
    overdue_loops: [],
    dormant_people: [],
    orphaned_pages: [],
    unresolved_tentative_decisions: [],
    unmanaged_files: [],
    malformed_managed_files: [],
  };

  if (!vaultAvailable()) return report;

  // ── Build orphan detection index ─────────────────
  // Single pass over all vault *.md files; count inbound [[slug]] wikilinks.
  const inboundCount = buildInboundIndex();

  // ── Tensions ─────────────────────────────────────
  const thirtyDaysAgo = offsetDate(today, -30);
  scanDir(TENSIONS_DIR, (slug, filePath, fm) => {
    if (!fm) { report.unmanaged_files.push(filePath); return; }
    if (fm.grain_managed !== true) { report.unmanaged_files.push(filePath); return; }
    if (!hasMarkers(filePath)) { report.malformed_managed_files.push(filePath); return; }
    const evidence = (fm.last_evidence_at as string) || "";
    if (evidence && evidence < thirtyDaysAgo) {
      report.stale_tensions.push(slug);
    }
    if ((inboundCount.get(slug) ?? 0) === 0) {
      report.orphaned_pages.push(filePath);
    }
  });

  // ── Loops ─────────────────────────────────────────
  scanDir(LOOPS_DIR, (slug, filePath, fm) => {
    if (!fm) { report.unmanaged_files.push(filePath); return; }
    if (fm.grain_managed !== true) { report.unmanaged_files.push(filePath); return; }
    if (!hasMarkers(filePath)) { report.malformed_managed_files.push(filePath); return; }
    if (fm.status === "open" && fm.deadline && (fm.deadline as string) < today) {
      report.overdue_loops.push(slug);
    }
    if ((inboundCount.get(slug) ?? 0) === 0) {
      report.orphaned_pages.push(filePath);
    }
  });

  // ── People ────────────────────────────────────────
  const sixtyDaysAgo = offsetDate(today, -60);
  scanDir(PEOPLE_DIR, (slug, filePath, fm) => {
    if (!fm) { report.unmanaged_files.push(filePath); return; }
    if (fm.grain_managed !== true) { report.unmanaged_files.push(filePath); return; }
    if (!hasMarkers(filePath)) { report.malformed_managed_files.push(filePath); return; }
    const lastSeen = (fm.last_seen as string) || "";
    if (lastSeen && lastSeen < sixtyDaysAgo) {
      report.dormant_people.push(slug);
    }
    if ((inboundCount.get(slug) ?? 0) === 0) {
      report.orphaned_pages.push(filePath);
    }
  });

  // ── Orgs ──────────────────────────────────────────
  scanDir(ORGS_DIR, (slug, filePath, fm) => {
    if (!fm) { report.unmanaged_files.push(filePath); return; }
    if (fm.grain_managed !== true) { report.unmanaged_files.push(filePath); return; }
    if (!hasMarkers(filePath)) { report.malformed_managed_files.push(filePath); return; }
    if ((inboundCount.get(slug) ?? 0) === 0) {
      report.orphaned_pages.push(filePath);
    }
  });

  // ── Decisions ─────────────────────────────────────
  const fourteenDaysAgo = offsetDate(today, -14);
  scanDir(DECISIONS_DIR, (slug, filePath, fm) => {
    if (!fm) { report.unmanaged_files.push(filePath); return; }
    if (fm.grain_managed !== true) { report.unmanaged_files.push(filePath); return; }
    if (!hasMarkers(filePath)) { report.malformed_managed_files.push(filePath); return; }
    // Date prefix in decision filename: YYYY-MM-DD-slug
    const datePrefix = slug.slice(0, 10);
    if (
      fm.confidence === "tentative" &&
      datePrefix < fourteenDaysAgo
    ) {
      report.unresolved_tentative_decisions.push(slug);
    }
    if ((inboundCount.get(slug) ?? 0) === 0) {
      report.orphaned_pages.push(filePath);
    }
  });

  return report;
}

// ─── Orphan detection (single-pass wikilink scan) ──

function buildInboundIndex(): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(VAULT_ROOT)) return counts;

  const WIKILINK_RE = /\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g;

  function scanFile(filePath: string, selfSlug: string): void {
    try {
      const content = readFileSync(filePath, "utf-8");
      for (const match of content.matchAll(WIKILINK_RE)) {
        const target = match[1];
        if (target === selfSlug) continue; // ignore self-references
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    } catch { /* ignore unreadable files */ }
  }

  function walkDir(dir: string): void {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const slug = entry.name.replace(/\.md$/, "");
          scanFile(full, slug);
        }
      }
    } catch { /* ignore permission errors */ }
  }

  walkDir(VAULT_ROOT);
  return counts;
}

// ─── Helpers ─────────────────────────────────────

type FmValue = string | boolean | null | string[];

function parseFm(filePath: string): Record<string, FmValue> | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
    if (!match) return null;
    const fm: Record<string, FmValue> = {};
    for (const line of match[1].split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const raw = line.slice(colon + 1).trim();
      if (!key) continue;
      if (raw === "true") fm[key] = true;
      else if (raw === "false") fm[key] = false;
      else if (raw === "null" || raw === "") fm[key] = null;
      else fm[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    return fm;
  } catch {
    return null;
  }
}

function hasMarkers(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes("<!-- grain:begin -->") && content.includes("<!-- grain:end -->");
  } catch { return false; }
}

function scanDir(
  dir: string,
  cb: (slug: string, filePath: string, fm: Record<string, FmValue> | null) => void,
): void {
  if (!existsSync(dir)) return;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(dir, f);
      const slug = f.replace(/\.md$/, "");
      cb(slug, filePath, parseFm(filePath));
    }
  } catch { /* ignore */ }
}

function offsetDate(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Report builder ───────────────────────────────

function buildReport(report: LintReport): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push("grain_managed: true");
  lines.push("type: lint-report");
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push("---");
  lines.push("");

  function section(title: string, items: string[], emptyNote: string): void {
    lines.push(`## ${title}`);
    if (items.length === 0) {
      lines.push(`_${emptyNote}_`);
    } else {
      for (const item of items.sort()) {
        lines.push(`- ${item}`);
      }
    }
    lines.push("");
  }

  section("Stale Tensions (no evidence > 30 days)", report.stale_tensions, "none");
  section("Overdue Loops (deadline passed, status: open)", report.overdue_loops, "none");
  section("Dormant People (last seen > 60 days)", report.dormant_people, "none");
  section("Unresolved Tentative Decisions (> 14 days old)", report.unresolved_tentative_decisions, "none");
  section("Orphaned Pages (zero inbound wikilinks)", report.orphaned_pages, "none");
  section("Unmanaged Existing Files (skipped + logged)", report.unmanaged_files, "none");
  section("Malformed Managed Files (grain_managed but no Evidence markers)", report.malformed_managed_files, "none");

  return lines.join("\n");
}
