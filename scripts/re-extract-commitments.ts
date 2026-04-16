/**
 * Re-extract the commitments pass over a date range.
 *
 * Usage:
 *   npx tsx scripts/re-extract-commitments.ts              # default: last 30 days
 *   npx tsx scripts/re-extract-commitments.ts 2026-03-17   # from explicit date
 *   npx tsx scripts/re-extract-commitments.ts 2026-03-17 2026-04-10
 *
 * For each transcript in the range:
 *   1. Delete existing dx_atoms rows with type='commitment'
 *   2. Delete dx_commitments rows linked to that transcript_id (skipping any
 *      row that has a commitment_labels entry — those are training data)
 *   3. Run the commitments pass on the transcript
 *   4. insertAtoms() the new commitment atoms
 *   5. syncCommitmentsFromAtoms() to populate dx_commitments
 *
 * Skips transcripts with empty transcript text.
 */

import { config as loadDotenv } from "dotenv";
import { join } from "path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { getSupabaseAdmin } from "@/lib/supabase";
import { extractAtoms } from "@/lib/atom-extract";
import { insertAtoms } from "@/lib/atom-db";
import { syncCommitmentsFromAtoms } from "@/lib/commitments-sync";
import type { DxAtom } from "@/types/atoms";

interface TranscriptRow {
  id: string;
  source_title: string;
  source_date: string;
  transcript: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const today = new Date();
  const defaultSince = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const since = args[0] ?? defaultSince;
  const until = args[1] ?? today.toISOString().slice(0, 10);

  console.log(`Re-extracting commitments for transcripts from ${since} to ${until}`);

  const db = getSupabaseAdmin();

  // Load labeled commitment IDs so we don't delete training data
  const { data: labelRows, error: labelErr } = await db
    .from("commitment_labels")
    .select("commitment_id");
  if (labelErr) throw new Error(`commitment_labels fetch: ${labelErr.message}`);
  const labeledIds = new Set((labelRows ?? []).map((r) => r.commitment_id as string));
  console.log(`Preserving ${labeledIds.size} labeled dx_commitments row(s) as training data`);

  // Fetch transcripts in range
  const { data: transcripts, error: tErr } = await db
    .from("dx_transcripts")
    .select("id, source_title, source_date, transcript")
    .gte("source_date", since)
    .lte("source_date", until)
    .order("source_date", { ascending: true });
  if (tErr) throw new Error(`dx_transcripts fetch: ${tErr.message}`);

  const rows = (transcripts ?? []) as TranscriptRow[];
  console.log(`Found ${rows.length} transcripts in range`);

  let processed = 0;
  let totalNewAtoms = 0;
  let totalSynced = 0;
  let skippedEmpty = 0;
  let errored = 0;

  for (const t of rows) {
    if (!t.transcript || t.transcript.trim().length < 50) {
      skippedEmpty++;
      continue;
    }

    try {
      // 1. Delete existing commitment atoms for this transcript
      const { error: delAtomsErr } = await db
        .from("dx_atoms")
        .delete()
        .eq("transcript_id", t.id)
        .eq("type", "commitment");
      if (delAtomsErr) throw new Error(`delete atoms: ${delAtomsErr.message}`);

      // 2. Delete dx_commitments rows for this transcript except training rows
      const { data: existingCommits, error: fetchErr } = await db
        .from("dx_commitments")
        .select("id")
        .eq("transcript_id", t.id);
      if (fetchErr) throw new Error(`fetch commitments: ${fetchErr.message}`);

      const toDelete = (existingCommits ?? [])
        .map((r) => r.id as string)
        .filter((id) => !labeledIds.has(id));
      if (toDelete.length > 0) {
        const { error: delCommErr } = await db
          .from("dx_commitments")
          .delete()
          .in("id", toDelete);
        if (delCommErr) throw new Error(`delete commitments: ${delCommErr.message}`);
      }

      // 3. Run the commitments pass
      const extraction = await extractAtoms(t.transcript, t.source_title, ["commitments"]);
      if (extraction.atoms.length === 0) {
        console.log(`  [${t.source_date}] ${t.source_title} — 0 commitments extracted`);
        processed++;
        continue;
      }

      // 4. Attach provenance + insert
      const withProvenance = extraction.atoms.map((a) => ({
        ...a,
        transcript_id: t.id,
        source_title: t.source_title,
        source_date: t.source_date,
      }));
      const inserted: DxAtom[] = await insertAtoms(withProvenance);

      // 5. Sync to dx_commitments
      const syncRes = await syncCommitmentsFromAtoms(inserted);

      processed++;
      totalNewAtoms += inserted.length;
      totalSynced += syncRes.upserted;
      console.log(
        `  [${t.source_date}] ${t.source_title} — ${inserted.length} commitments ` +
          `(synced: ${syncRes.upserted}${syncRes.skipped_malformed > 0 ? `, malformed: ${syncRes.skipped_malformed}` : ""})`,
      );
    } catch (err) {
      errored++;
      console.error(
        `  [${t.source_date}] ${t.source_title} — ERROR:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log("");
  console.log(`Done. Processed: ${processed}, New atoms: ${totalNewAtoms}, Synced: ${totalSynced}, Empty: ${skippedEmpty}, Errored: ${errored}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
