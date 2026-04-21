/**
 * Signal Engine — nightly job
 *
 * Tier 1 (this file): plumbing that lets the next day's briefings read
 * clean substrate. Retirement, cadence, dormancy, merge judge.
 *
 * Tier 2 (separate file, later): close-the-loop, first-naming, framing
 * variance. The passes that earn the credits.
 *
 * Composer (separate file): reads the nightly run row and writes the
 * narrative to the vault. Only runs where vault is writable (Mac).
 *
 * Entry: `runNightlyTier1(runDate)` — idempotent by (run_date, status);
 * if a succeeded run already exists for the date, no-op.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import type { LifecycleState, StateTransition } from "@/lib/signal-engine/accrue";

// ─── Config ────────────────────────────────────────

/** Weeks of silence before a crystallized entity retires. */
const RETIRE_SILENCE_WEEKS = 6;
/** Multiplier over historical-median gap that triggers dormancy. */
const DORMANCY_MULTIPLIER = 2;
/** Minimum gaps required before cadence_stats are meaningful. */
const CADENCE_MIN_GAPS = 2;
/** Top N candidate merge pairs to send to LLM per run, per type. */
const MERGE_JUDGE_CANDIDATES_PER_TYPE = 8;
/** Auto-merge threshold — below this goes to review queue. */
const MERGE_AUTO_CONFIDENCE = 0.9;
/** Review-queue floor — below this is dropped. */
const MERGE_QUEUE_FLOOR = 0.7;
/** Haiku model for the merge judge — cheap, structured output. */
const MERGE_MODEL = "claude-haiku-4-5-20251001";

// ─── Types ────────────────────────────────────────

export interface NightlyTier1Result {
  run_id: string;
  run_date: string;
  retirements: Array<{ entity_id: string; type: string; label: string; last_seen: string }>;
  dormancies: Array<{ entity_id: string; type: string; label: string; last_gap_days: number; median_gap_days: number }>;
  crystallizations: Array<{ entity_id: string; type: string; label: string; mention_count: number }>;
  merges_auto: Array<{ a_id: string; b_id: string; label: string; confidence: number }>;
  merges_proposed: Array<{ a_id: string; b_id: string; a_label: string; b_label: string; confidence: number }>;
  cadence_updated: number;
  tokens_used: number;
  errors: string[];
}

interface EntityRow {
  id: string;
  type: string;
  canonical_label: string;
  canonical_key: string;
  first_seen: string;
  last_seen: string;
  mention_count: number;
  distinct_context_count: number;
  lifecycle_state: LifecycleState;
  state_transitions: StateTransition[];
  cadence_stats: CadenceStats;
  dormant_flag: boolean;
  dormant_since: string | null;
}

interface CadenceStats {
  median_gap_days?: number;
  last_gap_days?: number;
  stddev_days?: number;
  n_gaps?: number;
}

// ─── Entry ─────────────────────────────────────────

