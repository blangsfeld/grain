/**
 * One-shot bulk seed — promote Ben-owned + high-weight heard-list commitments
 * into the Notion Personal Commitments DB (kept list). Auto-assigns Priority
 * so the Starred view fills with real items on first load.
 *
 * Priority heuristic:
 *   High   — due ≤ 7d (or overdue), OR Ben-owned + weight=high + aged ≤ 14d
 *   Medium — Ben-owned, not urgent
 *   Low    — high-weight "watching others" items (visible, not demanding)
 *
 * Usage:
 *   npx tsx scripts/seed-kept-list.ts --dry-run              # preview only
 *   npx tsx scripts/seed-kept-list.ts --dry-run --limit 10   # preview first 10
 *   npx tsx scripts/seed-kept-list.ts --limit 20             # seed 20
 *   npx tsx scripts/seed-kept-list.ts                        # seed everything
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { getSupabaseAdmin } from "../lib/supabase";
import { runBuddyAdd } from "../lib/agents/ea";
import { dedupCandidates } from "../lib/agents/buddy-promote";
import type { CommitmentCategory } from "../types/atoms";

const OWNER = "Ben";
const BATCH = 20;

type Priority = "High" | "Medium" | "Low";

interface Candidate {
  commitment_id: string;
  statement: string;
  person: string | null;
  category: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  weight: "high" | "medium" | "low" | "skip" | null;
  ben_attended: boolean;
  age_days: number;
}

function participantsIncludeBen(participants: unknown): boolean {
  if (!Array.isArray(participants)) return false;
  const pats = [/\bben\b/i, /langsfeld/i];
  for (const p of participants) {
    if (!p || typeof p !== "object") continue;
    const name = (p as { name?: string }).name ?? "";
    const email = (p as { email?: string }).email ?? "";
    if (pats.some((rx) => rx.test(name))) return true;
    if (/^ben@|ben\.langsfeld/i.test(email)) return true;
  }
  return false;
}

async function gather(): Promise<Candidate[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("dx_commitments")
    .select(
      `id, statement, person, category, meeting_title, meeting_date, due_date,
       transcript_id,
       commitment_labels(weight),
       dx_transcripts(participants)`,
    )
    .eq("status", "open")
    .is("promoted_at", null)
    .order("meeting_date", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`query: ${error.message}`);

  type Row = {
    id: string;
    statement: string;
    person: string | null;
    category: string | null;
    meeting_title: string | null;
    meeting_date: string | null;
    due_date: string | null;
    commitment_labels:
      | Array<{ weight: string | null }>
      | { weight: string | null }
      | null;
    dx_transcripts:
      | { participants: unknown }
      | Array<{ participants: unknown }>
      | null;
  };

  const today = Date.now();
  const out: Candidate[] = [];
  for (const row of (data ?? []) as unknown as Row[]) {
    const label = Array.isArray(row.commitment_labels)
      ? row.commitment_labels[0]
      : row.commitment_labels;
    const weight = (label?.weight ?? null) as Candidate["weight"];
    if (weight === "skip") continue;

    const transcript = Array.isArray(row.dx_transcripts)
      ? row.dx_transcripts[0]
      : row.dx_transcripts;
    const benAttended = participantsIncludeBen(transcript?.participants);

    const isBens = row.person === OWNER;
    const highWeightOthers = weight === "high" && !isBens && benAttended;
    if (!isBens && !highWeightOthers) continue;

    const meetDate = row.meeting_date
      ? new Date(row.meeting_date).getTime()
      : today;
    const age = Math.floor((today - meetDate) / 86_400_000);

    out.push({
      commitment_id: row.id,
      statement: row.statement,
      person: row.person,
      category: row.category,
      meeting_title: row.meeting_title,
      meeting_date: row.meeting_date,
      due_date: row.due_date,
      weight,
      ben_attended: benAttended,
      age_days: age,
    });
  }
  return out;
}

function scorePriority(c: Candidate): Priority {
  const today = Date.now();
  const isBens = c.person === OWNER;
  const dueTs = c.due_date ? new Date(c.due_date).getTime() : null;
  const daysUntilDue = dueTs
    ? Math.floor((dueTs - today) / 86_400_000)
    : null;

  if (daysUntilDue !== null && daysUntilDue <= 7) return "High";
  if (isBens && c.weight === "high" && c.age_days <= 14) return "High";
  if (!isBens && c.weight === "high") return "Low";
  if (isBens) return "Medium";
  return "Low";
}

const COMMITMENT_CATEGORIES: CommitmentCategory[] = [
  "Personal", "Dunbar", "Prospect", "Expenses", "Travel", "Medical",
  "Residence", "BUCK", "Wild", "Giant Ant", "Part+Sum", "VTPro",
  "Its Nice That", "Ok Cool", "CLIP", "Other",
];

function mapCategory(raw: string | null): CommitmentCategory | undefined {
  if (!raw) return undefined;
  return COMMITMENT_CATEGORIES.find(
    (c) => c.toLowerCase() === raw.toLowerCase(),
  );
}

function notesFor(c: Candidate): string {
  const bits: string[] = [];
  if (c.meeting_title) bits.push(c.meeting_title);
  if (c.meeting_date) bits.push(c.meeting_date);
  return bits.length > 0 ? `From ${bits.join(" · ")}` : "";
}

interface Group {
  canonical: Candidate;
  all_ids: string[];
  priority: Priority;
}

async function dedupAll(candidates: Candidate[]): Promise<Group[]> {
  const groups: Group[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    // buddy-promote.dedupCandidates expects its own RawCandidate shape — ours
    // is structurally identical, so the cast is safe.
    const deduped = await dedupCandidates(chunk as unknown as never);
    for (const group of deduped as unknown as Candidate[][]) {
      const sorted = [...group].sort((a, b) => a.age_days - b.age_days);
      const canonical = sorted[0];
      // When a dedup group spans Ben-owned + watching-others, the Ben-owned
      // anchor wins so the priority score picks up the correct frame.
      const bensInGroup = group.find((c) => c.person === OWNER);
      const chosenCanonical = bensInGroup ?? canonical;
      groups.push({
        canonical: chosenCanonical,
        all_ids: group.map((c) => c.commitment_id),
        priority: scorePriority(chosenCanonical),
      });
    }
  }
  return groups;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}${limit ? ` (limit ${limit})` : ""}`);

  const raw = await gather();
  console.log(`Candidates: ${raw.length}`);
  if (raw.length === 0) {
    console.log("Nothing to promote. Kept list is current.");
    return;
  }

  console.log(`Deduping in batches of ${BATCH}...`);
  const groups = await dedupAll(raw);
  console.log(`Groups after dedup: ${groups.length}`);

  const byPri = groups.reduce<Record<string, number>>((a, g) => {
    a[g.priority] = (a[g.priority] ?? 0) + 1;
    return a;
  }, {});
  console.log(`Priority split: High=${byPri.High ?? 0} Medium=${byPri.Medium ?? 0} Low=${byPri.Low ?? 0}`);

  const toWrite = limit ? groups.slice(0, limit) : groups;

  if (dryRun) {
    console.log(`\n--- Preview (first ${Math.min(toWrite.length, 20)}): ---`);
    for (const g of toWrite.slice(0, 20)) {
      const c = g.canonical;
      console.log(
        `  [${g.priority.padEnd(6)}] ${c.statement.slice(0, 90)}` +
        `\n    ${c.person ?? "?"} · ${c.meeting_title ?? "?"} · ${c.meeting_date ?? "?"} · age ${c.age_days}d${c.due_date ? ` · due ${c.due_date}` : ""}`,
      );
    }
    console.log(`\n(Dry run — nothing written. Re-run without --dry-run to seed.)`);
    return;
  }

  const sb = getSupabaseAdmin();
  let ok = 0;
  let failed = 0;
  for (const g of toWrite) {
    const c = g.canonical;
    try {
      const result = await runBuddyAdd({
        statement: c.statement,
        category: mapCategory(c.category),
        priority: g.priority,
        due_date: c.due_date ?? undefined,
        notes: notesFor(c),
        source: "Meeting",
      });
      const { error: stampErr } = await sb
        .from("dx_commitments")
        .update({
          promoted_at: new Date().toISOString(),
          promoted_to_notion_id: result.page_id,
        })
        .in("id", g.all_ids);
      if (stampErr) throw new Error(`stamp: ${stampErr.message}`);
      ok++;
      console.log(
        `  ✓ [${g.priority}] ${c.statement.slice(0, 70)} → ${result.url}`,
      );
    } catch (err) {
      failed++;
      console.log(
        `  ✗ [${g.priority}] ${c.statement.slice(0, 70)} — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  console.log(`\nDone. ok=${ok} failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
