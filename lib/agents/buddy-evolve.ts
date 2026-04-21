/**
 * Buddy — semantic reply interpreter.
 *
 * Reads Ben's free-text replies against the latest synthesis menu and turns
 * "that's done," "retire the gmail one," "bump 2 to tomorrow," "the first
 * one rolled into the second" into typed updates on his Notion kept list.
 * Every update writes a Conversation Log entry in Ben's voice so the thread
 * has a trail — even on a log-only aside.
 *
 * Sits between the digit short-circuit and the main Haiku classifier in
 * telegram-desk. On a miss, returns kind="miss" and the handler falls
 * through to the normal pipeline.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  updatePage,
  appendRichText,
  selectProp,
  dateProp,
  relationProp,
  type NotionPropertyValue,
} from "@/lib/notion";
import type {
  BuddySynthesis,
  KeptIndexItem,
} from "@/lib/agents/buddy-synthesize";

const MODEL = "claude-haiku-4-5-20251001";

// ── Interpreter output shape ───────────────────────

type Action =
  | "done"
  | "in_progress"
  | "waiting"
  | "recurring"
  | "evolved"
  | "dormant"
  | "not_a_thing"
  | "bump_due_date"
  | "log_only";

interface UpdateInput {
  kept_index: number;
  action: Action;
  log_entry: string;
  evolved_to_kept_index?: number | null;
  new_due_date?: string | null;
}

interface ClarifyInput {
  question: string;
  candidate_kept_indexes: number[];
}

// ── Tool schemas ───────────────────────────────────

const INTERPRET_TOOL = {
  name: "interpret_reply",
  description:
    "Apply one or more updates to Ben's kept Notion commitments based on his reply.",
  input_schema: {
    type: "object" as const,
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kept_index: {
              type: "number",
              description:
                "1-indexed position in Ben's kept list. Must be one of the items shown.",
            },
            action: {
              type: "string",
              enum: [
                "done",
                "in_progress",
                "waiting",
                "recurring",
                "evolved",
                "dormant",
                "not_a_thing",
                "bump_due_date",
                "log_only",
              ],
              description:
                "done = completed. in_progress = active, moving. waiting = blocked on someone else. " +
                "recurring = ongoing, stop treating as a one-time task. evolved = superseded by " +
                "another kept item (requires evolved_to_kept_index). dormant = parked, not dead. " +
                "not_a_thing = mis-extraction, never actually Ben's intent. bump_due_date = keep " +
                "status, push the deadline (requires new_due_date). log_only = no state change, " +
                "just record Ben's aside or new thought.",
            },
            log_entry: {
              type: "string",
              description:
                "One sentence in Ben's voice capturing what he said and why. Always included, even for log_only.",
            },
            evolved_to_kept_index: {
              type: ["number", "null"],
              description:
                "1-indexed kept item this one merged into. Required when action=evolved.",
            },
            new_due_date: {
              type: ["string", "null"],
              description:
                "YYYY-MM-DD. Required when action=bump_due_date. Resolve relative dates against today.",
            },
          },
          required: ["kept_index", "action", "log_entry"],
        },
      },
    },
    required: ["updates"],
  },
};

const CLARIFY_TOOL = {
  name: "clarify",
  description:
    "Ask Ben which item he meant when the reply is ambiguous across multiple kept items.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "One-line question to Ben. Warm, direct.",
      },
      candidate_kept_indexes: {
        type: "array",
        items: { type: "number" },
        description: "1-indexed kept list positions that might match. Give 2-4.",
      },
    },
    required: ["question", "candidate_kept_indexes"],
  },
};

const SYSTEM_PROMPT = `You interpret Ben's free-text replies to his morning briefing and turn them into updates on his kept list (Notion Personal Commitments).

You receive:
1. Ben's kept list — 1-indexed, each row has a name, status, category, optional due date
2. Today's briefing sections — attention threads, carried-forward items, tasks (for reference only, not writeable)
3. Ben's reply

Decide:
- If the reply is clearly about specific kept items — call interpret_reply. One update per item Ben referenced. A single reply can touch multiple items ("done 1, bump 2, evolved 3 into 5").
- If it's ambiguous (multiple plausible matches) — call clarify with candidate indexes.
- If it isn't about the kept list at all — call neither. The message will fall through to the normal classifier.

Matching:
- Ben often refers by topic ("the gmail one", "the Attic booking") — match against item names loosely. Substring match is fine when unique.
- Ben may reference Buddy's thread numbers ("thread 2 is done"). Ignore thread numbers — only kept items count for updates.
- "this" / "that" is ambiguous unless Ben just drilled into a specific kept item. If unclear, call clarify.

Actions:
- done — Ben said it's finished
- in_progress — picked it back up, still alive
- waiting — blocked on someone, not Ben
- recurring — ongoing task, stop being asked about it
- evolved — rolled into another kept item (set evolved_to_kept_index)
- dormant — parked, not active, not dead
- not_a_thing — mis-extraction, never actually Ben's intent
- bump_due_date — push the deadline (set new_due_date YYYY-MM-DD)
- log_only — Ben's aside or new thought, no state change

Every update must include a log_entry — one sentence in Ben's voice capturing what he just said. Even log_only updates get one. The log is Ben's audit trail, not a paraphrase.

Be conservative. If the match isn't clear, call clarify instead of guessing.`;

// ── Result shape ───────────────────────────────────

export interface InterpretResult {
  kind: "applied" | "clarify" | "miss";
  message: string;
  applied: Array<{
    kept_name: string;
    action: Action;
    log_entry: string;
  }>;
  errors: Array<{ kept_index: number; reason: string }>;
}

/**
 * Write-free classification result. `interpretSynthesisReply` applies these
 * to Notion; tests / dry runs consume them directly.
 */
