/**
 * Buddy — synthesis pass (chief of staff mode).
 *
 * Reads across the whole crew — every sibling agent's latest report, Ben's
 * kept list (Notion), the heard list (dx_commitments), recent tensions and
 * beliefs, and the CCO forward plan — and produces a sectioned briefing in
 * Town/Euclid register: worth-your-attention threads, carried-forward aging
 * items, reverse gaze on what others owe Ben, cross-cutting patterns, and
 * concrete leverage offers at the bottom.
 *
 * This is the replacement for the raw top-N "Promote 6 1 2" surface.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { readLatestAgentOutput } from "@/lib/agents/agent-output";
import { readPersonalCommitments } from "@/lib/agents/ea";
import { beat } from "@/lib/heartbeat";

const MODEL = "claude-sonnet-4-5-20250929";

// Siblings Buddy reads. ea is Buddy's own cron output — excluded.
const SIBLINGS = [
  { id: "grain-steward", persona: "Guy", domain: "pipeline health" },
  { id: "security-steward", persona: "Dood", domain: "security" },
  { id: "what-if", persona: "Bruh", domain: "counterfactuals + what-ifs" },
  { id: "columnist", persona: "Clark", domain: "voice moments + essay pitches" },
  { id: "wiki-librarian", persona: "Milli", domain: "wiki triage" },
  { id: "notion-steward", persona: "Timi", domain: "people intelligence" },
] as const;

const FORWARD_PLAN_PATH = join(
  homedir(),
  "Documents/Obsidian/Studio/10-projects/forward-plans/cco-2026.md",
);

// Banned words — voice leaks caught in prior runs. The synthesis prompt
// warns; this list is also used as a post-pass validator so leaks don't
// ship to Ben's eye.
const BANNED_WORDS = [
  "leverage", "ecosystem", "seamless", "robust", "actionable",
  "circle back", "circling back", "streamline", "unlock", "unlocks",
  "unlocking", "synergy", "synergies", "low-hanging", "move the needle",
  "stakeholder", "touch base",
];

// ── Output shape ───────────────────────────────────

export interface ThreadSignal {
  kind: "agent" | "commitment" | "atom" | "plan";
  ref: string;
  summary: string;
}

export interface AttentionThread {
  title: string;
  body: string;
  source_signals: ThreadSignal[];
}

export interface CarriedItem {
  title: string;
  body: string;
  source_signals: ThreadSignal[];
}

export interface OwedItem {
  person: string;
  description: string;
  age: string;
}

export interface Pattern {
  body: string;
}

export interface TaskOffer {
  title: string;
  description: string;
  draft: string | null;
}

/**
 * Resolvable pointer to a single row in Ben's Notion Personal Commitments DB.
 * Captured at synthesis time so the semantic reply interpreter can rewrite
 * that page a few minutes later without re-querying Notion.
 */
export interface KeptIndexItem {
  page_id: string;
  name: string;
  category: string | null;
  status: string | null;
  due_date: string | null;
}

/**
 * Resolvable pointer to a dx_commitments row (the heard list). Not writable
 * by the semantic interpreter in v1 — kept for context only, so the LLM
 * knows what's on Ben's plate without mistaking it for a kept item.
 */
export interface PlateIndexItem {
  commitment_id: string;
  statement: string;
  person: string | null;
  due_date: string | null;
  age_days: number;
}

export interface BuddySynthesis {
  generated_at: string;
  opener: string;
  attention: AttentionThread[];
  carried_forward: CarriedItem[];
  others_owe_you: OwedItem[];
  patterns: Pattern[];
  tasks_can_help_with: TaskOffer[];
  quiet_note: string | null;
  siblings_read: string[];
  corpus_sizes: {
    plate: number;
    kept: number;
    tensions: number;
    beliefs: number;
  };
  voice_warnings: string[];
  /** 1-indexed sidecar — what the semantic interpreter writes against. */
  kept_index: KeptIndexItem[];
  /** 1-indexed sidecar — reference only in v1. */
  plate_index: PlateIndexItem[];
}