export async function runNightlyTier1(runDateISO: string): Promise<NightlyTier1Result> {
  const db = getSupabaseAdmin();

  // Idempotency: skip if a succeeded run already exists for this date
  const { data: existing } = await db
    .from("signal_nightly_runs")
    .select("id")
    .eq("run_date", runDateISO)
    .eq("status", "succeeded")
    .maybeSingle();
  if (existing) {
    throw new Error(`nightly already succeeded for ${runDateISO} (run_id=${existing.id})`);
  }

  // Create run row
  const { data: runRow, error: runErr } = await db
    .from("signal_nightly_runs")
    .insert({ run_date: runDateISO })
    .select("id")
    .single();
  if (runErr || !runRow) throw new Error(`nightly run insert failed: ${runErr?.message}`);
  const run_id = runRow.id as string;

  const result: NightlyTier1Result = {
    run_id,
    run_date: runDateISO,
    retirements: [],
    dormancies: [],
    crystallizations: [],
    merges_auto: [],
    merges_proposed: [],
    cadence_updated: 0,
    tokens_used: 0,
    errors: [],
  };

  try {
    // ── Pass 1 — cadence recompute ──────────────────
    // Walk every entity at recurrence/crystallization. Compute gaps from
    // signal_entity_mentions, store back on the entity row.
    result.cadence_updated = await recomputeCadence(db);

    // ── Pass 2 — dormancy flag ──────────────────────
    // After cadence exists, any entity whose current silence exceeds
    // 2× its historical median gets dormant_flag = true. Transition is
    // recorded inline.
    result.dormancies = await flagDormancy(db, runDateISO);

    // ── Pass 3 — retirement sweep ───────────────────
    // Crystallized entities with no mention for 6+ weeks → retired.
    result.retirements = await sweepRetirements(db, runDateISO);

    // ── Pass 4 — crystallization highlights ─────────
    // Entities that crossed into crystallization today (or whose most
    // recent state_transition lands on run_date).
    result.crystallizations = await listTodayCrystallizations(db, runDateISO);

    // ── Pass 5 — merge judge (LLM) ──────────────────
    const merge = await runMergeJudge(db, run_id);
    result.merges_auto = merge.auto;
    result.merges_proposed = merge.proposed;
    result.tokens_used += merge.tokens;
    result.errors.push(...merge.errors);

    // Persist result to run row
    await db
      .from("signal_nightly_runs")
      .update({
        completed_at: new Date().toISOString(),
        status: "succeeded",
        retirements: result.retirements,
        dormancies: result.dormancies,
        crystallizations: result.crystallizations,
        merges_auto: result.merges_auto,
        merges_proposed: result.merges_proposed,
        tokens_used: result.tokens_used,
        errors: result.errors,
      })
      .eq("id", run_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    await db
      .from("signal_nightly_runs")
      .update({
        completed_at: new Date().toISOString(),
        status: "failed",
        errors: result.errors,
      })
      .eq("id", run_id);
    throw err;
  }

  return result;
}

// ─── Pass 1 — cadence recompute ───────────────────

async function recomputeCadence(
  db: ReturnType<typeof getSupabaseAdmin>,
): Promise<number> {
  // Pull all recurrence+ entities (these are the ones cadence matters for).
  const entities = await paginate<EntityRow>(db, "signal_entities", (offset, pageSize) =>
    db
      .from("signal_entities")
      .select("id, type, canonical_label, canonical_key, first_seen, last_seen, mention_count, distinct_context_count, lifecycle_state, state_transitions, cadence_stats, dormant_flag, dormant_since")
      .in("lifecycle_state", ["recurrence", "crystallization"])
      .range(offset, offset + pageSize - 1),
  );

  let updated = 0;

  for (const entity of entities) {
    const { data: mentions } = await db
      .from("signal_entity_mentions")
      .select("source_date")
      .eq("entity_id", entity.id)
      .order("source_date", { ascending: true });

    const dates = (mentions ?? []).map((m) => m.source_date as string);
    if (dates.length < 2) continue;

    const gaps = computeGaps(dates);
    if (gaps.length < CADENCE_MIN_GAPS) continue;

    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    const stddev = Math.sqrt(variance);
    const last_gap = gaps[gaps.length - 1];

    const stats: CadenceStats = {
      median_gap_days: round1(median),
      last_gap_days: round1(last_gap),
      stddev_days: round1(stddev),
      n_gaps: gaps.length,
    };

    await db
      .from("signal_entities")
      .update({ cadence_stats: stats, updated_at: new Date().toISOString() })
      .eq("id", entity.id);

    updated++;
  }

  return updated;
}

function computeGaps(sortedDates: string[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const a = new Date(sortedDates[i - 1]).getTime();
    const b = new Date(sortedDates[i]).getTime();
    gaps.push(Math.max(0, Math.round((b - a) / 86_400_000)));
  }
  return gaps;
}

// ─── Pass 2 — dormancy flag ────────────────────────

async function flagDormancy(
  db: ReturnType<typeof getSupabaseAdmin>,
  runDateISO: string,
): Promise<NightlyTier1Result["dormancies"]> {
  const entities = await paginate<EntityRow>(db, "signal_entities", (offset, pageSize) =>
    db
      .from("signal_entities")
      .select("id, type, canonical_label, canonical_key, first_seen, last_seen, mention_count, distinct_context_count, lifecycle_state, state_transitions, cadence_stats, dormant_flag, dormant_since")
      .in("lifecycle_state", ["recurrence", "crystallization"])
      .eq("dormant_flag", false)
      .range(offset, offset + pageSize - 1),
  );

  const runDate = new Date(runDateISO);
  const flagged: NightlyTier1Result["dormancies"] = [];

  for (const entity of entities) {
    const median = entity.cadence_stats?.median_gap_days;
    if (!median || (entity.cadence_stats?.n_gaps ?? 0) < CADENCE_MIN_GAPS) continue;

    const lastSeen = new Date(entity.last_seen).getTime();
    const daysSilent = Math.round((runDate.getTime() - lastSeen) / 86_400_000);
    if (daysSilent <= median * DORMANCY_MULTIPLIER) continue;

    const transition: StateTransition = {
      from: entity.lifecycle_state,
      to: entity.lifecycle_state, // dormancy is a flag overlay, not a new state
      at: runDateISO,
      mention_id: null,
      reason: `dormancy_flag: silent ${daysSilent}d vs median ${median}d`,
    };

    await db
      .from("signal_entities")
      .update({
        dormant_flag: true,
        dormant_since: runDateISO,
        state_transitions: [...entity.state_transitions, transition],
        updated_at: new Date().toISOString(),
      })
      .eq("id", entity.id);

    flagged.push({
      entity_id: entity.id,
      type: entity.type,
      label: entity.canonical_label,
      last_gap_days: daysSilent,
      median_gap_days: median,
    });
  }

  return flagged;
}

// ─── Pass 3 — retirement sweep ─────────────────────

async function sweepRetirements(
  db: ReturnType<typeof getSupabaseAdmin>,
  runDateISO: string,
): Promise<NightlyTier1Result["retirements"]> {
  const threshold = new Date(runDateISO);
  threshold.setDate(threshold.getDate() - RETIRE_SILENCE_WEEKS * 7);
  const thresholdISO = threshold.toISOString().slice(0, 10);

  const entities = await paginate<EntityRow>(db, "signal_entities", (offset, pageSize) =>
    db
      .from("signal_entities")
      .select("id, type, canonical_label, canonical_key, first_seen, last_seen, mention_count, distinct_context_count, lifecycle_state, state_transitions, cadence_stats, dormant_flag, dormant_since")
      .eq("lifecycle_state", "crystallization")
      .lt("last_seen", thresholdISO)
      .range(offset, offset + pageSize - 1),
  );

  const retired: NightlyTier1Result["retirements"] = [];

  for (const entity of entities) {
    const transition: StateTransition = {
      from: "crystallization",
      to: "retired",
      at: runDateISO,
      mention_id: null,
      reason: `retired: silent since ${entity.last_seen}, threshold ${thresholdISO}`,
    };

    await db
      .from("signal_entities")
      .update({
        lifecycle_state: "retired" satisfies LifecycleState,
        state_transitions: [...entity.state_transitions, transition],
        updated_at: new Date().toISOString(),
      })
      .eq("id", entity.id);

    retired.push({
      entity_id: entity.id,
      type: entity.type,
      label: entity.canonical_label,
      last_seen: entity.last_seen,
    });
  }

  return retired;
}

// ─── Pass 4 — today's crystallizations ─────────────

async function listTodayCrystallizations(
  db: ReturnType<typeof getSupabaseAdmin>,
  runDateISO: string,
): Promise<NightlyTier1Result["crystallizations"]> {
  // Pull crystallized entities. Filter to those whose most recent transition
  // to crystallization is on or after runDateISO.
  const entities = await paginate<EntityRow>(db, "signal_entities", (offset, pageSize) =>
    db
      .from("signal_entities")
      .select("id, type, canonical_label, canonical_key, first_seen, last_seen, mention_count, distinct_context_count, lifecycle_state, state_transitions, cadence_stats, dormant_flag, dormant_since")
      .eq("lifecycle_state", "crystallization")
      .range(offset, offset + pageSize - 1),
  );

  const found: NightlyTier1Result["crystallizations"] = [];
  for (const entity of entities) {
    const transitions = entity.state_transitions ?? [];
    // True state change: from != to, landing on 'crystallization', dated
    // today or later. This excludes merge overlays (same-state bookkeeping).
    const crystallization = [...transitions]
      .reverse()
      .find((t) => t.to === "crystallization" && t.from !== "crystallization");
    if (!crystallization) continue;
    if (crystallization.at < runDateISO) continue;

    found.push({
      entity_id: entity.id,
      type: entity.type,
      label: entity.canonical_label,
      mention_count: entity.mention_count,
    });
  }

  return found;
}

// ─── Pass 5 — merge judge (LLM) ────────────────────

interface MergeCandidate {
  a: EntityRow;
  b: EntityRow;
  score: number; // token-overlap Jaccard
}

async function runMergeJudge(
  db: ReturnType<typeof getSupabaseAdmin>,
  run_id: string,
): Promise<{
  auto: NightlyTier1Result["merges_auto"];
  proposed: NightlyTier1Result["merges_proposed"];
  tokens: number;
  errors: string[];
}> {
  const out = {
    auto: [] as NightlyTier1Result["merges_auto"],
    proposed: [] as NightlyTier1Result["merges_proposed"],
    tokens: 0,
    errors: [] as string[],
  };

  const client = getAnthropicClient();
  const types: Array<"tension" | "voice" | "belief"> = ["tension", "voice", "belief"];

  for (const type of types) {
    // Pull recurrence+ entities of this type — these are worth merging,
    // single-mention entities are noise.
    const entities = await paginate<EntityRow>(db, "signal_entities", (offset, pageSize) =>
      db
        .from("signal_entities")
        .select("id, type, canonical_label, canonical_key, first_seen, last_seen, mention_count, distinct_context_count, lifecycle_state, state_transitions, cadence_stats, dormant_flag, dormant_since")
        .eq("type", type)
        .in("lifecycle_state", ["recurrence", "crystallization"])
        .order("mention_count", { ascending: false })
        .range(offset, offset + pageSize - 1),
    );

    // Also include top first_appearance entities — they're candidates for
    // absorption INTO a recurrence+. Pulling top 50 by mention count
    // keeps this bounded.
    const { data: firstAppearances } = await db
      .from("signal_entities")
      .select("id, type, canonical_label, canonical_key, first_seen, last_seen, mention_count, distinct_context_count, lifecycle_state, state_transitions, cadence_stats, dormant_flag, dormant_since")
      .eq("type", type)
      .eq("lifecycle_state", "first_appearance")
      .order("mention_count", { ascending: false })
      .limit(50);

    const pool: EntityRow[] = [
      ...entities,
      ...((firstAppearances ?? []) as EntityRow[]),
    ];

    const candidates = findMergeCandidates(pool);
    const topCandidates = candidates.slice(0, MERGE_JUDGE_CANDIDATES_PER_TYPE);

    for (const cand of topCandidates) {
      try {
        const judged = await judgePair(client, type, cand.a, cand.b);
        out.tokens += judged.tokens;

        if (judged.confidence >= MERGE_AUTO_CONFIDENCE) {
          // Apply merge
          await applyMerge(db, cand.a, cand.b, judged);
          out.auto.push({
            a_id: cand.a.id,
            b_id: cand.b.id,
            label: judged.merged_label ?? cand.a.canonical_label,
            confidence: judged.confidence,
          });
        } else if (judged.confidence >= MERGE_QUEUE_FLOOR) {
          // Queue for review
          await db.from("signal_merge_proposals").insert({
            run_id,
            entity_a_id: cand.a.id,
            entity_b_id: cand.b.id,
            confidence: judged.confidence,
            llm_reasoning: judged.reasoning,
            merged_label_suggestion: judged.merged_label,
          });
          out.proposed.push({
            a_id: cand.a.id,
            b_id: cand.b.id,
            a_label: cand.a.canonical_label,
            b_label: cand.b.canonical_label,
            confidence: judged.confidence,
          });
        }
        // else: dropped silently
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.errors.push(`merge_judge/${type}: ${msg}`);
      }
    }
  }

  return out;
}

function findMergeCandidates(pool: EntityRow[]): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();

  // Pairwise compare — O(n²), but bounded by pool size (recurrence+ is small).
  // First_appearance top-50 bounds the other side. Worst case 50 × 50 = 2500.
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];

      const pairKey = [a.id, b.id].sort().join("|");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const score = jaccardOverlap(a.canonical_key, b.canonical_key);
      if (score < 0.4) continue;
      candidates.push({ a, b, score });
    }
  }

  return candidates.sort((x, y) => y.score - x.score);
}

function jaccardOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/[\s\-_]+/).filter((t) => t && t !== "vs" && t !== "vs." && t.length > 2));
  const aSet = tokenize(a);
  const bSet = tokenize(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  const intersection = [...aSet].filter((t) => bSet.has(t)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return intersection / union;
}

interface MergeJudgment {
  same_entity: boolean;
  confidence: number;
  merged_label: string | null;
  reasoning: string;
  tokens: number;
}

async function judgePair(
  client: ReturnType<typeof getAnthropicClient>,
  type: string,
  a: EntityRow,
  b: EntityRow,
): Promise<MergeJudgment> {
  const prompt = `Two ${type} entities have been proposed for merge. Decide whether they refer to the same underlying idea.

ENTITY A
Label: ${a.canonical_label}
Key: ${a.canonical_key}
Mentions: ${a.mention_count} across ${a.distinct_context_count} distinct contexts
First seen: ${a.first_seen}  Last seen: ${a.last_seen}

ENTITY B
Label: ${b.canonical_label}
Key: ${b.canonical_key}
Mentions: ${b.mention_count} across ${b.distinct_context_count} distinct contexts
First seen: ${b.first_seen}  Last seen: ${b.last_seen}

For ${type}s:
- "centralization vs autonomy" and "integration vs autonomy" = same structural shape (distributed decision-making)
- "speed vs quality" and "speed vs craft" = same
- "growth vs sustainability" and "growth vs margins" = different — margins and sustainability diverge meaningfully
- For voice/belief compressions: word-level variants of the same sentence = same; paraphrases with meaningfully different content = different

Return structured JSON via the tool. confidence ∈ [0,1]. reasoning is one sentence.`;

  const response = await client.messages.create({
    model: MERGE_MODEL,
    max_tokens: 400,
    temperature: 0,
    tools: [
      {
        name: "judge_merge",
        description: "Decide whether two entities refer to the same underlying idea.",
        input_schema: {
          type: "object",
          properties: {
            same_entity: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            merged_label: {
              type: ["string", "null"],
              description:
                "If same_entity=true, the preferred canonical label. Otherwise null.",
            },
            reasoning: { type: "string" },
          },
          required: ["same_entity", "confidence", "merged_label", "reasoning"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "judge_merge" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("merge judge returned no tool use");
  }
  const input = toolUse.input as {
    same_entity: boolean;
    confidence: number;
    merged_label: string | null;
    reasoning: string;
  };

  return {
    same_entity: input.same_entity,
    // If judge says different, confidence still communicates how sure — flip
    // to 1-confidence so we can uniformly threshold.
    confidence: input.same_entity ? input.confidence : 1 - input.confidence,
    merged_label: input.merged_label,
    reasoning: input.reasoning,
    tokens: response.usage.input_tokens + response.usage.output_tokens,
  };
}

async function applyMerge(
  db: ReturnType<typeof getSupabaseAdmin>,
  a: EntityRow,
  b: EntityRow,
  judgment: MergeJudgment,
): Promise<void> {
  // Keep the entity with higher mention_count as survivor; smaller one dies.
  const survivor = a.mention_count >= b.mention_count ? a : b;
  const loser = survivor === a ? b : a;

  // Re-parent mentions
  await db
    .from("signal_entity_mentions")
    .update({ entity_id: survivor.id })
    .eq("entity_id", loser.id);

  // Absorb aliases + label
  const newLabel = judgment.merged_label ?? survivor.canonical_label;
  const newAliases = [
    ...new Set([
      ...(survivor.canonical_label === newLabel ? [] : [survivor.canonical_label]),
      ...(loser.canonical_label === newLabel ? [] : [loser.canonical_label]),
      // (aliases field merge happens later — keep minimal for now)
    ]),
  ].filter(Boolean);

  // Recompute aggregates over the merged mention set
  const { data: allMentions } = await db
    .from("signal_entity_mentions")
    .select("source_date, transcript_id")
    .eq("entity_id", survivor.id);

  const dates = (allMentions ?? []).map((m) => m.source_date as string).sort();
  const contexts = new Set(
    (allMentions ?? []).map((m) => m.transcript_id).filter((t): t is string => !!t),
  );
  const firstSeen = dates[0] ?? survivor.first_seen;
  const lastSeen = dates[dates.length - 1] ?? survivor.last_seen;

  const mergeTransition: StateTransition = {
    from: survivor.lifecycle_state,
    to: survivor.lifecycle_state,
    at: new Date().toISOString().slice(0, 10),
    mention_id: null,
    reason: `merge_absorbed: ${loser.canonical_label} (confidence=${judgment.confidence.toFixed(2)})`,
  };

  await db
    .from("signal_entities")
    .update({
      canonical_label: newLabel,
      aliases: newAliases,
      first_seen: firstSeen,
      last_seen: lastSeen,
      mention_count: allMentions?.length ?? survivor.mention_count,
      distinct_context_count: contexts.size,
      state_transitions: [...survivor.state_transitions, mergeTransition],
      updated_at: new Date().toISOString(),
    })
    .eq("id", survivor.id);

  // Delete loser
  await db.from("signal_entities").delete().eq("id", loser.id);
}

// ─── Helpers ──────────────────────────────────────

/**
 * Pull all rows matching a filter predicate by paginating over
 * Supabase's 1000-row default. Callers apply filters themselves via
 * the `build` function, which receives the offset window and returns a
 * ready-to-await query.
 */
async function paginate<T>(
  _db: ReturnType<typeof getSupabaseAdmin>,
  _table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (offset: number, pageSize: number) => any,
): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const { data, error } = (await build(offset, pageSize)) as {
      data: unknown[] | null;
      error: { message: string } | null;
    };
    if (error) throw new Error(`paginate: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
