/**
 * Sync commitment atoms → dx_commitments.
 *
 * Background (2026-04-16): grain's extraction pipeline writes commitment atoms
 * to dx_atoms, but Buddy reads from dx_commitments. For months those two
 * tables drifted — dx_atoms accumulated hundreds of commitment atoms while
 * dx_commitments held 21 legacy rows from the old co-work task. This module
 * closes the loop: after every ingest, commitment atoms are upserted into
 * dx_commitments using `atom.id = dx_commitments.id` so they stay linked to
 * their source, and the structured columns are available for queries and
 * the Notion promotion flow.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { DxAtom, CommitmentContent } from "@/types/atoms";

export interface CommitmentsSyncResult {
  upserted: number;
  skipped_non_commitment: number;
  skipped_malformed: number;
}

function isCommitmentContent(c: unknown): c is CommitmentContent {
  if (!c || typeof c !== "object") return false;
  const r = c as Record<string, unknown>;
  return typeof r.statement === "string" && typeof r.type === "string";
}

/**
 * Claude occasionally emits the literal string "null" instead of JSON null
 * when the prompt says `"due_date": "YYYY-MM-DD or null"`. Coerce defensively.
 */
function coerceNullable(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  return s;
}

/**
 * Upsert commitment atoms into dx_commitments.
 *
 * `atoms` may include non-commitment atoms; those are skipped. Status for
 * new rows defaults to 'open' via the column default — we don't send it on
 * upsert so that existing rows keep their manually-set status.
 */
export async function syncCommitmentsFromAtoms(
  atoms: DxAtom[],
): Promise<CommitmentsSyncResult> {
  const result: CommitmentsSyncResult = {
    upserted: 0,
    skipped_non_commitment: 0,
    skipped_malformed: 0,
  };

  const commitments = atoms.filter((a) => a.type === "commitment");
  result.skipped_non_commitment = atoms.length - commitments.length;

  const rows: Array<Record<string, unknown>> = [];
  for (const atom of commitments) {
    if (!isCommitmentContent(atom.content)) {
      result.skipped_malformed++;
      continue;
    }
    const c = atom.content;
    rows.push({
      id: atom.id,
      statement: c.statement,
      type: c.type,
      person: coerceNullable(c.person),
      company: coerceNullable(c.company),
      project: coerceNullable(c.project),
      category: coerceNullable(c.category),
      due_date: coerceNullable(c.due_date),
      transcript_id: atom.transcript_id ?? null,
      meeting_title: atom.source_title ?? null,
      meeting_date: atom.source_date ?? null,
    });
  }

  if (rows.length === 0) return result;

  const db = getSupabaseAdmin();
  // Upsert by id. Existing rows keep status + any manual edits (Buddy never
  // overwrites status on re-sync). New rows get the column default 'open'.
  const { error, count } = await db
    .from("dx_commitments")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: false, count: "exact" });

  if (error) throw new Error(`syncCommitmentsFromAtoms upsert: ${error.message}`);
  result.upserted = count ?? rows.length;
  return result;
}

/**
 * Backfill helper: pull all commitment atoms from dx_atoms for a date range
 * and sync them to dx_commitments.
 */
export async function backfillCommitmentsFromAtoms(
  since: string,
  until?: string,
): Promise<CommitmentsSyncResult & { atom_count: number }> {
  const db = getSupabaseAdmin();
  let q = db
    .from("dx_atoms")
    .select("*")
    .eq("type", "commitment")
    .gte("source_date", since)
    .order("source_date", { ascending: true });
  if (until) q = q.lte("source_date", until);

  const { data, error } = await q;
  if (error) throw new Error(`backfillCommitmentsFromAtoms query: ${error.message}`);

  const atoms = (data ?? []) as DxAtom[];
  const result = await syncCommitmentsFromAtoms(atoms);
  return { ...result, atom_count: atoms.length };
}