// ── Fact gathering ─────────────────────────────────

interface SiblingSnapshot {
  id: string;
  persona: string;
  domain: string;
  severity: string;
  markdown: string;
  run_at: string;
}

async function readSiblings(): Promise<SiblingSnapshot[]> {
  const results = await Promise.all(
    SIBLINGS.map(async (s): Promise<SiblingSnapshot | null> => {
      const out = await readLatestAgentOutput(s.id).catch(() => null);
      if (!out) return null;
      return {
        id: s.id,
        persona: s.persona,
        domain: s.domain,
        severity: out.severity,
        markdown: out.markdown.slice(0, 1800),
        run_at: out.run_at,
      };
    }),
  );
  return results.filter((r): r is SiblingSnapshot => r !== null);
}

interface PlateItem {
  id: string;
  statement: string;
  category: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  age_days: number;
  person: string | null;
}

async function readPlate(): Promise<PlateItem[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dx_commitments")
    .select("id, statement, person, category, meeting_title, meeting_date, due_date")
    .eq("status", "open")
    .is("promoted_at", null)
    .order("meeting_date", { ascending: false })
    .limit(80);

  if (error) throw new Error(`plate read: ${error.message}`);
  const today = Date.now();
  return (data ?? []).map((r) => {
    const meetingDate = r.meeting_date as string | null;
    const age = meetingDate
      ? Math.floor((today - new Date(meetingDate).getTime()) / 86_400_000)
      : 0;
    return {
      id: r.id as string,
      statement: r.statement as string,
      person: r.person as string | null,
      category: r.category as string | null,
      meeting_title: r.meeting_title as string | null,
      meeting_date: meetingDate,
      due_date: r.due_date as string | null,
      age_days: age,
    };
  });
}

interface AtomRow {
  content: Record<string, unknown>;
  source_title: string | null;
  source_date: string | null;
}

async function readAtomsByType(type: string, sinceIso: string, limit: number): Promise<AtomRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dx_atoms")
    .select("content, source_title, source_date")
    .eq("type", type)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`dx_atoms ${type} read: ${error.message}`);
  return (data ?? []).map((r) => ({
    content: (r.content ?? {}) as Record<string, unknown>,
    source_title: r.source_title as string | null,
    source_date: r.source_date as string | null,
  }));
}

async function readForwardPlanHighlights(): Promise<string | null> {
  try {
    const raw = await readFile(FORWARD_PLAN_PATH, "utf-8");
    return raw.split("\n").slice(0, 80).join("\n");
  } catch {
    return null;
  }
}

// ── Prompt assembly ────────────────────────────────

function formatSiblings(snaps: SiblingSnapshot[]): string {
  if (snaps.length === 0) return "_(no sibling outputs available)_";
  const out: string[] = [];
  for (const s of snaps) {
    out.push(`## ${s.persona} (${s.domain}) — ${s.severity} · ${s.run_at}`);
    out.push(s.markdown);
    out.push("");
  }
  return out.join("\n");
}

function formatPlate(plate: PlateItem[]): string {
  if (plate.length === 0) return "_(empty)_";
  const bens = plate.filter((p) => p.person === "Ben");
  const others = plate.filter((p) => p.person !== "Ben");
  const lines: string[] = [];
  lines.push(`### Ben's plate (${bens.length})`);
  for (const p of bens.slice(0, 40)) {
    const meta = [
      p.category ?? "—",
      p.meeting_title ?? "—",
      `${p.age_days}d`,
      p.due_date ? `due ${p.due_date}` : "no deadline",
    ].join(" · ");
    lines.push(`- [${p.id.slice(0, 8)}] "${p.statement}" _(${meta})_`);
  }
  lines.push("");
  lines.push(`### Others' plates (${others.length})`);
  for (const p of others.slice(0, 25)) {
    lines.push(`- ${p.person ?? "?"}: "${p.statement}" _(${p.age_days}d · ${p.meeting_title ?? "—"})_`);
  }
  return lines.join("\n");
}

