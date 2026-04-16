/**
 * Granola Auto-Ingest — the autonomous pipeline.
 *
 * Polls Granola for new meetings, classifies, extracts atoms,
 * resolves entities, stores to dx_atoms.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  listMeetings,
  getTranscript,
  getNote,
  formatTranscript,
  deriveMeetingDate,
} from "@/lib/granola";
import { classifyTranscript, getExtractionPlan } from "@/lib/classify";
import { extractAtoms } from "@/lib/atom-extract";
import { insertAtoms } from "@/lib/atom-db";
import { syncCommitmentsFromAtoms } from "@/lib/commitments-sync";
import { loadRegistries, resolveAtoms } from "@/lib/resolve";
import { buildBootContext } from "@/lib/vault-scan";

// ─── Sync state ──────────────────────────────────
// Local: .granola-sync.json file
// Vercel (read-only fs): Supabase dx_config

const SYNC_PATH = join(process.cwd(), ".granola-sync.json");
const SYNC_DB_KEY = "granola_sync_state";

interface SyncState {
  last_synced_at: string;
}

function isDeployed(): boolean {
  return !!process.env.VERCEL || !!process.env.GRAIN_DEPLOYED;
}

async function readSyncState(): Promise<SyncState | null> {
  if (isDeployed()) {
    try {
      const db = getSupabaseAdmin();
      const { data } = await db
        .from("dx_config")
        .select("value")
        .eq("key", SYNC_DB_KEY)
        .single();
      return (data?.value as SyncState) ?? null;
    } catch {
      return null;
    }
  }
  try {
    if (!existsSync(SYNC_PATH)) return null;
    return JSON.parse(readFileSync(SYNC_PATH, "utf-8"));
  } catch {
    return null;
  }
}

async function writeSyncState(state: SyncState): Promise<void> {
  // Always write to Supabase when available (durable)
  try {
    const db = getSupabaseAdmin();
    await db.from("dx_config").upsert({ key: SYNC_DB_KEY, value: state }, { onConflict: "key" });
  } catch {}

  // Also write local file when possible (faster read on dev)
  if (!isDeployed()) {
    try {
      writeFileSync(SYNC_PATH, JSON.stringify(state, null, 2), "utf-8");
    } catch {}
  }
}

// ─── Transcript hashing (dedup) ──────────────────

function hashTranscript(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

// ─── Ingest result ───────────────────────────────

export interface IngestResult {
  processed: number;
  skipped: number;
  dismissed: number;
  atom_counts: Record<string, number>;
  total_atoms: number;
  total_tokens: number;
  meetings: Array<{
    title: string;
    date: string;
    atoms: number;
    status: "extracted" | "dismissed" | "skipped" | "error";
  }>;
}

// ─── Main ingest ─────────────────────────────────

export async function ingestFromGranola(options?: {
  since?: string;
  backfill?: boolean;
  force?: boolean;      // Skip dedup — re-extract even if transcript exists
}): Promise<IngestResult> {
  const db = getSupabaseAdmin();

  // Determine start date
  const syncState = await readSyncState();
  const since = options?.since ?? syncState?.last_synced_at ?? new Date(Date.now() - 7 * 86400000).toISOString();

  // Load entity registries once
  const { contacts, domains } = await loadRegistries();

  // Fetch meetings from Granola (newest first, so we paginate until we pass `since`)
  const allMeetings = await fetchMeetingsSince(since);

  const result: IngestResult = {
    processed: 0,
    skipped: 0,
    dismissed: 0,
    atom_counts: {},
    total_atoms: 0,
    total_tokens: 0,
    meetings: [],
  };

  // Process chronologically (oldest first)
  allMeetings.reverse();

  for (const meeting of allMeetings) {
    try {
      // Fetch transcript
      const utterances = await getTranscript(meeting.id);
      if (utterances.length === 0) {
        result.skipped++;
        result.meetings.push({ title: meeting.title, date: meeting.created_at.split("T")[0], atoms: 0, status: "skipped" });
        continue;
      }

      // Get attendees from Granola's calendar data
      const noteDetail = await getNote(meeting.id);
      const ownerEmail = noteDetail.owner?.email;
      // Filter out meeting rooms (@resource.calendar.google.com) and the owner
      const attendees = (noteDetail.attendees ?? []).filter(
        (a) => !a.email.includes("@resource.calendar.google.com"),
      );
      const participantNames = attendees
        .filter((a) => a.email !== ownerEmail)
        .map((a) => a.name);
      // Structured participants for DB persistence (includes owner, excludes rooms)
      const participants = attendees.map((a) => ({
        name: a.name,
        email: a.email,
        is_owner: a.email === ownerEmail,
      }));

      // Format transcript
      const meetingDate = deriveMeetingDate(utterances, meeting.created_at);
      const transcript = formatTranscript(utterances, meeting.title, meetingDate, participantNames);

      // Dedup check — reuse existing transcript or create new
      const hash = hashTranscript(transcript);
      const { data: existing } = await db
        .from("dx_transcripts")
        .select("id")
        .eq("transcript_hash", hash)
        .single();

      if (existing && !options?.force) {
        result.skipped++;
        result.meetings.push({ title: meeting.title, date: meetingDate, atoms: 0, status: "skipped" });
        continue;
      }

      // Reuse existing transcript_id or create new
      let transcriptId: string;
      if (existing) {
        transcriptId = existing.id;
        // Always update participants on re-encounter (they may have been missing)
        await db.from("dx_transcripts")
          .update({ participants })
          .eq("id", transcriptId);
      } else {
        const { data: txRecord, error: txError } = await db
          .from("dx_transcripts")
          .insert({
            source_title: meeting.title,
            source_date: meetingDate,
            source_type: "granola",
            transcript: transcript.trim(),
            transcript_hash: hash,
            word_count: transcript.split(/\s+/).length,
            inbox_status: "approved",
            participants,
          })
          .select("id")
          .single();
        if (txError) throw new Error(`Transcript insert failed: ${txError.message}`);
        transcriptId = txRecord.id;
      }

      // Classify
      const classification = await classifyTranscript(transcript, meeting.title);
      const plan = getExtractionPlan(classification);

      if (plan.dismiss) {
        result.dismissed++;
        result.meetings.push({ title: meeting.title, date: meetingDate, atoms: 0, status: "dismissed" });
        continue;
      }

      // Multi-pass extraction
      const extraction = await extractAtoms(transcript, meeting.title, plan.passes);

      // Stamp metadata on atoms
      for (const atom of extraction.atoms) {
        atom.transcript_id = transcriptId;
        atom.source_title = meeting.title;
        atom.source_date = meetingDate;
      }

      // Resolve entities (meta atoms participate in resolve so their
      // contact_ids/domain are computed before they're filtered out)
      resolveAtoms(extraction.atoms, contacts, domains);

      // Split meta atoms from persist atoms. Meta atoms never hit dx_atoms;
      // their payload is persisted to dedicated columns on dx_transcripts.
      const metaAtoms = extraction.atoms.filter((a) => a.meta);
      const persistAtoms = extraction.atoms.filter((a) => !a.meta);

      // Persist the relationships meta atom payload to dx_transcripts.
      // On --force re-ingest this overwrites (not merges) — intentional.
      const relationshipsAtom = metaAtoms.find((a) => a.type === "relationships");
      if (relationshipsAtom) {
        const { error: metaError } = await db
          .from("dx_transcripts")
          .update({ meta_relationships: relationshipsAtom.content })
          .eq("id", transcriptId);
        if (metaError) {
          console.error(
            `meta_relationships update failed for "${meeting.title}":`,
            metaError.message,
          );
        }
      }

      // Insert atoms (meta atoms excluded)
      const inserted = await insertAtoms(persistAtoms);

      // Mirror commitment atoms into dx_commitments so Buddy / Notion promote
      // have a structured row to query. Failures here must not fail the ingest
      // — the atoms landed; sync can be retried by the backfill script.
      try {
        const res = await syncCommitmentsFromAtoms(inserted);
        if (res.skipped_malformed > 0) {
          console.warn(
            `commitments-sync: ${res.skipped_malformed} malformed atom(s) for "${meeting.title}"`,
          );
        }
      } catch (err) {
        console.error(
          `commitments-sync failed for "${meeting.title}":`,
          err instanceof Error ? err.message : err,
        );
      }

      // Tally
      result.processed++;
      result.total_atoms += extraction.atoms.length;
      result.total_tokens += extraction.tokens;
      for (const [pass, count] of Object.entries(extraction.pass_results)) {
        result.atom_counts[pass] = (result.atom_counts[pass] ?? 0) + count;
      }
      result.meetings.push({ title: meeting.title, date: meetingDate, atoms: extraction.atoms.length, status: "extracted" });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Ingest error for "${meeting.title}":`, errMsg);
      result.meetings.push({
        title: meeting.title,
        date: meeting.created_at.split("T")[0],
        atoms: 0,
        status: "error",
        error: errMsg,
      } as typeof result.meetings[0]);
    }
  }

  // Post-loop: rebuild boot context from DB. Failures never roll back DB state.
  if (result.processed > 0) {
    try {
      await buildBootContext();
    } catch (err) {
      console.error("buildBootContext failed:", err instanceof Error ? err.message : err);
    }
  }

  // Update sync state with a 30-minute grace window.
  // Granola transcripts take minutes to finalize after a meeting ends —
  // meetings whose transcript was still processing during this run need a
  // second chance on the next run, so don't advance past them.
  const GRACE_WINDOW_MS = 30 * 60 * 1000;
  const syncTimestamp = new Date(Date.now() - GRACE_WINDOW_MS).toISOString();
  await writeSyncState({ last_synced_at: syncTimestamp });

  return result;
}

// ─── Fetch meetings since date ───────────────────

async function fetchMeetingsSince(since: string): Promise<Array<{ id: string; title: string; created_at: string }>> {
  const sinceDate = new Date(since).getTime();
  const meetings: Array<{ id: string; title: string; created_at: string }> = [];

  let offset = 0;
  const limit = 50;
  const MAX_OFFSET = 2000; // safety ceiling — never paginate past 2000 meetings

  while (offset < MAX_OFFSET) {
    const batch = await listMeetings(limit, offset);
    if (batch.length === 0) break;

    for (const doc of batch) {
      const docDate = new Date(doc.created_at).getTime();
      if (docDate >= sinceDate) {
        meetings.push({ id: doc.id, title: doc.title, created_at: doc.created_at });
      }
    }

    // If the oldest meeting in this batch is before our since date, stop paginating
    const oldestInBatch = new Date(batch[batch.length - 1].created_at).getTime();
    if (oldestInBatch < sinceDate) break;

    offset += limit;
  }

  return meetings;
}
