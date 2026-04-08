/**
 * Grain Atom Types
 *
 * Each atom is a typed intelligence unit extracted from a conversation.
 * Content shape varies by type — jsonb in Supabase.
 */

// ─── Atom types ──────────────────────────────────

export type AtomType =
  | "belief"
  | "tension"
  | "quote"
  | "voice"
  | "commitment"
  | "read";

// ─── Content shapes per type ─────────────────────

export interface BeliefContent {
  statement: string;
  class: "stated" | "implied" | "aspirational";
  confidence: "strong" | "moderate" | "emerging";
  evidence: string;
  rules_out: string;
}

export interface TensionContent {
  stated: string;
  actual: string;
  gap: string;
  skepticism_trigger: string;
  breakthrough_condition: string;
}

export interface QuoteContent {
  text: string;
  speaker: string;
  weight: "high" | "medium" | "signal";
  reasoning: string;
}

export interface VoiceContent {
  quote: string;
  why_it_works: string;
  use_it_for: string;
  context: string;
}

export interface CommitmentContent {
  statement: string;
  type: "commitment" | "follow_up";
  person: string | null;
  company: string | null;
  project: string | null;
  due_date: string | null;
  conviction: "firm" | "soft" | "aspirational";
}

export interface ReadContent {
  whats_moving: string;
  whats_stuck: string;
  commitments_summary: string;
  what_wasnt_said: string;
  the_read: string;
}

export type AtomContent =
  | BeliefContent
  | TensionContent
  | QuoteContent
  | VoiceContent
  | CommitmentContent
  | ReadContent;

// ─── Database row ────────────────────────────────

export interface DxAtom {
  id: string;
  created_at: string;
  type: AtomType;
  content: AtomContent;
  transcript_id: string | null;
  source_title: string | null;
  source_date: string | null;
  entities: string[];
  domain: string | null;
  domain_id: string | null;
  contact_ids: string[];
  archived: boolean;
  saved: boolean;
}

// ─── Insert shape ────────────────────────────────

export interface DxAtomInsert {
  type: AtomType;
  content: AtomContent;
  transcript_id?: string;
  source_title?: string;
  source_date?: string;
  entities?: string[];
  domain?: string;
  domain_id?: string;
  contact_ids?: string[];
}

// ─── Extraction plan ─────────────────────────────

export type AtomPass = "read" | "quotes" | "beliefs" | "tensions" | "voice" | "commitments";

export interface ExtractionPlan {
  passes: AtomPass[];
  lens: "practitioner" | "diagnostic";
  dismiss: boolean;
}