function formatAtoms(rows: AtomRow[], pick: (c: Record<string, unknown>) => string): string {
  if (rows.length === 0) return "_(none in window)_";
  return rows
    .slice(0, 20)
    .map((r) => {
      const who = r.source_title ? ` — ${r.source_title}` : "";
      const when = r.source_date ? ` (${r.source_date})` : "";
      return `- ${pick(r.content)}${who}${when}`;
    })
    .join("\n");
}

const SYSTEM_PROMPT = `You are Buddy, Ben Langsfeld's chief of staff agent. You are a reading partner on top of his morning briefing — not a task-list, not a replacement for the briefing. You translate across the agent crew (Guy, Dood, Bruh, Clark, Milli, Timi), hold Ben's CCO Forward Plan, and produce a sectioned briefing a capable chief of staff would write.

## Register (this is load-bearing)

Your reference is Town / Euclid. Warm-but-clinical prose. Declarative, argumentative, named people without introductions. Stacked declaratives with variable sentence length. Observational reporting. Why-now is woven into the same sentence as the fact — never a separate beat.

**Address Ben in second person.** "You committed," "your belief," "you said directly." Never refer to Ben in third person ("Ben said," "Ben's belief") — this briefing is TO Ben, not ABOUT Ben. Third-person leak = rewrite.

Counting and aging are load-bearing. "Three days, no signal." "Four weeks, status unknown." "The Attic work needs the pipeline back." Embed pressure in prose, never in tags.

Argumentative, not descriptive. Make claims. "Infrastructure decay is compounding faster than the output layer can compensate." "Neither books itself." "Will go cold if it sits another week."

No mood-lifting filler. Professional warmth — warm in register, not in content. No "great week!" No emojis anywhere in output prose.

## Banned words and phrases (instant retry if any appear)
leverage, ecosystem, seamless, robust, actionable, circle back, circling back, streamline, unlock, unlocks, unlocking, synergy, synergies, low-hanging, move the needle, stakeholder, touch base

## The sections you produce

**opener** — 1-2 sentences setting the Monday/Tuesday/etc. contextual frame. Warm, specific, not a summary.

**attention** — 3-5 threads worth the morning. Each has a title (short bold lede, <80 chars) and a body (2-4 sentences of prose). The body weaves cross-agent synthesis, the why-now, and the suggested move into one paragraph. No bullet sub-lists. No emojis. No status tags in parens.

**carried_forward** — 1-5 items aging without resolution. Same title + body shape. Age attached in prose ("Deadline passed yesterday," "Four weeks, no signal"). Reserve for items 7+ days old OR with a missed deadline. Each carried-forward body MUST end with a forcing-function sentence — a concrete decision the reader can make today. "Retire, defer, or ship." "Push Russell for status today or drop it." Not "if it's not progressing, Thursday will force the conversation" — that's hedging. State the forcing function directly.

**others_owe_you** — 2-6 items. Person name, short description, age-phrase ("Three days, no signal.", "Four weeks, no closure."). Pulled from others' open commitments in the heard list.

**patterns** — 1-3 cross-cutting observations. Argumentative. Untethered from any specific item. "Infrastructure decay is compounding faster than the output layer can compensate." Not tied to commitments — rises above them.

**tasks_can_help_with** — 2-4 concrete leverage offers. Each has a bolded title and 1-2 sentences describing what Buddy will produce if asked. When the offer is a draft message or note, produce the draft field — full text, in Ben's voice, ready to copy-paste. Otherwise draft is null.

**quiet_note** — only set this when the day is genuinely quiet. Don't manufacture urgency. If set, reduce attention threads to 0-2.

## Drafts in Ben's voice

When you draft a Slack message, email, or note: stacked declaratives, variable length, observational, warm without performing, no corporate hedging. Short. No "circling back," no "just wanted to follow up." Direct openers — "Hey Daniell — South by London dates for June?"

## Procrastination awareness

If an item has clearly been deferred multiple times and nothing is moving, carry_forward is the right container. Some commitments are extraction artifacts, not intent — one of the tasks_can_help_with offers should frame this as a decide-or-retire check when a candidate is obvious.

## Output

Call the \`synthesize\` tool. No JSON in text. No prose outside the tool call.`;

