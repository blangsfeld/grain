/**
 * Boot brief — the consumption point for boot.
 *
 * One pre-synthesized file (70-agents/boot-brief.md) that replaces the
 * 9-file-read ritual in the /boot skill. The orchestrator regenerates
 * this each tick; boot just reads it.
 *
 * Green-silent: if heartbeat is all-fresh, no new decisions, no urgent
 * commitments, the brief is ~5 lines. Length scales with anomalies +
 * change, not every-session habit.
 */

import { homedir } from "os";
import { join } from "path";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "fs";
import { getSupabaseAdmin } from "@/lib/supabase";
import { readAllPulses, glanceIcon, ageString, type Pulse } from "@/lib/heartbeat";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const AGENTS_DIR = join(VAULT_ROOT, "70-agents");
const SESSIONS_DIR = join(AGENTS_DIR, "sessions");
const DECISIONS_DIR = join(VAULT_ROOT, "30-decisions");
const BRIEF_PATH = join(AGENTS_DIR, "boot-brief.md");

const AGENT_LABEL: Record<string, string> = {
  "agent.grain-steward": "Guy",
  "agent.ea": "Buddy",
  "agent.security-steward": "Dood",
  "agent.what-if": "Bruh",
  "agent.columnist": "Clark",
  "agent.wiki-librarian": "Milli",
  "agent.notion-steward": "Timi",
};

// ── Data gathering ─────────────────────────────────

function readFileSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function extractSection(md: string, heading: string): string | null {
  // Match a heading (## or ###) and return the block until the next heading
  // at the same-or-higher level. Preserves bullet lists verbatim.
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim().match(new RegExp(`^#{1,3}\\s+${heading}\\s*$`, "i")));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim() || null;
}

function latestSessionLog(): { filename: string; content: string } | null {
  if (!existsSync(SESSIONS_DIR)) return null;
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  const path = join(SESSIONS_DIR, files[0]);
  return { filename: files[0], content: readFileSync(path, "utf-8") };
}

function recentDecisions(days = 7): Array<{ date: string; title: string }> {
  if (!existsSync(DECISIONS_DIR)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const out: Array<{ date: string; title: string }> = [];
  for (const f of readdirSync(DECISIONS_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})[-_](.+)\.md$/);
    if (!m) continue;
    const ts = new Date(m[1]).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    const title = m[2].replace(/[-_]/g, " ");
    out.push({ date: m[1], title });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
}

