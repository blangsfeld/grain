/**
 * Granola types.
 *
 * Public API types are the source of truth.
 * Legacy types kept for granola-ingest compat until full migration.
 */

// ─── Public API ──────────────────────────────────

export interface GranolaUser {
  name: string;
  email: string;
}

export interface GranolaCalendarEvent {
  event_title: string;
  organiser: string;
  calendar_event_id: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
  invitees: Array<{ email: string }>;
}

export interface GranolaNote {
  id: string;           // not_XXXXXXXXXXXXXX
  object: string;       // "note"
  title: string;
  owner: GranolaUser;
  created_at: string;
  updated_at: string;
}

export interface GranolaTranscriptEntry {
  speaker: { source: string };
  text: string;
  start_time: string;
  end_time: string;
}

export interface GranolaNoteDetail extends GranolaNote {
  calendar_event: GranolaCalendarEvent | null;
  attendees: GranolaUser[];
  folder_membership: Array<{ id: string; object: string; name: string }>;
  transcript: GranolaTranscriptEntry[] | null;
  summary_text: string;
  summary_markdown: string | null;
}

// ─── Legacy (granola-ingest compat) ──────────────

export interface GranolaDocument {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  last_viewed_panel?: { content: Record<string, unknown> };
}

export interface GranolaUtterance {
  source: "microphone" | "system";
  text: string;
  start_timestamp: string;
  end_timestamp: string;
  confidence: number;
}

export interface GranolaNotesMetadata {
  participants: string[];
  topic?: string;
}

export type GranolaConnectionStatus =
  | "unknown"
  | "connected"
  | "expired"
  | "unavailable"
  | "error";