const SYNTHESIZE_TOOL = {
  name: "synthesize",
  description: "Emit Buddy's sectioned briefing across the agent crew.",
  input_schema: {
    type: "object" as const,
    properties: {
      opener: {
        type: "string",
        description: "1-2 sentences setting the contextual frame. Warm, specific.",
      },
      attention: {
        type: "array",
        description: "3-5 threads worth the morning. 0-2 if quiet.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short bold lede, <80 chars" },
            body: { type: "string", description: "2-4 sentences of prose. Cross-agent synthesis + why-now + move, woven together." },
            source_signals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["agent", "commitment", "atom", "plan"] },
                  ref: { type: "string" },
                  summary: { type: "string" },
                },
                required: ["kind", "ref", "summary"],
              },
            },
          },
          required: ["title", "body", "source_signals"],
        },
      },
      carried_forward: {
        type: "array",
        description: "Items aging without resolution. 7+ days old OR missed deadline.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string", description: "Age embedded in prose" },
            source_signals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["agent", "commitment", "atom", "plan"] },
                  ref: { type: "string" },
                  summary: { type: "string" },
                },
                required: ["kind", "ref", "summary"],
              },
            },
          },
          required: ["title", "body", "source_signals"],
        },
      },
      others_owe_you: {
        type: "array",
        description: "What others owe Ben. 2-6 items, aged.",
        items: {
          type: "object",
          properties: {
            person: { type: "string" },
            description: { type: "string" },
            age: { type: "string", description: 'Age-phrase, e.g. "Three days, no signal."' },
          },
          required: ["person", "description", "age"],
        },
      },
      patterns: {
        type: "array",
        description: "1-3 cross-cutting observations. Argumentative.",
        items: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
      },
      tasks_can_help_with: {
        type: "array",
        description: "2-4 concrete leverage offers. Draft field filled when applicable.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            draft: {
              type: ["string", "null"],
              description: "Full copy-paste-ready artifact text in Ben's voice. Null when not a draft task.",
            },
          },
          required: ["title", "description"],
        },
      },
      quiet_note: {
        type: ["string", "null"],
        description: "Set only on genuinely quiet days. Null otherwise.",
      },
    },
    required: ["opener", "attention", "carried_forward", "others_owe_you", "patterns", "tasks_can_help_with"],
  },
};

// ── Banned-word validator ──────────────────────────

function findBannedWords(s: BuddySynthesis): string[] {
  const warnings: string[] = [];
  const scan = (text: string, where: string) => {
    const lower = text.toLowerCase();
    for (const bw of BANNED_WORDS) {
      if (lower.includes(bw)) warnings.push(`${where}: "${bw}"`);
    }
  };
  scan(s.opener, "opener");
  s.attention.forEach((t, i) => {
    scan(t.title, `attention[${i}].title`);
    scan(t.body, `attention[${i}].body`);
  });
  s.carried_forward.forEach((t, i) => {
    scan(t.title, `carried_forward[${i}].title`);
    scan(t.body, `carried_forward[${i}].body`);
  });
  s.others_owe_you.forEach((o, i) => {
    scan(o.description, `others_owe_you[${i}].description`);
    scan(o.age, `others_owe_you[${i}].age`);
  });
  s.patterns.forEach((p, i) => scan(p.body, `patterns[${i}].body`));
  s.tasks_can_help_with.forEach((t, i) => {
    scan(t.title, `tasks[${i}].title`);
    scan(t.description, `tasks[${i}].description`);
    if (t.draft) scan(t.draft, `tasks[${i}].draft`);
  });
  if (s.quiet_note) scan(s.quiet_note, "quiet_note");
  return warnings;
}

