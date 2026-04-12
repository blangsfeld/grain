/**
 * Granola client.
 *
 * Public API at https://public-api.granola.ai
 * Auth: Bearer token from GRANOLA_API_KEY env var.
 *
 * Three concerns:
 *   1. API — list notes, get detail (with attendees + transcript)
 *   2. Transcript formatting — shape raw utterances for Claude extraction
 *   3. Meeting metadata — attendees, duration, date derivation
 */

import type {
  GranolaDocument,
  GranolaUtterance,
  GranolaNotesMetadata,
  GranolaConnectionStatus,
  GranolaNote,
  GranolaNoteDetail,
  GranolaUser,
} from "@/types/granola";

// ─── API core ────────────────────────────────────

const BASE = "https://public-api.granola.ai";

async function api(path: string): Promise<Response> {
  const key = process.env.GRANOLA_API_KEY;
  if (!key) throw new Error("GRANOLA_API_KEY not set");
  return fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

// ─── Notes ───────────────────────────────────────

/** All notes created after `since` (ISO date). Handles cursor pagination. */
export async function listNotes(since: string): Promise<GranolaNote[]> {
  const notes: GranolaNote[] = [];
  let cursor: string | undefined;

  while (true) {
    const params = new URLSearchParams({ created_after: since });
    if (cursor) params.set("cursor", cursor);

    const res = await api(`/v1/notes?${params}`);
    if (!res.ok) throw new Error(`listNotes: ${res.status}`);

    const data = await res.json();
    notes.push(...((data.notes ?? []) as GranolaNote[]));

    if (!data.hasMore || !data.cursor) break;
    cursor = data.cursor;
  }

  return notes;
}

/** Single note with transcript, attendees, calendar event, summary. */
export async function getNote(id: string): Promise<GranolaNoteDetail> {
  const res = await api(`/v1/notes/${id}?include=transcript`);
  if (!res.ok) throw new Error(`getNote: ${res.status}`);
  return (await res.json()) as GranolaNoteDetail;
}

/** Attendees only. Convenience wrapper around getNote. */
export async function getAttendees(id: string): Promise<GranolaUser[]> {
  return (await getNote(id)).attendees;
}

/** Connection health check. No-throw. */
export async function checkConnection(): Promise<GranolaConnectionStatus> {
  try {
    const res = await api("/v1/notes?created_after=2099-01-01T00:00:00Z");
    if (res.ok) return "connected";
    if (res.status === 401) return "expired";
    return "error";
  } catch (e) {
    if (e instanceof Error && e.message === "GRANOLA_API_KEY not set") return "unavailable";
    return "error";
  }
}

/** Raw JSON for a single note. Debug/probe use only. */
export async function getRawDocument(id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await api(`/v1/notes/${id}?include=transcript`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Legacy adapters ─────────────────────────────
// granola-ingest.ts still imports these names. They delegate to the
// public API and map to the old shapes. Will remove once ingest is
// fully migrated to the new types.

export async function listMeetings(
  limit = 100,
  offset = 0,
): Promise<GranolaDocument[]> {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const all = await listNotes(since);
  all.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  return all.slice(offset, offset + limit).map(toDoc);
}

export async function getTranscript(id: string): Promise<GranolaUtterance[]> {
  try {
    const detail = await getNote(id);
    if (!detail.transcript?.length) return [];
    return detail.transcript.map((e) => ({
      source: (e.speaker.source === "microphone" ? "microphone" : "system") as GranolaUtterance["source"],
      text: e.text,
      start_timestamp: e.start_time,
      end_timestamp: e.end_time,
      confidence: 1,
    }));
  } catch {
    return [];
  }
}

export async function getMeetingWithNotes(id: string): Promise<GranolaDocument | null> {
  try {
    return toDoc(await getNote(id));
  } catch {
    return null;
  }
}

function toDoc(n: GranolaNote): GranolaDocument {
  return { id: n.id, title: n.title, created_at: n.created_at, updated_at: n.updated_at, workspace_id: "" };
}

/** @deprecated Attendees come from the API now. Kept for granola-ingest compat. */
export function parseNotesMetadata(): GranolaNotesMetadata {
  return { participants: [] };
}

// ─── Transcript formatting ───────────────────────

/**
 * Shape utterances into a transcript string for the extraction pipeline.
 *
 * Speaker attribution:
 *   microphone → "You:"
 *   system → participant name (if single participant) or "Them:"
 *
 * Header includes title, date, and participant names so extraction
 * prompts know who's in the room.
 */
export function formatTranscript(
  utterances: GranolaUtterance[],
  title: string,
  date: string,
  participants?: string[],
): string {
  const lines: string[] = [title, `Date: ${date}`];

  if (participants?.length) {
    lines.push(`Participants: ${participants.join(", ")}`);
  }
  lines.push("");

  const them = participants?.length === 1 ? `${participants[0]}:` : "Them:";

  for (const u of utterances) {
    lines.push(`${u.source === "microphone" ? "You:" : them} ${u.text}`);
  }

  return lines.join("\n");
}

/** Meeting date from first utterance or document created_at. */
export function deriveMeetingDate(
  utterances: GranolaUtterance[],
  documentCreatedAt: string,
): string {
  try {
    if (utterances.length > 0) return utterances[0].start_timestamp.split("T")[0];
  } catch { /* fall through */ }
  return documentCreatedAt.split("T")[0];
}

/** Duration in minutes from utterance timestamps. */
export function deriveDuration(utterances: GranolaUtterance[]): number | undefined {
  if (!utterances.length) return undefined;
  try {
    const ms = +new Date(utterances.at(-1)!.end_timestamp) - +new Date(utterances[0].start_timestamp);
    const min = Math.round(ms / 60_000);
    return min > 0 ? min : undefined;
  } catch {
    return undefined;
  }
}
