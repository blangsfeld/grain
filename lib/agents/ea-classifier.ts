/**
 * Buddy's commitment classifier.
 *
 * Uses Ben's labels (commitment_labels table) as few-shot examples and asks
 * Claude to classify new commitments. Caches results in-memory per run.
 *
 * Weights:
 *   high   — strategic/meaningful work driving Ben's priorities
 *   medium — useful ops Ben would regret missing
 *   low    — real work but not Ben's priority (other people's stuff, tactical)
 *   skip   — shouldn't be in commitments DB (scaffolding, logistics, when/where-only)
 */

import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseAdmin } from "@/lib/supabase";

export type CommitmentWeight = "high" | "medium" | "low" | "skip";

export interface CommitmentRow {
  id: string;
  statement: string;
  category: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  status: string | null;
  person: string | null;
}

export interface LabeledExample {
  commitment_id: string;
  weight: CommitmentWeight;
  reason: string | null;
  statement: string;
  person: string | null;
  category: string | null;
  status: string | null;
}

export interface Classification {
  weight: CommitmentWeight;
  reason: string;
  source: "human-label" | "classifier" | "fallback";
}

const MODEL = "claude-haiku-4-5-20251001";

// ── Load labels ────────────────────────────────────
export async function fetchLabeledExamples(): Promise<LabeledExample[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("commitment_labels")
    .select(`
      commitment_id,
      weight,
      reason,
      dx_commitments ( statement, person, category, status )
    `)
    .order("labeled_at", { ascending: false });

  if (error) throw new Error(`labels fetch: ${error.message}`);

  // Supabase can type joins as either object or array depending on config.
  // Normalize both shapes at runtime.
  const rows = (data ?? []) as unknown as Array<{
    commitment_id: string;
    weight: CommitmentWeight;
    reason: string | null;
    dx_commitments:
      | { statement: string; person: string | null; category: string | null; status: string | null }
      | Array<{ statement: string; person: string | null; category: string | null; status: string | null }>
      | null;
  }>;

  return rows
    .map((r) => {
      const joined = Array.isArray(r.dx_commitments) ? r.dx_commitments[0] : r.dx_commitments;
      if (!joined) return null;
      return {
        commitment_id: r.commitment_id,
        weight: r.weight,
        reason: r.reason,
        statement: joined.statement,
        person: joined.person,
        category: joined.category,
        status: joined.status,
      } satisfies LabeledExample;
    })
    .filter((x): x is LabeledExample => x !== null);
}

// ── Fetch explicit labels for a commitment ─────────
async function fetchLabelFor(commitment_id: string): Promise<{ weight: CommitmentWeight; reason: string | null } | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("commitment_labels")
    .select("weight, reason")
    .eq("commitment_id", commitment_id)
    .maybeSingle();
  if (!data) return null;
  return { weight: data.weight as CommitmentWeight, reason: (data.reason as string | null) ?? null };
}

// ── Prompt building ────────────────────────────────
const SYSTEM_PROMPT = `You are classifying items from a meeting-commitments database for Ben Langsfeld's executive assistant ("Buddy").

Each item claims to be a commitment — something someone agreed to do in a meeting. Your job is to assign a weight.

Weight definitions:
- **high**: Strategic or meaningful work that drives Ben's business priorities. Creative direction, significant decisions, substantive outputs, thought leadership.
- **medium**: Useful ops that advances the business. Coordination Ben would regret missing. Known routine with real value. Consensus-needing work. Useful-but-abstract signal worth tracking.
- **low**: Real work but not Ben's priority. Other team members' commitments (Daniell, Madison, etc.) even when Ben is in the conversation. Tactical coordination happening in the background.
- **skip**: Should not be in a commitments database. Pure calendaring ("block calendar time", "come to office", "go to hotel at X"). Trivial logistics ("take the call from the car"). When/where-only statements with no substantive action. Meet-ups and internal work sessions mislabeled as business commitments.

Ben cares about: strategic work, network collaboration, brand imprint, creative direction, platform-building, relationships with specific people who matter to the business.
Ben does NOT want to see: calendaring scaffolding, pure logistics, other people's tactical coordination, meet-ups masquerading as work.

Respond with strict JSON only, no prose:
{"weight": "high|medium|low|skip", "reason": "one short sentence explaining the choice"}`;

function renderExample(ex: LabeledExample): string {
  return [
    `Person: ${ex.person ?? "?"}`,
    `Category: ${ex.category ?? "—"}`,
    `Status: ${ex.status ?? "—"}`,
    `Statement: ${ex.statement}`,
    `Ben's label: ${ex.weight}${ex.reason ? ` — "${ex.reason}"` : ""}`,
  ].join("\n");
}

function renderInput(c: CommitmentRow): string {
  return [
    `Person: ${c.person ?? "?"}`,
    `Category: ${c.category ?? "—"}`,
    `Status: ${c.status ?? "—"}`,
    `Meeting: ${c.meeting_title ?? "—"}`,
    `Statement: ${c.statement}`,
  ].join("\n");
}

function buildUserMessage(examples: LabeledExample[], target: CommitmentRow): string {
  const lines: string[] = [];
  lines.push("Here are commitments Ben has labeled, with his reasoning. Match his pattern.");
  lines.push("");
  for (const ex of examples) {
    lines.push("---");
    lines.push(renderExample(ex));
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("Now classify this commitment:");
  lines.push("");
  lines.push(renderInput(target));
  lines.push("");
  lines.push("Return JSON only.");
  return lines.join("\n");
}

// ── Parser ─────────────────────────────────────────
function parseClassification(raw: string): { weight: CommitmentWeight; reason: string } | null {
  // Strip code fences if present
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const w = parsed.weight;
    if (!["high", "medium", "low", "skip"].includes(w)) return null;
    return {
      weight: w as CommitmentWeight,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

// ── Classify one ───────────────────────────────────
export async function classifyCommitment(
  c: CommitmentRow,
  examples: LabeledExample[],
): Promise<Classification> {
  // Short-circuit: if this commitment is already labeled by the human, use that
  const existing = await fetchLabelFor(c.id);
  if (existing) {
    return {
      weight: existing.weight,
      reason: existing.reason ?? "(human-labeled)",
      source: "human-label",
    };
  }

  if (examples.length === 0) {
    return { weight: "medium", reason: "no training labels yet, defaulting medium", source: "fallback" };
  }

  try {
    const anthropic = getAnthropicClient(30_000);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(examples, c) }],
    });

    const content = response.content[0];
    const text = content.type === "text" ? content.text : "";
    const parsed = parseClassification(text);
    if (!parsed) {
      return { weight: "medium", reason: "classifier parse failure, defaulting medium", source: "fallback" };
    }

    return { weight: parsed.weight, reason: parsed.reason, source: "classifier" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { weight: "medium", reason: `classifier error: ${msg}`, source: "fallback" };
  }
}

// ── Classify batch (concurrency-limited) ───────────
export async function classifyBatch(
  commitments: CommitmentRow[],
  concurrency = 4,
): Promise<Map<string, Classification>> {
  const examples = await fetchLabeledExamples();
  const results = new Map<string, Classification>();

  // Simple concurrency pool
  const queue = [...commitments];
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      const classification = await classifyCommitment(c, examples);
      results.set(c.id, classification);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