// ── Entrypoint ─────────────────────────────────────

export async function runBuddySynthesis(): Promise<BuddySynthesis> {
  const sinceIso = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const [siblings, plate, kept, tensions, beliefs, voice, plan] = await Promise.all([
    readSiblings(),
    readPlate(),
    readPersonalCommitments({ includeDone: false }).catch((err) => {
      console.warn("kept list read failed — continuing without:", err instanceof Error ? err.message : err);
      return [];
    }),
    readAtomsByType("tension", sinceIso, 25),
    readAtomsByType("belief", sinceIso, 25),
    readAtomsByType("voice", sinceIso, 15),
    readForwardPlanHighlights(),
  ]);

  const context: string[] = [];
  context.push("# Sibling agents — latest reports");
  context.push("");
  context.push(formatSiblings(siblings));
  context.push("");
  context.push(`# Ben's commitments — heard list (from meetings, open)`);
  context.push(formatPlate(plate));
  context.push("");
  context.push(`# Ben's kept list — Notion Personal Commitments (${kept.length} open)`);
  if (kept.length === 0) {
    context.push("_(empty or inaccessible)_");
  } else {
    for (const k of kept.slice(0, 30)) {
      const meta = [k.category, k.status, k.priority, k.due_date && `due ${k.due_date}`]
        .filter(Boolean)
        .join(" · ");
      context.push(`- "${k.name}" _(${meta || "—"})_`);
    }
  }
  context.push("");
  context.push(`# Recent tensions (${tensions.length}, 14d)`);
  context.push(formatAtoms(tensions, (c) => (c.tension as string) ?? JSON.stringify(c).slice(0, 160)));
  context.push("");
  context.push(`# Recent beliefs (${beliefs.length}, 14d)`);
  context.push(formatAtoms(beliefs, (c) => (c.belief as string) ?? (c.statement as string) ?? JSON.stringify(c).slice(0, 160)));
  context.push("");
  context.push(`# Recent voice moments (${voice.length}, 14d)`);
  context.push(formatAtoms(voice, (c) => (c.quote as string) ?? (c.line as string) ?? JSON.stringify(c).slice(0, 160)));
  context.push("");
  if (plan) {
    context.push("# Ben's CCO Forward Plan — priorities + Q1/Q2");
    context.push(plan);
    context.push("");
  }
  context.push("---");
  context.push("Produce the sectioned briefing. Call the synthesize tool. Town register. Banned words will cause a retry.");

  const anthropic = getAnthropicClient(120_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [SYNTHESIZE_TOOL],
    tool_choice: { type: "tool", name: "synthesize" },
    messages: [{ role: "user", content: context.join("\n") }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("synthesis did not call synthesize tool");
  }
  const parsed = toolUse.input as Partial<BuddySynthesis>;

  const synthesis: BuddySynthesis = {
    generated_at: new Date().toISOString(),
    opener: parsed.opener ?? "",
    attention: Array.isArray(parsed.attention) ? parsed.attention : [],
    carried_forward: Array.isArray(parsed.carried_forward) ? parsed.carried_forward : [],
    others_owe_you: Array.isArray(parsed.others_owe_you) ? parsed.others_owe_you : [],
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
    tasks_can_help_with: Array.isArray(parsed.tasks_can_help_with) ? parsed.tasks_can_help_with : [],
    quiet_note: parsed.quiet_note ?? null,
    siblings_read: siblings.map((s) => s.persona),
    corpus_sizes: {
      plate: plate.length,
      kept: kept.length,
      tensions: tensions.length,
      beliefs: beliefs.length,
    },
    voice_warnings: [],
    // Sidecars — captured verbatim so the semantic reply interpreter can
    // resolve "the gmail one" against what was on the list when Ben read
    // the briefing, not against whatever Notion looks like minutes later.
    kept_index: kept.slice(0, 30).map((k) => ({
      page_id: k.id,
      name: k.name,
      category: k.category,
      status: k.status,
      due_date: k.due_date,
    })),
    plate_index: plate.slice(0, 40).map((p) => ({
      commitment_id: p.id,
      statement: p.statement,
      person: p.person,
      due_date: p.due_date,
      age_days: p.age_days,
    })),
  };

  // Banned-word check + one retry. Fresh call with the leaked output
  // + critique as the user message, so we don't have to thread tool_use/
  // tool_result pairs through the conversation.
  let warnings = findBannedWords(synthesis);
  if (warnings.length > 0) {
    const retry = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [SYNTHESIZE_TOOL],
      tool_choice: { type: "tool", name: "synthesize" },
      messages: [
        {
          role: "user",
          content:
            `${context.join("\n")}\n\n---\n\n` +
            `A prior synthesis draft leaked banned words: ${warnings.join(", ")}. ` +
            `Produce the same sectioned briefing with the same data, but rewrite every sentence that contained a banned word using different vocabulary. Here is the leaked draft for reference:\n\n` +
            JSON.stringify({
              opener: synthesis.opener,
              attention: synthesis.attention,
              carried_forward: synthesis.carried_forward,
              others_owe_you: synthesis.others_owe_you,
              patterns: synthesis.patterns,
              tasks_can_help_with: synthesis.tasks_can_help_with,
              quiet_note: synthesis.quiet_note,
            }, null, 2),
        },
      ],
    });
    const retryTool = retry.content.find((b) => b.type === "tool_use");
    if (retryTool && retryTool.type === "tool_use") {
      const retryParsed = retryTool.input as Partial<BuddySynthesis>;
      Object.assign(synthesis, {
        opener: retryParsed.opener ?? synthesis.opener,
        attention: Array.isArray(retryParsed.attention) ? retryParsed.attention : synthesis.attention,
        carried_forward: Array.isArray(retryParsed.carried_forward) ? retryParsed.carried_forward : synthesis.carried_forward,
        others_owe_you: Array.isArray(retryParsed.others_owe_you) ? retryParsed.others_owe_you : synthesis.others_owe_you,
        patterns: Array.isArray(retryParsed.patterns) ? retryParsed.patterns : synthesis.patterns,
        tasks_can_help_with: Array.isArray(retryParsed.tasks_can_help_with) ? retryParsed.tasks_can_help_with : synthesis.tasks_can_help_with,
        quiet_note: retryParsed.quiet_note ?? synthesis.quiet_note,
      });
      warnings = findBannedWords(synthesis);
    }
  }
  synthesis.voice_warnings = warnings;

  return synthesis;
}