async function freshAgentWhispers(hours = 72): Promise<Array<{ agent: string; summary: string; ageHours: number }>> {
  const pulses = await readAllPulses();
  const now = Date.now();
  const out: Array<{ agent: string; summary: string; ageHours: number }> = [];
  for (const p of pulses) {
    // Only surface primary agents — skip secondary pulses like
    // agent.ea.synthesis that are implementation detail, not the
    // persona output Ben thinks in.
    if (!AGENT_LABEL[p.source]) continue;
    const ageHours = (now - new Date(p.last_run_at).getTime()) / 3_600_000;
    if (ageHours > hours) continue;
    const label = AGENT_LABEL[p.source];
    const summary = (p.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    out.push({ agent: label, summary, ageHours });
  }
  return out.sort((a, b) => a.ageHours - b.ageHours);
}

interface CommitmentSnapshot {
  open: number;
  starred_open: number;
  overdue: number;
  done_7d: number;
}

async function commitmentSnapshot(): Promise<CommitmentSnapshot> {
  const sb = getSupabaseAdmin();
  const sevenAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { count: open } = await sb
    .from("dx_commitments")
    .select("*", { count: "exact", head: true })
    .eq("status", "open")
    .not("promoted_to_notion_id", "is", null);

  const { count: done7 } = await sb
    .from("dx_commitments")
    .select("*", { count: "exact", head: true })
    .eq("status", "done")
    .gte("created_at", sevenAgo);

  // "Starred" + "overdue" live on Notion Priority + Due Date. For v1 of the
  // brief we read dx_commitments.due_date since we mirror it; "starred" is
  // computed in the Notion kept list and not mirrored, so skip for now.
  const today = new Date().toISOString().slice(0, 10);
  const { count: overdue } = await sb
    .from("dx_commitments")
    .select("*", { count: "exact", head: true })
    .eq("status", "open")
    .not("promoted_to_notion_id", "is", null)
    .not("due_date", "is", null)
    .lt("due_date", today);

  return {
    open: open ?? 0,
    starred_open: 0,
    overdue: overdue ?? 0,
    done_7d: done7 ?? 0,
  };
}

// ── Pulse summary line ─────────────────────────────

function pulseSummaryLine(pulses: Pulse[]): { line: string; anomalies: Pulse[] } {
  const now = new Date();
  const anomalies = pulses.filter((p) => glanceIcon(p, now) !== "✓");
  if (anomalies.length === 0) {
    return { line: "All fresh.", anomalies: [] };
  }
  const shortLabel = (p: Pulse) => {
    const raw = p.source;
    const agentLabel = AGENT_LABEL[raw];
    if (agentLabel) return agentLabel;
    return raw.replace(/^(agent|cron|orchestrator|telegram)\./, "");
  };
  const failing = anomalies.filter((p) => p.status === "failure");
  const attention = anomalies.filter((p) => p.status !== "failure");
  const parts: string[] = [];
  if (failing.length > 0) {
    parts.push(`${failing.length} failing (${failing.map(shortLabel).join(", ")})`);
  }
  if (attention.length > 0) {
    parts.push(`${attention.length} attention (${attention.map(shortLabel).slice(0, 3).join(", ")}${attention.length > 3 ? "…" : ""})`);
  }
  return { line: parts.join(" · "), anomalies };
}

// ── Assemble ───────────────────────────────────────

export interface BootBrief {
  markdown: string;
  anomalyCount: number;
  sectionCount: number;
}

export async function assembleBootBrief(): Promise<BootBrief> {
  const now = new Date();
  const pulses = await readAllPulses();
  const { line: pulseLine, anomalies } = pulseSummaryLine(pulses);

  // Active priorities — top 3 bullets from the "What's Hot Right Now" section.
  const prioritiesMd = readFileSafe(join(AGENTS_DIR, "active-priorities.md")) ?? "";
  const hotSection = extractSection(prioritiesMd, "What's Hot Right Now") ?? "";
  const hotBullets = hotSection
    .split("\n")
    .filter((l) => /^\s*\d+\.\s+|^\s*[-*]\s+/.test(l))
    .slice(0, 3);

  // Last session handoff — pull "Next Session Starts Here" or similar.
  const lastSession = latestSessionLog();
  let handoff: string | null = null;
  let handoffFilename: string | null = null;
  if (lastSession) {
    handoffFilename = lastSession.filename;
    handoff =
      extractSection(lastSession.content, "Next Session Starts Here") ??
      extractSection(lastSession.content, "Next Up") ??
      extractSection(lastSession.content, "Open Questions");
    if (handoff) {
      // Trim to ~300 chars so it stays glance-sized.
      handoff = handoff.trim();
      if (handoff.length > 600) handoff = handoff.slice(0, 600).trim() + "…";
    }
  }

  const whispers = await freshAgentWhispers(72);
  const decisions = recentDecisions(7);
  const commitments = await commitmentSnapshot();

  // Compose.
  const lines: string[] = [];
  lines.push("---");
  lines.push("grain_managed: true");
  lines.push("type: boot-brief");
  lines.push(`generated_at: ${now.toISOString()}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Boot Brief — ${now.toISOString().slice(0, 10)}`);
  lines.push("");

  // Pulse is always present — one line.
  lines.push(`**Pulse.** ${pulseLine}`);
  lines.push("");

  // Anomaly detail only if any.
  if (anomalies.length > 0) {
    lines.push("**What's not ✓.**");
    for (const p of anomalies.slice(0, 8)) {
      const label = AGENT_LABEL[p.source] ?? p.source.replace(/^(agent|cron|orchestrator|telegram)\./, "");
      const status = p.status === "failure" ? "✗" : "⚠";
      lines.push(`- ${status} ${label} · ${ageString(p, now)} · ${(p.summary ?? "").slice(0, 100)}`);
    }
    lines.push("");
  }

  // Handoff — the single most useful continuity signal.
  if (handoff) {
    lines.push(`**Last session handoff** _(from ${handoffFilename})_`);
    lines.push("");
    lines.push(handoff);
    lines.push("");
  }

  // Hot priorities.
  if (hotBullets.length > 0) {
    lines.push("**What's hot.**");
    for (const b of hotBullets) lines.push(b.trim());
    lines.push("");
  }

  // Commitment snapshot — only render if meaningful.
  const c = commitments;
  if (c.open > 0 || c.overdue > 0 || c.done_7d > 0) {
    const parts: string[] = [`${c.open} open`];
    if (c.overdue > 0) parts.push(`**${c.overdue} overdue**`);
    if (c.done_7d > 0) parts.push(`${c.done_7d} done in 7d`);
    lines.push(`**Commitments (kept list).** ${parts.join(" · ")}`);
    lines.push("");
  }

  // Recent decisions.
  if (decisions.length > 0) {
    lines.push("**Recent decisions** _(last 7d)_");
    for (const d of decisions) lines.push(`- ${d.date} · ${d.title}`);
    lines.push("");
  }

  // Agent whispers — only if something fresh in 72h.
  if (whispers.length > 0) {
    lines.push("**Fresh agent whispers** _(last 72h)_");
    for (const w of whispers.slice(0, 7)) {
      const age = w.ageHours < 1
        ? `${Math.round(w.ageHours * 60)}m`
        : w.ageHours < 24
        ? `${Math.round(w.ageHours)}h`
        : `${Math.round(w.ageHours / 24)}d`;
      lines.push(`- ${w.agent} · ${age} · ${w.summary}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Generated ${now.toISOString()} · refresh: \`cd ~/Documents/Apps/grain && npx tsx scripts/refresh-boot-brief.ts\`_`);

  const markdown = lines.join("\n") + "\n";
  return {
    markdown,
    anomalyCount: anomalies.length,
    sectionCount:
      (hotBullets.length > 0 ? 1 : 0) +
      (handoff ? 1 : 0) +
      (decisions.length > 0 ? 1 : 0) +
      (whispers.length > 0 ? 1 : 0),
  };
}

export interface BootBriefWriteResult {
  ok: boolean;
  path: string | null;
  anomalies: number;
  sections: number;
  reason?: string;
}

export async function materializeBootBrief(): Promise<BootBriefWriteResult> {
  const brief = await assembleBootBrief();
  if (!existsSync(VAULT_ROOT)) {
    return {
      ok: false,
      path: null,
      anomalies: brief.anomalyCount,
      sections: brief.sectionCount,
      reason: "vault not found",
    };
  }
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
  writeFileSync(BRIEF_PATH, brief.markdown, "utf-8");
  return {
    ok: true,
    path: BRIEF_PATH,
    anomalies: brief.anomalyCount,
    sections: brief.sectionCount,
  };
}
