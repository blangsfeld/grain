/**
 * Signal Engine backfill — walks every transcript in order and accrues
 * its atoms into signal_entities + signal_entity_mentions. Idempotent
 * at the mention level isn't possible without a dedup key, so the
 * canonical approach is: truncate the two tables first (optional --reset
 * flag), then backfill clean.
 *
 * Usage:
 *   npx tsx scripts/signals-backfill.ts                    # backfill all history
 *   npx tsx scripts/signals-backfill.ts --since=2026-01-01 # from a date
 *   npx tsx scripts/signals-backfill.ts --reset            # truncate first
 *   npx tsx scripts/signals-backfill.ts --reset --since=2026-02-01
 *
 * Runs transcripts chronologically so lifecycle state transitions
 * accumulate in the correct order.
 */

import { config as loadDotenv } from "dotenv";
import { join } from "path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { getSupabaseAdmin } from "@/lib/supabase";
import { accrueSignals } from "@/lib/signal-engine/accrue";
import type { DxAtom, RelationshipsPayload } from "@/types/atoms";

interface Args {
  since: string | null;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { since: null, reset: false };
  for (const a of argv) {
    if (a === "--reset") args.reset = true;
    else if (a.startsWith("--since=")) args.since = a.slice("--since=".length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getSupabaseAdmin();

  if (args.reset) {
    console.log("Resetting signal_entity_mentions and signal_entities...");
    // Delete mentions first (FK); then entities.
    const { error: mErr } = await db
      .from("signal_entity_mentions")
      .delete()
      .gte("created_at", "1970-01-01");
    if (mErr) throw new Error(`mentions delete failed: ${mErr.message}`);
    const { error: eErr } = await db
      .from("signal_entities")
      .delete()
      .gte("created_at", "1970-01-01");
    if (eErr) throw new Error(`entities delete failed: ${eErr.message}`);
    console.log("  cleared.");
  }

  // Pull transcripts in chronological order. We paginate manually in case
  // the corpus grows past Supabase's 1000-row default.
  let q = db
    .from("dx_transcripts")
    .select("id, source_title, source_date, participants, meta_relationships")
    .order("source_date", { ascending: true });
  if (args.since) q = q.gte("source_date", args.since);

  const txRows: Array<{
    id: string;
    source_title: string | null;
    source_date: string;
    participants: Array<{ name: string; email: string; is_owner: boolean }> | null;
    meta_relationships: RelationshipsPayload | null;
  }> = [];

  const pageSize = 500;
  let offset = 0;
  while (true) {
    const { data, error } = await (args.since
      ? db
          .from("dx_transcripts")
          .select("id, source_title, source_date, participants, meta_relationships")
          .gte("source_date", args.since)
          .order("source_date", { ascending: true })
          .range(offset, offset + pageSize - 1)
      : db
          .from("dx_transcripts")
          .select("id, source_title, source_date, participants, meta_relationships")
          .order("source_date", { ascending: true })
          .range(offset, offset + pageSize - 1));
    if (error) throw new Error(`transcripts fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    txRows.push(...(data as typeof txRows));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`Processing ${txRows.length} transcripts...`);

  // Running totals
  let entities_touched = 0;
  let new_entities = 0;
  let mentions_written = 0;
  let state_transitions = 0;
  let tx_processed = 0;
  let tx_with_errors = 0;

  for (const tx of txRows) {
    // Fetch atoms for this transcript
    const { data: atomsData, error: atomsErr } = await db
      .from("dx_atoms")
      .select("*")
      .eq("transcript_id", tx.id)
      .eq("archived", false);
    if (atomsErr) {
      console.error(`  [${tx.source_date}] ${tx.source_title}: atoms fetch failed — skipping`);
      tx_with_errors++;
      continue;
    }

    const atoms = (atomsData ?? []) as DxAtom[];
    const people = (tx.participants ?? [])
      .filter((p) => !p.is_owner && !p.email?.includes("@resource.calendar.google.com"))
      .map((p) => p.name);

    const summary = await accrueSignals({
      atoms,
      meta: tx.meta_relationships,
      transcript_id: tx.id,
      source_date: tx.source_date,
      source_title: tx.source_title,
      people,
    });

    entities_touched += summary.entities_touched;
    new_entities += summary.new_entities;
    mentions_written += summary.mentions_written;
    state_transitions += summary.state_transitions;
    tx_processed++;

    if (summary.errors.length > 0) {
      tx_with_errors++;
      console.error(
        `  [${tx.source_date}] ${tx.source_title}: ${summary.errors.length} accrual error(s)`,
      );
      for (const e of summary.errors.slice(0, 3)) console.error(`    ${e}`);
    }

    // Periodic progress
    if (tx_processed % 25 === 0) {
      console.log(
        `  ${tx_processed}/${txRows.length} transcripts — ${new_entities} entities, ${mentions_written} mentions, ${state_transitions} transitions`,
      );
    }
  }

  console.log();
  console.log("=== Backfill complete ===");
  console.log(`Transcripts processed:  ${tx_processed}`);
  console.log(`Transcripts w/ errors:  ${tx_with_errors}`);
  console.log(`Entities created:       ${new_entities}`);
  console.log(`Entity updates:         ${entities_touched - new_entities}`);
  console.log(`Mentions written:       ${mentions_written}`);
  console.log(`State transitions:      ${state_transitions}`);

  // Lifecycle-state distribution report
  const { data: stateRows } = await db
    .from("signal_entities")
    .select("type, lifecycle_state");
  if (stateRows) {
    const grouped = new Map<string, number>();
    for (const r of stateRows as Array<{ type: string; lifecycle_state: string }>) {
      const key = `${r.type}/${r.lifecycle_state}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    console.log();
    console.log("Lifecycle distribution:");
    for (const [key, count] of [...grouped.entries()].sort()) {
      console.log(`  ${key.padEnd(40)} ${count}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