// ── Formatters ─────────────────────────────────────

export function formatBriefing(s: BuddySynthesis): string {
  const lines: string[] = [];
  if (s.opener) {
    lines.push(s.opener);
    lines.push("");
  }
  if (s.quiet_note) {
    lines.push(`_${s.quiet_note}_`);
    lines.push("");
  }

  if (s.attention.length > 0) {
    lines.push("## Worth your attention");
    lines.push("");
    for (const t of s.attention) {
      lines.push(`**${t.title}** ${t.body}`);
      lines.push("");
    }
  }

  if (s.carried_forward.length > 0) {
    lines.push("## Carried forward — the ones to watch");
    lines.push("");
    for (const t of s.carried_forward) {
      lines.push(`**${t.title}** ${t.body}`);
      lines.push("");
    }
  }

  if (s.others_owe_you.length > 0) {
    lines.push("## What others owe you");
    lines.push("");
    for (const o of s.others_owe_you) {
      lines.push(`**${o.person} — ${o.description}.** ${o.age}`);
      lines.push("");
    }
  }

  if (s.patterns.length > 0) {
    lines.push("## Patterns");
    lines.push("");
    for (const p of s.patterns) {
      lines.push(p.body);
      lines.push("");
    }
  }

  if (s.tasks_can_help_with.length > 0) {
    lines.push("## Tasks I can help with");
    lines.push("");
    for (const t of s.tasks_can_help_with) {
      lines.push(`- **${t.title}** — ${t.description}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/** When Ben picks a specific attention or carried item to work on. */
export function formatItemFocus(item: AttentionThread | CarriedItem): string {
  const lines: string[] = [];
  lines.push(`**${item.title}**`);
  lines.push("");
  lines.push(item.body);
  if (item.source_signals.length > 0) {
    lines.push("");
    lines.push("_Why I flagged this:_");
    for (const sig of item.source_signals) {
      lines.push(`  · ${sig.ref} — ${sig.summary}`);
    }
  }
  return lines.join("\n");
}

/** When Ben accepts a task offer — surface the draft if one exists. */
export function formatTaskDelivery(task: TaskOffer): string {
  const lines: string[] = [];
  lines.push(`**${task.title}**`);
  lines.push("");
  if (task.draft) {
    lines.push("```");
    lines.push(task.draft);
    lines.push("```");
  } else {
    lines.push(task.description);
  }
  return lines.join("\n");
}

// ── Persistence — per-chat synthesis context ───────

/**
 * Stash the synthesis as a pending menu for this chat. Most recent wins.
 * Replies like "2", "#3", "task 1" resolve against this menu until a new
 * synthesis supersedes it (or Ben explicitly resolves it).
 */
export async function storeSynthesisMenu(
  chat_id: number,
  synthesis: BuddySynthesis,
): Promise<string> {
  const supabase = getSupabaseAdmin();
  // Close any open synthesis menu for this chat — latest wins.
  await supabase
    .from("buddy_pending_menus")
    .update({ resolved_at: new Date().toISOString() })
    .eq("chat_id", chat_id)
    .eq("kind", "synthesis")
    .is("resolved_at", null);

  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .insert({ chat_id, kind: "synthesis", items: synthesis })
    .select("id")
    .single();
  if (error) throw new Error(`synthesis menu insert: ${error.message}`);
  return data.id as string;
}

async function fetchLatestSynthesisMenu(
  chat_id: number,
): Promise<{ id: string; synthesis: BuddySynthesis } | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .select("id, items")
    .eq("chat_id", chat_id)
    .eq("kind", "synthesis")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`synthesis menu query: ${error.message}`);
  if (!data) return null;
  return { id: data.id as string, synthesis: data.items as BuddySynthesis };
}

