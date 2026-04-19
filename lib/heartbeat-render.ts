/**
 * Heartbeat → markdown renderer.
 *
 * Reads all pulses, classifies freshness, groups by prefix, and writes a
 * glanceable page to 70-agents/heartbeat.md. Called by sync-vault and the
 * local orchestrator's final phase.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readAllPulses, freshness, glanceIcon, ageString, type Pulse } from "@/lib/heartbeat";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const AGENTS_DIR = join(VAULT_ROOT, "70-agents");
const HEARTBEAT_PATH = join(AGENTS_DIR, "heartbeat.md");

// Friendly labels for known source slugs — agents have personas, crons have roles.
const SOURCE_LABEL: Record<string, string> = {
  "agent.grain-steward": "Guy · pipeline",
  "agent.ea": "Buddy · EA",
  "agent.security-steward": "Dood · security",
  "agent.what-if": "Bruh · what-if",
  "agent.columnist": "Clark · columnist",
  "agent.wiki-librarian": "Milli · wiki",
  "agent.notion-steward": "Timi · Notion",
  "agent.wrap-steward": "Wrap",
  "cron.granola-ingest": "Granola ingest",
  "cron.daily-briefing": "Daily briefing",
  "cron.monday-exec-briefing": "Monday exec briefing",
  "cron.weekly-digest": "Weekly digest",
  "cron.company-pages": "Company pages",
  "cron.weekly-lint": "Weekly vault lint",
  "cron.buddy-surface": "Buddy surface (promote/close)",
  "orchestrator.meetings": "Orchestrator · meetings",
  "orchestrator.briefings": "Orchestrator · briefings",
  "orchestrator.vault-snapshots": "Orchestrator · vault snapshots",
  "orchestrator.weekly-digest": "Orchestrator · weekly digest",
  "orchestrator.company-pages": "Orchestrator · company pages",
  "orchestrator.milli-triage": "Orchestrator · milli triage",
  "orchestrator.milli": "Orchestrator · milli lint",
  "orchestrator.heartbeat-sync": "Orchestrator · heartbeat sync",
  "telegram.desk": "Keys · Telegram desk",
};

function labelFor(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

interface Bucket {
  title: string;
  prefix: string;
}

const BUCKETS: Bucket[] = [
  { title: "Critical paths — ingest + briefings", prefix: "cron." },
  { title: "Agents", prefix: "agent." },
  { title: "Local orchestrator phases", prefix: "orchestrator." },
  { title: "Interfaces", prefix: "telegram." },
];

function cleanSummary(raw: string | null): string {
  if (!raw) return "";
  // Collapse any newlines + multiple spaces, strip heading markers, cap length.
  // Defense against summaries that accidentally carry multi-line markdown.
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^#+\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 140);
}

function formatRow(pulse: Pulse, now: Date): string {
  const icon = glanceIcon(pulse, now);
  const label = labelFor(pulse.source);
  const age = ageString(pulse, now);
  const lastRun = new Date(pulse.last_run_at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const fresh = freshness(pulse, now);
  const cadenceNote = pulse.expected_cadence_hours
    ? fresh === "stale"
      ? ` — **stale** (expected every ${formatCadence(pulse.expected_cadence_hours)})`
      : ""
    : "";
  const summary = cleanSummary(pulse.summary);
  const summaryPart = summary ? ` — ${summary}` : "";
  return `- ${icon} **${label}** · ${age} (${lastRun})${cadenceNote}${summaryPart}`;
}

function formatCadence(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function buildMarkdown(pulses: Pulse[], now: Date): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("grain_managed: true");
  lines.push("type: heartbeat");
  lines.push(`generated_at: ${now.toISOString()}`);
  lines.push("---");
  lines.push("");
  lines.push("# Grain Heartbeat");
  lines.push("");
  lines.push("_Instrument panel. One row per autonomous component. Absence of a fresh pulse = that component didn't run._");
  lines.push("");

  // Anomalies at top — anything not ✓
  const anomalies = pulses.filter((p) => glanceIcon(p, now) !== "✓");
  if (anomalies.length > 0) {
    lines.push(`## ⚠ Needs attention (${anomalies.length})`);
    lines.push("");
    for (const p of anomalies) lines.push(formatRow(p, now));
    lines.push("");
  } else {
    lines.push("## ✓ All components fresh");
    lines.push("");
  }

  // Bucketed sections
  for (const bucket of BUCKETS) {
    const items = pulses.filter((p) => p.source.startsWith(bucket.prefix));
    if (items.length === 0) continue;
    lines.push(`## ${bucket.title}`);
    lines.push("");
    for (const p of items) lines.push(formatRow(p, now));
    lines.push("");
  }

  // Unknown-prefix pulses (catch-all so nothing gets hidden)
  const knownPrefixes = BUCKETS.map((b) => b.prefix);
  const other = pulses.filter((p) => !knownPrefixes.some((pref) => p.source.startsWith(pref)));
  if (other.length > 0) {
    lines.push("## Other");
    lines.push("");
    for (const p of other) lines.push(formatRow(p, now));
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Generated ${now.toISOString()} · ${pulses.length} pulses_`);
  return lines.join("\n") + "\n";
}

export interface MaterializeResult {
  ok: boolean;
  pulses: number;
  anomalies: number;
  path: string | null;
  reason?: string;
}

/**
 * Render heartbeat markdown to string (no filesystem write).
 */
export async function renderHeartbeat(): Promise<{ markdown: string; pulses: Pulse[]; anomalies: number }> {
  const pulses = await readAllPulses();
  const now = new Date();
  const markdown = buildMarkdown(pulses, now);
  const anomalies = pulses.filter((p) => glanceIcon(p, now) !== "✓").length;
  return { markdown, pulses, anomalies };
}

/**
 * Write heartbeat.md to the vault. Non-fatal on missing vault (returns ok=false).
 */
export async function materializeHeartbeat(): Promise<MaterializeResult> {
  const { markdown, pulses, anomalies } = await renderHeartbeat();

  if (!existsSync(VAULT_ROOT)) {
    return { ok: false, pulses: pulses.length, anomalies, path: null, reason: "vault not found" };
  }
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });

  writeFileSync(HEARTBEAT_PATH, markdown, "utf-8");
  return { ok: true, pulses: pulses.length, anomalies, path: HEARTBEAT_PATH };
}
