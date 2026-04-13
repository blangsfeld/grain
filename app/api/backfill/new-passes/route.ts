/**
 * POST /api/backfill/new-passes — Backfill decisions + relationships + participants.
 *
 * Runs the two new extraction passes on historical transcripts and
 * backfills participant data from the Granola public API.
 *
 * Usage:
 *   curl -X POST 'http://localhost:3003/api/backfill/new-passes?since=2026-03-01'
 *   curl -X POST '...?since=2026-03-01&participants_only=1'  # skip Claude, just backfill participants
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { classifyTranscript, getExtractionPlan } from "@/lib/classify";
import { extractAtoms } from "@/lib/atom-extract";
import { insertAtoms } from "@/lib/atom-db";
import { loadRegistries, resolveAtoms } from "@/lib/resolve";
import { buildBootContext } from "@/lib/vault-scan";
import { listNotes, getNote } from "@/lib/granola";
import { exportDailyHighlightsToVault } from "@/lib/vault-export";
import type { AtomPass, DxAtomInsert } from "@/types/atoms";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until") ?? new Date().toISOString().slice(0, 10);
  const force = url.searchParams.get("force") === "1";
  const participantsOnly = url.searchParams.get("participants_only") === "1";
  // Which passes to run. Default: decisions + relationships.
  // Override with ?passes=tensions or ?passes=decisions,tensions,relationships
  const passesParam = url.searchParams.get("passes");
  const targetPasses = passesParam
    ? passesParam.split(",").map((s) => s.trim()) as AtomPass[]
    : ["decisions", "relationships"] as AtomPass[];

  if (!since) {
    return NextResponse.json({ error: "Missing ?since=YYYY-MM-DD" }, { status: 400 });
  }

  const result = {
    since, until, force, participantsOnly,
    transcripts_scanned: 0,
    transcripts_processed: 0,
    transcripts_skipped: 0,
    decisions_inserted: 0,
    meta_relationships_updated: 0,
    participants_updated: 0,
    daily_rollups_reexported: 0,
    tokens_used: 0,
    errors: [] as string[],
  };

  try {
    const db = getSupabaseAdmin();

    // ── Participants-only mode: just backfill attendees from Granola API ──
    if (participantsOnly) {
      return await backfillParticipantsOnly(db, since, until, result);
    }

    // ── Full mode: extraction + participants ──
    const { contacts, domains } = await loadRegistries();

    const { data: transcripts, error } = await db
      .from("dx_transcripts")
      .select("id, source_title, source_date, transcript, meta_relationships, inbox_status")
      .gte("source_date", since)
      .lte("source_date", until)
      .eq("inbox_status", "approved")
      .order("source_date", { ascending: true });

    if (error) throw new Error(`Query failed: ${error.message}`);
    if (!transcripts?.length) return NextResponse.json({ ...result, note: "No transcripts" });

    result.transcripts_scanned = transcripts.length;
    const processedDates = new Set<string>();

    for (const tx of transcripts) {
      if (!force && tx.meta_relationships !== null) {
        result.transcripts_skipped++;
        if (tx.source_date) processedDates.add(tx.source_date);
        continue;
      }

      if (!tx.transcript || !tx.source_title || !tx.source_date) continue;

      try {
        const classification = await classifyTranscript(tx.transcript, tx.source_title);
        const plan = getExtractionPlan(classification);
        if (plan.dismiss) { result.transcripts_skipped++; continue; }

        const newPasses: AtomPass[] = plan.passes.filter(
          (p) => targetPasses.includes(p),
        );
        if (!newPasses.length) { processedDates.add(tx.source_date); continue; }

        const extraction = await extractAtoms(tx.transcript, tx.source_title, newPasses);
        result.tokens_used += extraction.tokens;

        for (const atom of extraction.atoms) {
          atom.transcript_id = tx.id;
          atom.source_title = tx.source_title;
          atom.source_date = tx.source_date;
        }

        resolveAtoms(extraction.atoms, contacts, domains);

        const metaAtoms = extraction.atoms.filter((a) => a.meta);
        const persistAtoms: DxAtomInsert[] = extraction.atoms.filter((a) => !a.meta);

        const relAtom = metaAtoms.find((a) => a.type === "relationships");
        if (relAtom) {
          await db.from("dx_transcripts")
            .update({ meta_relationships: relAtom.content })
            .eq("id", tx.id);
          result.meta_relationships_updated++;
        }

        if (persistAtoms.length > 0) {
          // On force re-run: delete existing atoms of the target types for this
          // transcript before inserting, so we don't accumulate duplicates.
          if (force) {
            const typesToReplace = [...new Set(persistAtoms.map((a) => a.type))];
            for (const t of typesToReplace) {
              await db.from("dx_atoms")
                .delete()
                .eq("transcript_id", tx.id)
                .eq("type", t);
            }
          }
          await insertAtoms(persistAtoms);
          result.decisions_inserted += persistAtoms.filter((a) => a.type === "decision").length;
        }

        processedDates.add(tx.source_date);
        result.transcripts_processed++;
      } catch (err) {
        result.errors.push(`${tx.source_title}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Re-export daily rollups (free)
    for (const date of [...processedDates].sort()) {
      try {
        const path = await exportDailyHighlightsToVault(date);
        if (path) result.daily_rollups_reexported++;
      } catch (err) {
        result.errors.push(`rollup ${date}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Rebuild boot context
    try { await buildBootContext(); } catch {}

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ...result, fatal: err instanceof Error ? err.message : err }, { status: 500 });
  }
}

// ─── Participants-only backfill ───────────────────
// Zero Claude calls. Fetches attendee data from the Granola public API
// and updates dx_transcripts.participants for each matching note.

async function backfillParticipantsOnly(
  db: ReturnType<typeof getSupabaseAdmin>,
  since: string,
  until: string,
  result: Record<string, unknown>,
): Promise<NextResponse> {
  // Get all Granola notes in range
  const notes = await listNotes(since);
  const notesInRange = notes.filter((n) => {
    const d = n.created_at.split("T")[0];
    return d >= since && d <= until;
  });

  let updated = 0;
  const errors: string[] = [];

  for (const note of notesInRange) {
    try {
      const detail = await getNote(note.id);
      const attendees = detail.attendees ?? [];
      if (!attendees.length) continue;

      const ownerEmail = detail.owner?.email;
      const filtered = attendees.filter(
        (a) => !a.email.includes("@resource.calendar.google.com"),
      );
      const participants = filtered.map((a) => ({
        name: a.name,
        email: a.email,
        is_owner: a.email === ownerEmail,
      }));

      // Find matching transcript by title + date
      const noteDate = note.created_at.split("T")[0];
      const { data: matches } = await db
        .from("dx_transcripts")
        .select("id")
        .eq("source_title", note.title)
        .eq("source_date", noteDate)
        .limit(1);

      if (matches?.length) {
        await db.from("dx_transcripts")
          .update({ participants })
          .eq("id", matches[0].id);
        updated++;
      }
    } catch (err) {
      errors.push(`${note.title}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Rebuild boot context
  try { await buildBootContext(); } catch {}

  return NextResponse.json({
    ...result,
    notes_scanned: notesInRange.length,
    participants_updated: updated,
    errors,
  });
}