// ── Daily surface entrypoint ───────────────────────

export interface BuddySurfaceResult {
  synthesis: BuddySynthesis;
  menu_id: string;
  message: string;
}

/**
 * Run the synthesis, stash it as a pending menu for this chat, return the
 * formatted briefing. Caller sends to Telegram — this function is
 * transport-agnostic so the orchestrator can reuse it.
 *
 * Writes a heartbeat pulse on exit (non-fatal). Expected cadence: daily
 * (30h slack window).
 */
export async function runBuddySurface(chat_id: number): Promise<BuddySurfaceResult> {
  const synthesis = await runBuddySynthesis();
  const menu_id = await storeSynthesisMenu(chat_id, synthesis);
  const message = formatBriefing(synthesis);

  // Pulse — absence of a fresh pulse means Buddy didn't surface today.
  await beat({
    source: "agent.ea.synthesis",
    status: synthesis.voice_warnings.length > 0 ? "attention" : "ok",
    summary:
      synthesis.quiet_note ??
      `${synthesis.attention.length} attention · ${synthesis.carried_forward.length} carried · ${synthesis.others_owe_you.length} owed · ${synthesis.patterns.length} patterns`,
    cadenceHours: 30,
    metadata: {
      menu_id,
      voice_warnings: synthesis.voice_warnings,
      corpus_sizes: synthesis.corpus_sizes,
      siblings_read: synthesis.siblings_read,
    },
  });

  return { synthesis, menu_id, message };
}

