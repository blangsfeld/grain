/**
 * Appendix to archive-source-legacy: export commitment_labels (the 21
 * hand-labeled training rows) joined with their commitment statements, so
 * the training signal is preserved outside the DB before we delete the
 * legacy commitments.
 *
 * Drops two files into the current-day archive directory:
 *   commitment_labels.jsonl — full joined rows, one per line
 *   TRAINING_LABELS.md       — human-readable table for eyeball review
 *
 * Idempotent — overwrites both files on re-run.
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });

import { existsSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { getSupabaseAdmin } from "@/lib/supabase";

function archiveDir(): string {
  const stamp = new Date().toISOString().split("T")[0].replace(/-/g, "");
  return join(process.cwd(), "archive", `source-v2-legacy-${stamp}`);
}

async function main() {
  const dir = archiveDir();
  if (!existsSync(dir)) {
    console.error(`No archive directory at ${dir}. Run --mode=export first.`);
    process.exit(1);
  }

  const db = getSupabaseAdmin();

  // Pull labels with their commitment context. The classifier uses
  // statement + weight + reason as training signal; the meeting context
  // adds interpretability.
  const { data: labels, error: le } = await db
    .from("commitment_labels")
    .select("*");
  if (le) throw new Error(`labels query: ${le.message}`);
  const labelRows = labels ?? [];
  console.log(`commitment_labels rows: ${labelRows.length}`);

  const ids = labelRows.map((r) => r.commitment_id as string);
  const { data: comms, error: ce } = await db
    .from("dx_commitments")
    .select("id, statement, person, category, meeting_title, meeting_date, status, transcript_id")
    .in("id", ids);
  if (ce) throw new Error(`commitments query: ${ce.message}`);

  const commById = new Map<string, (typeof comms)[number]>(
    (comms ?? []).map((c) => [c.id as string, c]),
  );

  const joined = labelRows.map((l) => {
    const c = commById.get(l.commitment_id as string);
    return {
      ...l, // preserve every label column the DB has
      statement: c?.statement ?? null,
      person: c?.person ?? null,
      category: c?.category ?? null,
      meeting_title: c?.meeting_title ?? null,
      meeting_date: c?.meeting_date ?? null,
      status: c?.status ?? null,
      transcript_id: c?.transcript_id ?? null,
    };
  });

  const jsonlPath = join(dir, "commitment_labels.jsonl");
  writeFileSync(jsonlPath, "");
  for (const row of joined) appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
  console.log(`  ✓ ${jsonlPath}`);

  // Human-readable markdown table, grouped by weight so the training
  // signal is legible at a glance.
  const byWeight = new Map<string, typeof joined>();
  for (const r of joined) {
    const w = (r.weight as string) ?? "unknown";
    if (!byWeight.has(w)) byWeight.set(w, []);
    byWeight.get(w)!.push(r);
  }
  const weightOrder = ["high", "medium", "low", "skip"];
  const order = [...weightOrder.filter((w) => byWeight.has(w)), ...[...byWeight.keys()].filter((w) => !weightOrder.includes(w))];

  const md: string[] = [
    "# Commitment Training Labels",
    "",
    `${joined.length} hand-labeled rows from the Source v2 era. Preserved outside`,
    "the DB so the classifier's ground truth survives the legacy deletion.",
    "",
    "Labels drive Buddy's triage: `high` = real priority, `medium` = standard,",
    "`low` = nice-to-track, `skip` = scaffolding/logistics (filtered from the",
    "daily read). See `lib/agents/ea-classifier.ts`.",
    "",
  ];
  for (const w of order) {
    const rows = byWeight.get(w) ?? [];
    md.push(`## ${w} (${rows.length})`);
    md.push("");
    for (const r of rows) {
      md.push(`- **"${r.statement ?? "(missing commitment)"}"**`);
      const meta = [r.person, r.category, r.meeting_title, r.meeting_date?.slice(0, 10)]
        .filter(Boolean)
        .join(" · ");
      if (meta) md.push(`    _${meta}_`);
      if (r.reason) md.push(`    reason: ${r.reason}`);
      md.push("");
    }
  }
  const mdPath = join(dir, "TRAINING_LABELS.md");
  writeFileSync(mdPath, md.join("\n"));
  console.log(`  ✓ ${mdPath}`);

  console.log("\nLabels preserved. Safe to proceed with --mode=delete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
