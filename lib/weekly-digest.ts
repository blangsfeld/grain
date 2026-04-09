/**
 * Weekly Digest — synthesize a week of atoms into patterns + narratives.
 * Writes to Obsidian vault and optionally stores in dx_atoms as a 'read' type.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getAnthropicClient } from "@/lib/anthropic";
import { getAtomsForRange } from "@/lib/atom-db";
import { buildWeeklyDigestPrompt, WEEKLY_DIGEST_MAX_TOKENS } from "@/lib/prompts/weekly-digest";
import type {
  DxAtom,
  BeliefContent,
  TensionContent,
  QuoteContent,
  VoiceContent,
  CommitmentContent,
  ReadContent,
} from "@/types/atoms";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const WEEKLY_DIR = join(VAULT_ROOT, "40-patterns/weekly");
const MODEL = "claude-sonnet-4-20250514";

// ─── Types ───────────────────────────────────────

export interface WeeklyDigest {
  themes: string;
  tensions_in_play: string;
  beliefs_strengthening: string;
  your_voice_this_week: string;
  emerging_narratives: string;
  commitments_snapshot: string;
  open_questions: string;
}

export interface WeeklyDigestResult {
  digest: WeeklyDigest;
  atom_count: number;
  meeting_count: number;
  tokens: number;
  vault_path: string | null;
}

// ─── Generate digest ─────────────────────────────

export async function generateWeeklyDigest(
  weekStart: string, // YYYY-MM-DD (Monday)
  weekEnd: string,   // YYYY-MM-DD (Sunday)
): Promise<WeeklyDigestResult> {
  // Fetch atoms for the week
  const atoms = await getAtomsForRange(weekStart, weekEnd);
  if (atoms.length === 0) {
    return {
      digest: emptyDigest(),
      atom_count: 0,
      meeting_count: 0,
      tokens: 0,
      vault_path: null,
    };
  }

  // Format atoms for prompt
  const atomsSummary = formatAtomsForDigest(atoms);
  const meetingCount = new Set(atoms.map((a) => a.transcript_id).filter(Boolean)).size;

  // Week label
  const startDate = new Date(weekStart);
  const weekNum = getISOWeek(startDate);
  const weekLabel = `Week ${weekNum} (${formatDate(weekStart)} – ${formatDate(weekEnd)})`;

  // Generate
  const client = getAnthropicClient();
  const prompt = buildWeeklyDigestPrompt(atomsSummary, weekLabel);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: WEEKLY_DIGEST_MAX_TOKENS,
    temperature: 0.4,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const tokens = response.usage.input_tokens + response.usage.output_tokens;

  let digest: WeeklyDigest;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    digest = match ? JSON.parse(match[0]) : emptyDigest();
  } catch {
    digest = emptyDigest();
  }

  // Write to vault
  const vaultPath = writeDigestToVault(digest, weekStart, weekEnd, weekLabel, atoms.length, meetingCount);

  return { digest, atom_count: atoms.length, meeting_count: meetingCount, tokens, vault_path: vaultPath };
}

// ─── Format atoms for prompt ─────────────────────

function formatAtomsForDigest(atoms: DxAtom[]): string {
  const sections: string[] = [];

  // Group by type
  const byType: Record<string, DxAtom[]> = {};
  for (const atom of atoms) {
    if (!byType[atom.type]) byType[atom.type] = [];
    byType[atom.type].push(atom);
  }

  if (byType.belief) {
    sections.push("### BELIEFS");
    for (const a of byType.belief) {
      const c = a.content as BeliefContent;
      sections.push(`- [${c.class}/${c.confidence}] "${c.statement}" (${a.source_title}, ${a.source_date})`);
      if (c.rules_out) sections.push(`  Rules out: ${c.rules_out}`);
    }
  }

  if (byType.tension) {
    sections.push("\n### TENSIONS");
    for (const a of byType.tension) {
      const c = a.content as TensionContent;
      sections.push(`- Says: "${c.stated}" / Acts: "${c.actual}" (${a.source_title}, ${a.source_date})`);
      sections.push(`  Gap: ${c.gap}`);
    }
  }

  if (byType.quote) {
    sections.push("\n### QUOTES");
    for (const a of byType.quote) {
      const c = a.content as QuoteContent;
      sections.push(`- [${c.weight}] "${c.text}" — ${c.speaker} (${a.source_title}, ${a.source_date})`);
      sections.push(`  ${c.reasoning}`);
    }
  }

  if (byType.voice) {
    sections.push("\n### YOUR VOICE");
    for (const a of byType.voice) {
      const c = a.content as VoiceContent;
      sections.push(`- "${c.quote}" (${a.source_title}, ${a.source_date})`);
      sections.push(`  Why it works: ${c.why_it_works}`);
      sections.push(`  Use for: ${c.use_it_for}`);
    }
  }

  if (byType.commitment) {
    sections.push("\n### COMMITMENTS");
    for (const a of byType.commitment) {
      const c = a.content as CommitmentContent;
      const person = c.person ?? "Someone";
      const due = c.due_date ? ` by ${c.due_date}` : "";
      sections.push(`- [${c.conviction}] ${person}: ${c.statement}${due} (${a.source_title}, ${a.source_date})`);
    }
  }

  if (byType.read) {
    sections.push("\n### READS");
    for (const a of byType.read) {
      const c = a.content as ReadContent;
      sections.push(`**${a.source_title}** (${a.source_date}): ${c.the_read}`);
    }
  }

  return sections.join("\n");
}

// ─── Write to vault ──────────────────────────────

function writeDigestToVault(
  digest: WeeklyDigest,
  weekStart: string,
  weekEnd: string,
  weekLabel: string,
  atomCount: number,
  meetingCount: number,
): string {
  const startDate = new Date(weekStart);
  const weekNum = getISOWeek(startDate);
  const year = startDate.getFullYear();
  const filename = `${year}-W${String(weekNum).padStart(2, "0")}.md`;
  const filePath = join(WEEKLY_DIR, filename);

  const lines: string[] = [];

  lines.push("---");
  lines.push("type: weekly-digest");
  lines.push(`week: ${year}-W${String(weekNum).padStart(2, "0")}`);
  lines.push(`date_range: ${weekStart} to ${weekEnd}`);
  lines.push(`atoms: ${atomCount}`);
  lines.push(`meetings: ${meetingCount}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${weekLabel}`);
  lines.push("");

  lines.push("## Themes");
  lines.push(digest.themes);
  lines.push("");

  lines.push("## Tensions in Play");
  lines.push(digest.tensions_in_play);
  lines.push("");

  lines.push("## Beliefs Strengthening");
  lines.push(digest.beliefs_strengthening);
  lines.push("");

  lines.push("## Your Voice This Week");
  lines.push(digest.your_voice_this_week);
  lines.push("");

  lines.push("## Emerging Narratives");
  lines.push(digest.emerging_narratives);
  lines.push("");

  lines.push("## Commitments");
  lines.push(digest.commitments_snapshot);
  lines.push("");

  lines.push("## Open Questions");
  lines.push(digest.open_questions);
  lines.push("");

  ensureDir(WEEKLY_DIR);
  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ─── Helpers ─────────────────────────────────────

function emptyDigest(): WeeklyDigest {
  return {
    themes: "No atoms this week.",
    tensions_in_play: "",
    beliefs_strengthening: "",
    your_voice_this_week: "",
    emerging_narratives: "",
    commitments_snapshot: "",
    open_questions: "",
  };
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Batch: generate all weeks in a range ────────

export async function generateWeeklyDigestsBatch(
  since: string, // YYYY-MM-DD
  until: string, // YYYY-MM-DD
): Promise<WeeklyDigestResult[]> {
  const weeks = getWeekRanges(since, until);
  const results: WeeklyDigestResult[] = [];

  for (const { start, end } of weeks) {
    try {
      const result = await generateWeeklyDigest(start, end);
      results.push(result);
    } catch (err) {
      console.error(`Weekly digest failed for ${start}:`, err);
    }
  }

  return results;
}

/** Generate Monday-Sunday week ranges covering a date range. */
function getWeekRanges(since: string, until: string): Array<{ start: string; end: string }> {
  const ranges: Array<{ start: string; end: string }> = [];
  const sinceDate = new Date(since);
  const untilDate = new Date(until);

  // Find first Monday on or before since
  const current = new Date(sinceDate);
  const day = current.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  current.setDate(current.getDate() + diff);

  while (current <= untilDate) {
    const weekStart = current.toISOString().split("T")[0];
    const weekEndDate = new Date(current);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEnd = weekEndDate.toISOString().split("T")[0];

    ranges.push({ start: weekStart, end: weekEnd });

    current.setDate(current.getDate() + 7);
  }

  return ranges;
}