// ── Reply resolution — "2", "#3", "task 1" ─────────

export interface SynthesisReply {
  kind: "item" | "task" | "none";
  /** 1-indexed reference Ben used */
  index: number | null;
  /** Resolved body to send back */
  message: string;
  /** Which section the reference hit (for logging / analytics) */
  section: "attention" | "carried_forward" | "tasks_can_help_with" | null;
}

/**
 * Parse a Telegram reply against the most recent synthesis menu for this
 * chat. Returns kind="none" when the text doesn't reference the synthesis —
 * caller should fall through to the main classifier in that case.
 *
 * Supported shapes (v1):
 *   "2", "#2", " 2 "                       → attention[1]
 *   "task 1", "help 2", "t1"               → tasks_can_help_with[0]
 *   "carry 1", "watch 2", "c1"             → carried_forward[0]
 */
export async function resolveSynthesisReply(
  chat_id: number,
  text: string,
): Promise<SynthesisReply> {
  const none = (msg = ""): SynthesisReply => ({
    kind: "none",
    index: null,
    message: msg,
    section: null,
  });

  const trimmed = text.trim();
  if (!trimmed) return none();

  // Only look up the DB if the reply shape plausibly references the menu —
  // avoids a round-trip on every message.
  const patterns = [
    { rx: /^#?\s*(\d+)$/, section: "attention" as const },
    { rx: /^task\s*#?\s*(\d+)$/i, section: "tasks_can_help_with" as const },
    { rx: /^help\s*#?\s*(\d+)$/i, section: "tasks_can_help_with" as const },
    { rx: /^t\s*(\d+)$/i, section: "tasks_can_help_with" as const },
    { rx: /^carry\s*#?\s*(\d+)$/i, section: "carried_forward" as const },
    { rx: /^watch\s*#?\s*(\d+)$/i, section: "carried_forward" as const },
    { rx: /^c\s*(\d+)$/i, section: "carried_forward" as const },
  ];

  let match: { index: number; section: SynthesisReply["section"] } | null = null;
  for (const { rx, section } of patterns) {
    const m = trimmed.match(rx);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (!isNaN(idx) && idx > 0) {
        match = { index: idx, section };
        break;
      }
    }
  }
  if (!match) return none();

  const menu = await fetchLatestSynthesisMenu(chat_id);
  if (!menu) {
    return {
      kind: "none",
      index: match.index,
      message: "No recent synthesis to reference. Wait for the next briefing or run `buddy surface` now.",
      section: match.section,
    };
  }

  const s = menu.synthesis;
  if (match.section === "attention") {
    const item = s.attention[match.index - 1];
    if (!item) {
      return {
        kind: "none",
        index: match.index,
        message: `No attention thread #${match.index} — today's briefing had ${s.attention.length}.`,
        section: "attention",
      };
    }
    return {
      kind: "item",
      index: match.index,
      message: formatItemFocus(item),
      section: "attention",
    };
  }

  if (match.section === "carried_forward") {
    const item = s.carried_forward[match.index - 1];
    if (!item) {
      return {
        kind: "none",
        index: match.index,
        message: `No carried-forward item #${match.index} — today's briefing had ${s.carried_forward.length}.`,
        section: "carried_forward",
      };
    }
    return {
      kind: "item",
      index: match.index,
      message: formatItemFocus(item),
      section: "carried_forward",
    };
  }

  // tasks_can_help_with
  const task = s.tasks_can_help_with[match.index - 1];
  if (!task) {
    return {
      kind: "none",
      index: match.index,
      message: `No task #${match.index} — today's briefing had ${s.tasks_can_help_with.length}.`,
      section: "tasks_can_help_with",
    };
  }
  return {
    kind: "task",
    index: match.index,
    message: formatTaskDelivery(task),
    section: "tasks_can_help_with",
  };
}
