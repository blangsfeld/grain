/**
 * Signal Engine — entity accrual
 *
 * Called after atoms land (granola-ingest, url-ingest, backfill). For each
 * relevant atom + tension_slug, upserts a canonical signal_entities row
 * and appends a signal_entity_mentions row. Recomputes lifecycle state.
 *
 * v0: exact-match on canonical_key (slug for tensions, normalized text
 * for voice/belief). Embedding clustering + LLM merge judge come later.
 *
 * Non-fatal: every error is logged and swallowed. Accrual must never
 * break ingest.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type {
  DxAtom,
  RelationshipsPayload,
  VoiceContent,
  BeliefContent,
  TensionContent,
} from "@/types/atoms";

// ─── Types ──────────────────────────────────────────

export type SignalEntityType = "tension" | "voice" | "belief" | "phrase" | "topic" | "question";
export type LifecycleState =
  | "first_appearance"
  | "recurrence"
  | "crystallization"
  | "published"
  | "retired";

export interface StateTransition {
  from: LifecycleState;
  to: LifecycleState;
  at: string; // ISO date
  mention_id: string | null;
  reason: string;
}

interface SignalEntityRow {
  id: string;
  type: SignalEntityType;
  canonical_label: string;
  canonical_key: string;
  aliases: string[];
  first_seen: string;
  last_seen: string;
  mention_count: number;
  distinct_context_count: number;
  lifecycle_state: LifecycleState;
  state_transitions: StateTransition[];
  domain: string | null;
}

interface AccrualCandidate {
  type: SignalEntityType;
  canonical_label: string;
  canonical_key: string;
  raw_label: string;
  atom_id: string | null;
  domain: string | null;
}

export interface AccrueInput {
  /** Atoms inserted for this transcript (post-insertAtoms). */
  atoms: DxAtom[];
  /** meta_relationships payload from the transcript (tension_slugs live here). */
  meta: RelationshipsPayload | null;
  transcript_id: string | null;
  source_date: string;
  source_title: string | null;
  people: string[];
}

export interface AccrualSummary {
  entities_touched: number;
  new_entities: number;
  mentions_written: number;
  state_transitions: number;
  errors: string[];
}

// ─── Main ───────────────────────────────────────────

