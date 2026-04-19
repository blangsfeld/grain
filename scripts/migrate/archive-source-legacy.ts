/**
 * Archive Source v2 legacy data to local files, then (optionally) delete
 * from the shared Supabase.
 *
 * Context: dx_transcripts holds records from TWO pipelines in the same
 * table — `source_type='granola'` (current Grain) and `source_type='transcript'`
 * (retired Source v2). The legacy rows have NULL source_date on 20 of 92
 * entries and leak into Keys' ORDER BY DESC results via Postgres'
 * NULLS FIRST default, fooling synthesizers into reporting Feb titles as
 * "the latest transcripts."
 *
 * Keys was patched (NULLS LAST + WHERE NOT NULL) as a hot fix. This script
 * is the durable cleanup — exports the legacy slice to a local archive,
 * verifies the export, then deletes FK-safely.
 *
 * Legacy footprint (snapshot 2026-04-18):
 *   dx_transcripts:  92 rows (20 NULL-dated, 3.3 MB text)
 *   dx_signals:     301 rows (the entire source_v2-era table is legacy)
 *   dx_atoms:       132 rows (77 commitment, 38 decision, 17 tension)
 *   dx_commitments:  98 rows (zero overlap with hand-labeled training set)
 *
 * Usage:
 *   # 1. Export only (safe — read-only + local write)
 *   npx tsx scripts/migrate/archive-source-legacy.ts --mode=export
 *
 *   # 2. Verify the archive contents by hand before deleting
 *
 *   # 3. Dry-run delete (shows what would happen, touches nothing)
 *   npx tsx scripts/migrate/archive-source-legacy.ts --mode=dry-run
 *
 *   # 4. Execute the delete (requires export to have succeeded)
 *   npx tsx scripts/migrate/archive-source-legacy.ts --mode=delete --confirm
 *
 * Archive location: archive/source-v2-legacy-YYYYMMDD/
 *   MANIFEST.md              — counts, date range, archive metadata
 *   transcripts.jsonl        — full transcripts (1 row per line)
 *   transcripts.csv          — transcripts minus `transcript` text column
 *   signals.jsonl            — dx_signals referencing legacy transcripts
 *   atoms.jsonl              — dx_atoms referencing legacy transcripts
 *   commitments.jsonl        — dx_commitments referencing legacy transcripts
 *   transcripts/YYYY-MM-DD-slug.md — one markdown per meeting for vault inspection
 *
 * Do NOT run the delete mode until:
 *   - The export archive has been reviewed
 *   - The archive directory has been copied somewhere durable (Dropbox / Git)
 *   - Keys has been tested with the NULLS LAST patch in prod
 *   - You have a fresh Supabase snapshot backup
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { getSupabaseAdmin } from "@/lib/supabase";

type Mode = "export" | "delete" | "dry-run";

// ── CLI ─────────────

function parseArgs(): { mode: Mode; confirm: boolean } {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="))?.split("=")[1];
  const confirm = args.includes("--confirm");
  if (modeArg !== "export" && modeArg !== "delete" && modeArg !== "dry-run") {
    console.error("Usage: --mode=export|delete|dry-run [--confirm]");
    process.exit(1);
  }
  return { mode: modeArg, confirm };
}

// ── Paths ─────────

function archiveDir(): string {
  const stamp = new Date().toISOString().split("T")[0].replace(/-/g, "");
  return join(process.cwd(), "archive", `source-v2-legacy-${stamp}`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

// ── Export ─────────

async function fetchLegacyTranscriptIds(): Promise<string[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("dx_transcripts")
    .select("id")
    .eq("source_type", "transcript");
  if (error) throw new Error(`fetch legacy ids: ${error.message}`);
  return (data ?? []).map((r) => r.id as string);
}

async function exportTable(
  table: string,
  filter: { in?: { column: string; values: string[] }; eq?: { column: string; value: string } },
  outDir: string,
  outName: string,
): Promise<number> {
  const db = getSupabaseAdmin();

  // Paginate in case of large tables
  const pageSize = 500;
  let offset = 0;
  let total = 0;
  const outPath = join(outDir, `${outName}.jsonl`);

  // Truncate any existing file
  writeFileSync(outPath, "");

  while (true) {
    let query = db.from(table).select("*").range(offset, offset + pageSize - 1);
    if (filter.in) query = query.in(filter.in.column, filter.in.values);
    if (filter.eq) query = query.eq(filter.eq.column, filter.eq.value);

    const { data, error } = await query;
    if (error) throw new Error(`export ${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    const lines = data.map((row) => JSON.stringify(row)).join("\n") + "\n";
    appendFileSync(outPath, lines);

    total += data.length;
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return total;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

async function exportHumanReadable(outDir: string): Promise<number> {
  const db = getSupabaseAdmin();
  const perFileDir = join(outDir, "transcripts");
  ensureDir(perFileDir);

  const { data, error } = await db
    .from("dx_transcripts")
    .select("id, source_date, source_title, source_type, transcript, participants, created_at, word_count")
    .eq("source_type", "transcript");
  if (error) throw new Error(`fetch transcripts: ${error.message}`);

  let written = 0;
  for (const row of data ?? []) {
    const date = (row.source_date as string | null) ?? (row.created_at as string).slice(0, 10);
    const title = (row.source_title as string) ?? "untitled";
    const filename = `${date}-${slugify(title)}-${String(row.id).slice(0, 8)}.md`;

    const fm = [
      "---",
      `id: ${row.id}`,
      `source_title: '${title.replace(/'/g, "''")}'`,
      `source_date: ${row.source_date ?? "null"}`,
      `source_type: ${row.source_type}`,
      `created_at: ${row.created_at}`,
      `word_count: ${row.word_count ?? 0}`,
      `participants: ${JSON.stringify(row.participants ?? [])}`,
      `archived_from: dx_transcripts (source_v2 legacy)`,
      "---",
      "",
      `# ${title}`,
      "",
      ((row.transcript as string) ?? "").trim(),
      "",
    ].join("\n");

    writeFileSync(join(perFileDir, filename), fm);
    written++;
  }

  return written;
}

async function writeManifest(outDir: string, counts: Record<string, number>): Promise<void> {
  const lines = [
    "# Source v2 Legacy Archive",
    "",
    `Archived at: ${new Date().toISOString()}`,
    `Source DB: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`,
    "",
    "## Contents",
    "",
    `- dx_transcripts: ${counts.transcripts} rows → transcripts.jsonl + transcripts/*.md`,
    `- dx_signals:     ${counts.signals} rows → signals.jsonl`,
    `- dx_atoms:       ${counts.atoms} rows → atoms.jsonl`,
    `- dx_commitments: ${counts.commitments} rows → commitments.jsonl`,
    "",
    "## Restoration",
    "",
    "Each .jsonl is one row per line, full column set. To restore into a new Supabase:",
    "",
    "```sql",
    "-- Example for transcripts:",
    "CREATE TEMP TABLE t AS SELECT * FROM dx_transcripts WHERE false;",
    "COPY t FROM 'transcripts.jsonl' WITH (FORMAT json);",
    "-- then INSERT INTO dx_transcripts SELECT * FROM t;",
    "```",
    "",
    "## Why archived",
    "",
    "Pre-Granola-public-API ingest pipeline. `source_type='transcript'` rows",
    "contaminated the shared `dx_transcripts` table with 20 NULL-dated entries",
    "whose titles misled Keys into reporting February titles as \"the latest\".",
    "Keys was patched (NULLS LAST + NOT NULL filter) and this legacy slice",
    "was moved here to remove the contamination at the source.",
    "",
    "No grain code references these rows. The 21 hand-labeled training",
    "commitments (via commitment_labels) have zero overlap with this archive.",
    "",
  ];
  writeFileSync(join(outDir, "MANIFEST.md"), lines.join("\n"));
}

async function runExport(): Promise<{ outDir: string; counts: Record<string, number> }> {
  const outDir = archiveDir();
  ensureDir(outDir);

  console.log(`Exporting to ${outDir}`);

  const legacyIds = await fetchLegacyTranscriptIds();
  console.log(`  legacy transcript ids: ${legacyIds.length}`);

  const counts: Record<string, number> = {};

  counts.transcripts = await exportTable(
    "dx_transcripts",
    { eq: { column: "source_type", value: "transcript" } },
    outDir,
    "transcripts",
  );
  console.log(`  ✓ transcripts.jsonl: ${counts.transcripts}`);

  counts.signals = await exportTable(
    "dx_signals",
    { in: { column: "transcript_id", values: legacyIds } },
    outDir,
    "signals",
  );
  console.log(`  ✓ signals.jsonl: ${counts.signals}`);

  counts.atoms = await exportTable(
    "dx_atoms",
    { in: { column: "transcript_id", values: legacyIds } },
    outDir,
    "atoms",
  );
  console.log(`  ✓ atoms.jsonl: ${counts.atoms}`);

  counts.commitments = await exportTable(
    "dx_commitments",
    { in: { column: "transcript_id", values: legacyIds } },
    outDir,
    "commitments",
  );
  console.log(`  ✓ commitments.jsonl: ${counts.commitments}`);

  const mdCount = await exportHumanReadable(outDir);
  console.log(`  ✓ transcripts/*.md: ${mdCount}`);

  await writeManifest(outDir, counts);
  console.log(`  ✓ MANIFEST.md`);

  return { outDir, counts };
}

// ── Delete ─────────
// FK order: dx_signals → dx_atoms → dx_commitments → dx_transcripts
// (children before parents)

async function runDelete(dryRun: boolean): Promise<Record<string, number>> {
  const db = getSupabaseAdmin();
  const legacyIds = await fetchLegacyTranscriptIds();
  console.log(`  legacy transcript ids: ${legacyIds.length}`);

  const counts: Record<string, number> = {};

  async function deleteWhereIn(table: string, column: string, values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    if (dryRun) {
      // Count-only probe in dry-run mode
      const { count, error } = await db
        .from(table)
        .select("*", { count: "exact", head: true })
        .in(column, values);
      if (error) throw new Error(`probe ${table}: ${error.message}`);
      return count ?? 0;
    }
    // Batch deletes to stay under query length limits
    const batchSize = 100;
    let total = 0;
    for (let i = 0; i < values.length; i += batchSize) {
      const batch = values.slice(i, i + batchSize);
      const { error, count } = await db.from(table).delete({ count: "exact" }).in(column, batch);
      if (error) throw new Error(`delete ${table}: ${error.message}`);
      total += count ?? 0;
    }
    return total;
  }

  counts.signals = await deleteWhereIn("dx_signals", "transcript_id", legacyIds);
  console.log(`  ${dryRun ? "would delete" : "deleted"} ${counts.signals} dx_signals`);

  counts.atoms = await deleteWhereIn("dx_atoms", "transcript_id", legacyIds);
  console.log(`  ${dryRun ? "would delete" : "deleted"} ${counts.atoms} dx_atoms`);

  counts.commitments = await deleteWhereIn("dx_commitments", "transcript_id", legacyIds);
  console.log(`  ${dryRun ? "would delete" : "deleted"} ${counts.commitments} dx_commitments`);

  // Final: transcripts themselves
  if (dryRun) {
    const { count, error } = await db
      .from("dx_transcripts")
      .select("*", { count: "exact", head: true })
      .eq("source_type", "transcript");
    if (error) throw new Error(`probe transcripts: ${error.message}`);
    counts.transcripts = count ?? 0;
  } else {
    const { error, count } = await db
      .from("dx_transcripts")
      .delete({ count: "exact" })
      .eq("source_type", "transcript");
    if (error) throw new Error(`delete transcripts: ${error.message}`);
    counts.transcripts = count ?? 0;
  }
  console.log(`  ${dryRun ? "would delete" : "deleted"} ${counts.transcripts} dx_transcripts`);

  return counts;
}

// ── Main ─────────

async function main() {
  const { mode, confirm } = parseArgs();
  console.log(`[archive-source-legacy] mode=${mode} confirm=${confirm}`);

  if (mode === "export") {
    const { outDir, counts } = await runExport();
    console.log("");
    console.log(`Done. Archive: ${outDir}`);
    console.log(`Totals: ${JSON.stringify(counts)}`);
    console.log("");
    console.log("Review the archive, copy somewhere durable, then run with --mode=dry-run.");
    return;
  }

  if (mode === "dry-run") {
    console.log("Dry-run — no deletes executed.");
    const counts = await runDelete(true);
    console.log("");
    console.log(`Would delete: ${JSON.stringify(counts)}`);
    return;
  }

  // mode === delete
  if (!confirm) {
    console.error("Refusing to delete without --confirm flag.");
    console.error("Re-run: --mode=delete --confirm");
    process.exit(2);
  }

  // Sanity: require a recent archive directory
  const today = archiveDir();
  if (!existsSync(today)) {
    console.error(`No archive directory for today (${today}).`);
    console.error("Run --mode=export first and verify contents before deleting.");
    process.exit(2);
  }

  const counts = await runDelete(false);
  console.log("");
  console.log(`Deleted: ${JSON.stringify(counts)}`);
  console.log("");
  console.log("Run the Keys query again to verify — legacy rows should be gone.");
}

main().catch((err) => {
  console.error("[archive-source-legacy] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
