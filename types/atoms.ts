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
  | "read"
  | "decision"
  | "relationships"
  | "synthesis";

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

export type CommitmentCategory =
  | "Personal"
  | "Dunbar"
  | "Prospect"
  | "Expenses"
  | "Travel"
  | "Medical"
  | "Residence"
  | "BUCK"
  | "Wild"
  | "Giant Ant"
  | "Part+Sum"
  | "VTPro"
  | "Its Nice That"
  | "Ok Cool"
  | "CLIP"
  | "Other";

/**
 * Status values for the Notion Personal Commitments DB (kept list).
 * - Open / In Progress / Waiting / Done — the original lifecycle
 * - Recurring — exempt from close sweeps
 * - Evolved — superseded by another item (see Evolved To relation)
 * - Dormant — deliberately parked, not active, not dead
 * - Not a thing — extraction artifact; never actually Ben's intent
 */
export type PersonalCommitmentStatus =
  | "Open"
  | "In Progress"
  | "Waiting"
  | "Done"
  | "Recurring"
  | "Evolved"
  | "Dormant"
  | "Not a thing";

export const PERSONAL_COMMITMENT_STATUSES: PersonalCommitmentStatus[] = [
  "Open",
  "In Progress",
  "Waiting",
  "Done",
  "Recurring",
  "Evolved",
  "Dormant",
  "Not a thing",
];

export interface CommitmentContent {
  statement: string;
  type: "commitment" | "follow_up";
  person: string | null;
  company: string | null;
  project: string | null;
  /** Life-domain bucket matching the Notion Personal Commitments DB. */
  category: CommitmentCategory;
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

export interface DecisionContent {
  statement: string;
  type: "structural" | "strategic" | "personnel" | "product" | "financial";
  made_by: string;
  context: string;
  alternatives_considered: string | null;
  linked_tension: string | null;
  confidence: "confirmed" | "tentative";
}

/**
 * SYNTHESIS — per-meeting trajectory diagnosis.
 *
 * Mirrors the quarterly trajectory shape (Beliefs Formed/Challenged, Tensions
 * Chronic/Resolved, Commitment Patterns, Open) at single-meeting granularity.
 * Single-object payload per transcript (like `read` and `relationships`).
 *
 * `open_questions` is the structured field that feeds the `/probe` skill —
 * gaps the meeting surfaced but didn't close.
 */
export interface SynthesisContent {
  /** 1-2 sentences on what shifted in this meeting. */
  arc: string;
  /** Beliefs that emerged or strengthened. */
  beliefs_formed: string[];
  /** Beliefs that weakened, were contradicted, or got challenged. */
  beliefs_challenged: string[];
  /** Recurring tensions visible again. Same dynamics as prior meetings. */
  tensions_chronic: string[];
  /** Stuck things that got unstuck in this meeting. */
  tensions_resolved: string[];
  /** Commitments from prior meetings that were honored. */
  commitments_kept: string[];
  /** New commitments made in this meeting. */
  commitments_made: string[];
  /** Commitments past their date with no closure / quietly slipping. */
  commitments_drifting: string[];
  /** Questions raised but not answered. Gaps. The next-meeting agenda. */
  open_questions: string[];
  /** What this meeting was thick on (well-developed) vs. thin on (mentioned briefly). */
  density_signal: {
    thick_on: string[];
    thin_on: string[];
  };
}

export interface RelationshipsPayload {
  people: Array<{
    name: string;
    role: string;
    pattern_observed: string;
    psychology: string;
    tension_involved: string | null;
    energy: "generative" | "tense" | "neutral";
  }>;
  tension_slugs: string[];
  loops_opened: Array<{
    statement: string;
    owner: string;
    deadline: string | null;
    linked_tension: string | null;
  }>;
}

export type AtomContent =
  | BeliefContent
  | TensionContent
  | QuoteContent
  | VoiceContent
  | CommitmentContent
  | ReadContent
  | DecisionContent
  | RelationshipsPayload
  | SynthesisContent;

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
  /**
   * Meta atoms flow through extraction + resolve but are filtered out
   * before `insertAtoms`. Their payload is persisted elsewhere (e.g.,
   * `dx_transcripts.meta_relationships`), not into `dx_atoms`.
   */
  meta?: boolean;
}

// ─── Extraction plan ─────────────────────────────

export type AtomPass =
  | "read"
  | "quotes"
  | "beliefs"
  | "tensions"
  | "voice"
  | "commitments"
  | "decisions"
  | "relationships"
  | "synthesis";

export interface ExtractionPlan {
  passes: AtomPass[];
  lens: "practitioner" | "diagnostic";
  dismiss: boolean;
}