export interface ClassifiedReply {
  kind: "updates" | "clarify" | "miss";
  updates: UpdateInput[];
  clarify: ClarifyInput | null;
  /** Resolved from the latest menu — present on updates/clarify, null on miss. */
  kept: KeptIndexItem[];
}

// ── Menu read ──────────────────────────────────────

async function fetchLatestSynthesisMenu(
  chat_id: number,
): Promise<BuddySynthesis | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .select("items")
    .eq("chat_id", chat_id)
    .eq("kind", "synthesis")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`synthesis menu query: ${error.message}`);
  if (!data) return null;
  return data.items as BuddySynthesis;
}

// ── Cheap gate before hitting Haiku ────────────────

function likelyMenuReply(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (t.length > 400) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return true;
}

// ── Context formatting ─────────────────────────────

function formatKeptContext(kept: KeptIndexItem[]): string {
  if (kept.length === 0) return "_(kept list empty)_";
  const lines: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const meta = [k.category, k.status, k.due_date && `due ${k.due_date}`]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${i + 1}. "${k.name}"${meta ? ` — ${meta}` : ""}`);
  }
  return lines.join("\n");
}

function formatBriefingContext(synthesis: BuddySynthesis): string {
  const lines: string[] = [];
  if (synthesis.attention.length > 0) {
    lines.push("## Attention threads");
    synthesis.attention.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
  }
  if (synthesis.carried_forward.length > 0) {
    lines.push("");
    lines.push("## Carried forward");
    synthesis.carried_forward.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
  }
  if (synthesis.tasks_can_help_with.length > 0) {
    lines.push("");
    lines.push("## Tasks");
    synthesis.tasks_can_help_with.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
  }
  return lines.length === 0 ? "_(no briefing sections)_" : lines.join("\n");
}

// ── Update application ─────────────────────────────

async function applyUpdate(
  kept: KeptIndexItem[],
  update: UpdateInput,
): Promise<{ ok: true; kept_name: string } | { ok: false; reason: string }> {
  const item = kept[update.kept_index - 1];
  if (!item) {
    return {
      ok: false,
      reason: `kept item #${update.kept_index} out of range (have ${kept.length})`,
    };
  }

  const props: Record<string, NotionPropertyValue> = {};
  switch (update.action) {
    case "done":
      props.Status = selectProp("Done");
      break;
    case "in_progress":
      props.Status = selectProp("In Progress");
      break;
    case "waiting":
      props.Status = selectProp("Waiting");
      break;
    case "recurring":
      props.Status = selectProp("Recurring");
      break;
    case "dormant":
      props.Status = selectProp("Dormant");
      break;
    case "not_a_thing":
      props.Status = selectProp("Not a thing");
      break;
    case "evolved": {
      props.Status = selectProp("Evolved");
      if (update.evolved_to_kept_index) {
        const target = kept[update.evolved_to_kept_index - 1];
        if (target) props["Evolved To"] = relationProp([target.page_id]);
      }
      break;
    }
    case "bump_due_date": {
      if (update.new_due_date) props["Due Date"] = dateProp(update.new_due_date);
      break;
    }
    case "log_only":
      // No status change — log only.
      break;
  }

  if (Object.keys(props).length > 0) {
    await updatePage(item.page_id, props);
  }
  // Always append to Conversation Log, even on log_only.
  await appendRichText(item.page_id, "Conversation Log", update.log_entry);

  return { ok: true, kept_name: item.name };
}

