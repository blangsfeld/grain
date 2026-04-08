/**
 * Vault Export — daily highlights + weekly digest to Obsidian.
 *
 * Daily highlights: one file per day, assembled from atoms.
 * Weekly digest: Claude synthesis across a week of atoms.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getAtomsForDate, getAtomsForRange } from "@/lib/atom-db";
import type { DxAtom, BeliefContent, TensionContent, QuoteContent, VoiceContent, CommitmentContent, ReadContent } from "@/types/atoms";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const MEETINGS_DIR = join(VAULT_ROOT, "50-meetings");
const WEEKLY_DIR = join(VAULT_ROOT, "40-patterns/weekly");

// ─── Daily highlights ────────────────────────────

export async function exportDailyHighlightsToVault(date: string): Promise<string | null> {
  const atoms = await getAtomsForDate(date);
  if (atoms.length === 0) return null;

  const filePath = join(MEETINGS_DIR, `${date}.md`);

  // Group atoms by type
  const byType = groupByType(atoms);

  // Group by source meeting
  const meetings = new Map<string, DxAtom[]>();
  for (const atom of atoms) {
    const key = atom.source_title ?? "Unknown";
    if (!meetings.has(key)) meetings.set(key, []);
    meetings.get(key)!.push(atom);
  }

  // Count by type
  const typeCounts = Object.entries(byType)
    .map(([type, items]) => `${type}: ${items.length}`)
    .join(", ");

  // Build markdown
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push("type: daily-highlights");
  lines.push(`date: ${date}`);
  lines.push(`meetings: ${meetings.size}`);
  lines.push(`atoms: ${atoms.length}`);
  lines.push("---");
  lines.push("");

  // Meetings processed
  lines.push("## Meetings");
  for (const [title, meetingAtoms] of meetings) {
    const counts = countTypes(meetingAtoms);
    lines.push(`- ${title} (${counts})`);
  }
  lines.push("");

  // Read (trajectory)
  if (byType.read?.length) {
    lines.push("## The Read");
    for (const atom of byType.read) {
      const c = atom.content as ReadContent;
      if (atom.source_title) lines.push(`**${atom.source_title}**`);
      lines.push(c.the_read);
      lines.push("");
    }
  }

  // Beliefs
  if (byType.belief?.length) {
    lines.push("## Beliefs");
    for (const atom of byType.belief) {
      const c = atom.content as BeliefContent;
      lines.push(`- "${c.statement}" (${c.class}, ${c.confidence}) — ${atom.source_title ?? ""}`);
    }
    lines.push("");
  }

  // Tensions
  if (byType.tension?.length) {
    lines.push("## Tensions");
    for (const atom of byType.tension) {
      const c = atom.content as TensionContent;
      lines.push(`- Says "${c.stated}" / Acts "${c.actual}" — ${atom.source_title ?? ""}`);
    }
    lines.push("");
  }

  // Quotes
  if (byType.quote?.length) {
    lines.push("## Quotes");
    for (const atom of byType.quote) {
      const c = atom.content as QuoteContent;
      lines.push(`- "${c.text}" (${c.weight}) — ${c.speaker}, ${atom.source_title ?? ""}`);
    }
    lines.push("");
  }

  // Your Language
  if (byType.voice?.length) {
    lines.push("## Your Language");
    for (const atom of byType.voice) {
      const c = atom.content as VoiceContent;
      lines.push(`- "${c.quote}" — ${c.why_it_works}`);
    }
    lines.push("");
  }

  // Commitments
  if (byType.commitment?.length) {
    lines.push("## Commitments");
    for (const atom of byType.commitment) {
      const c = atom.content as CommitmentContent;
      const person = c.person ?? "Someone";
      const due = c.due_date ? ` — by ${c.due_date}` : "";
      lines.push(`- **${person}** — ${c.statement}${due} (${c.conviction})`);
    }
    lines.push("");
  }

  // What wasn't said (from reads)
  const unsaidSections = byType.read
    ?.map((a) => (a.content as ReadContent).what_wasnt_said)
    .filter((s) => s && s !== "Nothing notable");
  if (unsaidSections?.length) {
    lines.push("## What Wasn't Said");
    for (const section of unsaidSections) {
      lines.push(section);
    }
    lines.push("");
  }

  // Write file
  ensureDir(MEETINGS_DIR);
  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ─── Helpers ─────────────────────────────────────

function groupByType(atoms: DxAtom[]): Record<string, DxAtom[]> {
  const grouped: Record<string, DxAtom[]> = {};
  for (const atom of atoms) {
    if (!grouped[atom.type]) grouped[atom.type] = [];
    grouped[atom.type].push(atom);
  }
  return grouped;
}

function countTypes(atoms: DxAtom[]): string {
  const counts: Record<string, number> = {};
  for (const a of atoms) {
    counts[a.type] = (counts[a.type] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`)
    .join(", ");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