export async function accrueSignals(input: AccrueInput): Promise<AccrualSummary> {
  const summary: AccrualSummary = {
    entities_touched: 0,
    new_entities: 0,
    mentions_written: 0,
    state_transitions: 0,
    errors: [],
  };

  const candidates = buildCandidates(input);
  if (candidates.length === 0) return summary;

  const db = getSupabaseAdmin();

  for (const cand of candidates) {
    try {
      const result = await accrueOne(db, cand, input);
      summary.entities_touched++;
      if (result.created) summary.new_entities++;
      if (result.mention_written) summary.mentions_written++;
      if (result.transitioned) summary.state_transitions++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${cand.type}/${cand.canonical_key}: ${msg}`);
    }
  }

  return summary;
}

// ─── Candidate extraction ───────────────────────────

function buildCandidates(input: AccrueInput): AccrualCandidate[] {
  const out: AccrualCandidate[] = [];

  // Tensions come from meta_relationships.tension_slugs (slugs are already
  // kebab-normalized by the relationships pass). Tension atoms exist too
  // but are loosely coupled to slugs — v0 uses slugs as the entity key.
  if (input.meta?.tension_slugs?.length) {
    for (const slug of input.meta.tension_slugs) {
      if (!slug || typeof slug !== "string") continue;
      out.push({
        type: "tension",
        canonical_label: slugToReadable(slug),
        canonical_key: slug.toLowerCase().trim(),
        raw_label: slug,
        atom_id: null, // no direct foreign key from slug → atom
        domain: null,
      });
    }
  }

  // Voice atoms — Ben's compressions. These are the densest source of
  // signal per the W16 hand-craft. Canonical key = normalized text of
  // the first 100 chars of the quote.
  for (const a of input.atoms) {
    if (a.type === "voice") {
      const c = a.content as VoiceContent;
      if (!c?.quote) continue;
      const key = normalizeText(c.quote);
      if (!key) continue;
      out.push({
        type: "voice",
        canonical_label: c.quote,
        canonical_key: key,
        raw_label: c.quote,
        atom_id: a.id,
        domain: a.domain ?? null,
      });
    }
    if (a.type === "belief") {
      const c = a.content as BeliefContent;
      if (!c?.statement) continue;
      const key = normalizeText(c.statement);
      if (!key) continue;
      out.push({
        type: "belief",
        canonical_label: c.statement,
        canonical_key: key,
        raw_label: c.statement,
        atom_id: a.id,
        domain: a.domain ?? null,
      });
    }
    // Tension atoms — if present, also accrue using the `stated` field
    // as the identity surface. Keeps us indexed even when no tension_slug
    // was emitted.
    if (a.type === "tension") {
      const c = a.content as TensionContent;
      if (!c?.stated) continue;
      const key = normalizeText(c.stated);
      if (!key) continue;
      out.push({
        type: "tension",
        canonical_label: c.stated,
        canonical_key: `atom:${key}`, // namespaced so it doesn't collide with slug keys
        raw_label: c.stated,
        atom_id: a.id,
        domain: a.domain ?? null,
      });
    }
  }

  return out;
}

// ─── Per-candidate accrual ──────────────────────────

async function accrueOne(
  db: ReturnType<typeof getSupabaseAdmin>,
  cand: AccrualCandidate,
  input: AccrueInput,
): Promise<{ created: boolean; mention_written: boolean; transitioned: boolean }> {
  // 1. Find-or-create entity by (type, canonical_key).
  const { data: existing } = await db
    .from("signal_entities")
    .select("*")
    .eq("type", cand.type)
    .eq("canonical_key", cand.canonical_key)
    .maybeSingle();

  let entity: SignalEntityRow;
  let created = false;

  if (existing) {
    entity = existing as SignalEntityRow;
  } else {
    const { data: inserted, error: insertErr } = await db
      .from("signal_entities")
      .insert({
        type: cand.type,
        canonical_label: cand.canonical_label,
        canonical_key: cand.canonical_key,
        aliases: [],
        first_seen: input.source_date,
        last_seen: input.source_date,
        mention_count: 0,
        distinct_context_count: 0,
        lifecycle_state: "first_appearance" satisfies LifecycleState,
        state_transitions: [],
        domain: cand.domain,
      })
      .select("*")
      .single();
    if (insertErr || !inserted) {
      // Race condition — someone else inserted between our fetch and insert.
      // Re-fetch and continue.
      const { data: retry } = await db
        .from("signal_entities")
        .select("*")
        .eq("type", cand.type)
        .eq("canonical_key", cand.canonical_key)
        .maybeSingle();
      if (!retry) {
        throw new Error(insertErr?.message ?? "entity insert returned no row");
      }
      entity = retry as SignalEntityRow;
    } else {
      entity = inserted as SignalEntityRow;
      created = true;
    }
  }

  // 2. Write mention row.
  const { data: mention, error: mentionErr } = await db
    .from("signal_entity_mentions")
    .insert({
      entity_id: entity.id,
      atom_id: cand.atom_id,
      transcript_id: input.transcript_id,
      source_date: input.source_date,
      source_title: input.source_title,
      raw_label: cand.raw_label,
      people: input.people ?? [],
    })
    .select("id")
    .single();
  if (mentionErr || !mention) {
    throw new Error(mentionErr?.message ?? "mention insert returned no row");
  }
  const mention_id = mention.id as string;

  // 3. Recompute entity aggregates (mention_count, distinct_context_count,
  //    last_seen, first_seen, aliases) from the mentions table. Authoritative
  //    source is always the mentions log — avoids drift from race conditions.
  const { data: allMentions } = await db
    .from("signal_entity_mentions")
    .select("source_date, transcript_id, raw_label")
    .eq("entity_id", entity.id);

  const mentions = (allMentions ?? []) as Array<{
    source_date: string;
    transcript_id: string | null;
    raw_label: string;
  }>;

  const mention_count = mentions.length;
  const distinct_contexts = new Set(
    mentions.map((m) => m.transcript_id).filter((t): t is string => !!t),
  );
  const distinct_context_count = distinct_contexts.size;
  const dates = mentions.map((m) => m.source_date).sort();
  const first_seen = dates[0] ?? entity.first_seen;
  const last_seen = dates[dates.length - 1] ?? entity.last_seen;
  const aliases = computeAliases(entity.canonical_label, mentions.map((m) => m.raw_label));

  // 4. Recompute lifecycle state.
  const prev_state = entity.lifecycle_state;
  const next_state = computeLifecycleState({
    current: prev_state,
    mention_count,
    distinct_context_count,
    first_seen,
    last_seen,
  });

  const transitioned = next_state !== prev_state;
  const transitions: StateTransition[] = transitioned
    ? [
        ...(entity.state_transitions ?? []),
        {
          from: prev_state,
          to: next_state,
          at: input.source_date,
          mention_id,
          reason: transitionReason(prev_state, next_state, mention_count, distinct_context_count),
        },
      ]
    : entity.state_transitions ?? [];

  // 5. Persist aggregates.
  await db
    .from("signal_entities")
    .update({
      mention_count,
      distinct_context_count,
      first_seen,
      last_seen,
      aliases,
      lifecycle_state: next_state,
      state_transitions: transitions,
      updated_at: new Date().toISOString(),
    })
    .eq("id", entity.id);

  return { created, mention_written: true, transitioned };
}

// ─── Lifecycle state machine ────────────────────────

interface LifecycleInput {
  current: LifecycleState;
  mention_count: number;
  distinct_context_count: number;
  first_seen: string;
  last_seen: string;
}

function computeLifecycleState(input: LifecycleInput): LifecycleState {
  // Published and retired are not auto-advanced — they require external
  // signals (vault writes, 6-week silence detection from a scheduled pass).
  // This function handles first_appearance → recurrence → crystallization
  // only.
  if (input.current === "published" || input.current === "retired") return input.current;

  if (input.mention_count >= 3 && input.distinct_context_count >= 2) {
    return "crystallization";
  }
  if (input.mention_count >= 2 && input.distinct_context_count >= 2) {
    return "recurrence";
  }
  return "first_appearance";
}

function transitionReason(
  from: LifecycleState,
  to: LifecycleState,
  mention_count: number,
  distinct_context_count: number,
): string {
  return `${from}→${to} (mentions=${mention_count}, contexts=${distinct_context_count})`;
}

// ─── Helpers ────────────────────────────────────────

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function slugToReadable(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\bvs\b/g, "vs.")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function computeAliases(canonical_label: string, raw_labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const canonical = canonical_label.trim();
  for (const label of raw_labels) {
    const t = label.trim();
    if (!t || t === canonical) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 10) break; // cap to keep row small
  }
  return out;
}