// ── Result formatting ──────────────────────────────

function actionLabel(action: Action): string {
  if (action === "log_only") return "note";
  if (action === "not_a_thing") return "not a thing";
  if (action === "bump_due_date") return "pushed";
  return action.replace(/_/g, " ");
}

function formatAppliedMessage(
  applied: InterpretResult["applied"],
  errors: InterpretResult["errors"],
): string {
  const lines: string[] = [];
  if (applied.length > 0) {
    lines.push(`*Logged ${applied.length}:*`);
    for (const a of applied) {
      lines.push(`  • "${a.kept_name}" → _${actionLabel(a.action)}_`);
      lines.push(`      ${a.log_entry}`);
    }
  }
  if (errors.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`*Couldn't apply ${errors.length}:*`);
    for (const e of errors) {
      lines.push(`  ${e.kept_index}: ${e.reason}`);
    }
  }
  if (lines.length === 0) return "Nothing applied.";
  return lines.join("\n");
}

function formatClarifyMessage(
  clarify: ClarifyInput,
  kept: KeptIndexItem[],
): string {
  const lines: string[] = [clarify.question, ""];
  for (const idx of clarify.candidate_kept_indexes) {
    const item = kept[idx - 1];
    if (item) {
      lines.push(`  • ${idx}. "${item.name}" _(${item.category ?? "—"})_`);
    }
  }
  lines.push("");
  lines.push("_Reply with a more specific phrase or the item name._");
  return lines.join("\n");
}

// ── Entrypoint ─────────────────────────────────────

/**
 * Pure classification pass — runs the LLM but does not touch Notion.
 * Used by the smoke test and composable for future dry-run surfaces.
 */
export async function classifyReply(
  chat_id: number,
  text: string,
): Promise<ClassifiedReply> {
  const miss: ClassifiedReply = { kind: "miss", updates: [], clarify: null, kept: [] };

  if (!likelyMenuReply(text)) return miss;

  const synthesis = await fetchLatestSynthesisMenu(chat_id).catch(() => null);
  if (!synthesis) return miss;
  const kept = synthesis.kept_index ?? [];
  if (kept.length === 0) return miss;

  const today = new Date().toISOString().slice(0, 10);
  const context = [
    `# Today's date: ${today}`,
    "",
    `# Ben's kept list (${kept.length} open items, 1-indexed)`,
    formatKeptContext(kept),
    "",
    "# Today's briefing sections (reference only — not writeable)",
    formatBriefingContext(synthesis),
    "",
    "---",
    "",
    "# Ben's reply:",
    `"${text}"`,
    "",
    "Interpret. Call interpret_reply, clarify, or neither.",
  ].join("\n");

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    tools: [INTERPRET_TOOL, CLARIFY_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: context }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return { ...miss, kept };

  if (toolUse.name === "clarify") {
    return {
      kind: "clarify",
      updates: [],
      clarify: toolUse.input as ClarifyInput,
      kept,
    };
  }

  if (toolUse.name === "interpret_reply") {
    const parsed = toolUse.input as { updates?: UpdateInput[] };
    const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
    if (updates.length === 0) return { ...miss, kept };
    return { kind: "updates", updates, clarify: null, kept };
  }

  return { ...miss, kept };
}

export async function interpretSynthesisReply(
  chat_id: number,
  text: string,
): Promise<InterpretResult> {
  const miss: InterpretResult = { kind: "miss", message: "", applied: [], errors: [] };
  const classified = await classifyReply(chat_id, text);

  if (classified.kind === "miss") return miss;

  if (classified.kind === "clarify" && classified.clarify) {
    return {
      kind: "clarify",
      message: formatClarifyMessage(classified.clarify, classified.kept),
      applied: [],
      errors: [],
    };
  }

  // updates
  const applied: InterpretResult["applied"] = [];
  const errors: InterpretResult["errors"] = [];
  for (const u of classified.updates) {
    try {
      const res = await applyUpdate(classified.kept, u);
      if (res.ok) {
        applied.push({
          kept_name: res.kept_name,
          action: u.action,
          log_entry: u.log_entry,
        });
      } else {
        errors.push({ kept_index: u.kept_index, reason: res.reason });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ kept_index: u.kept_index, reason });
    }
  }
  if (applied.length === 0 && errors.length === 0) return miss;
  return {
    kind: "applied",
    message: formatAppliedMessage(applied, errors),
    applied,
    errors,
  };
}
