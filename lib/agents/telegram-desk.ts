/**
 * Keys — the Desk. Telegram front door for Ben's agent ecosystem.
 *
 * Webhook handler: receives Telegram Updates, classifies the message,
 * proposes a destination, stores the capture, replies.
 *
 * v0.1 scope: capture + classify + store + reply. No voice retrieval yet,
 * no scatter-rate push-back yet, no complex queries. Foundation.
 *
 * Endpoint: POST /api/telegram/webhook
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { readLatestAgentOutput } from "@/lib/agents/agent-output";
import { runTimiQuery } from "@/lib/agents/notion-steward";
import { runBuddyQueryExtended, runBuddyAdd } from "@/lib/agents/ea";
import {
  runBuddyPromoteSurface,
  resolvePromotionReply,
} from "@/lib/agents/buddy-promote";
import {
  runBuddyCloseSurface,
  resolveCloseReply,
} from "@/lib/agents/buddy-close";
import {
  runBuddySurface,
  resolveSynthesisReply,
} from "@/lib/agents/buddy-synthesize";
import { runMilliIngest } from "@/lib/agents/wiki-librarian";
import { runBruhQuery } from "@/lib/agents/what-if";

const MODEL = "claude-haiku-4-5-20251001";

// ── Telegram types (minimal) ───────────────────────
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number; url?: string }>;
}

// ── Classification ─────────────────────────────────
export type CaptureKind = "capture" | "query" | "command" | "unknown";
export type Destination =
  | "wiki-inbox"
  | "ideas"
  | "decisions"
  | "commitments"
  | "reference"
  | "loops"
  | "skip";

export type TargetAgent = "timi" | "buddy" | "guy" | "dood" | "bruh" | "clark" | "milli" | null;

export type AgentIntent =
  | "query"
  | "add"
  | "ingest"
  | "promote_surface"
  | "promote_reply"
  | "close_surface"
  | "close_reply"
  | "synthesis_surface"
  | "synthesis_reply";

interface Classification {
  kind: CaptureKind;
  destination: Destination | null;
  target_agent: TargetAgent;
  /** What Ben wants the agent to do. Most commands are queries. */
  intent: AgentIntent;
  question: string | null;
  reason: string;
  reply: string;
}

const SYSTEM_PROMPT = `You are Keys, the Telegram front door for Ben Langsfeld's agent ecosystem. You receive whatever Ben drops in (thoughts, links, voice notes, requests) and do these things:

1. Classify the message kind:
   - "capture" — a thought, link, or idea Ben wants saved
   - "query" — a question about his system (status, who, what)
   - "command" — a directive to an agent or to the system (e.g. "ask Timi X", "run Milli")
   - "unknown" — unclear, ask for clarification

2. For captures, propose a destination:
   - "wiki-inbox" — link or reference material (articles, videos, tools)
   - "ideas" — half-formed project ideas or pitches
   - "decisions" — a decision Ben is recording for himself
   - "commitments" — something he agreed to do
   - "reference" — factual info he wants to look up later
   - "loops" — an open thread/question he needs to return to
   - "skip" — probably shouldn't be saved (ephemeral chatter)

3. For commands, identify the target agent, the intent, and the clean question:
   - target_agent: one of "timi" (Notion people), "buddy" (commitments/EA + Notion personal list), "guy" (pipeline health), "dood" (security), "bruh" (pitches/what-ifs), "clark" (voice/essays), "milli" (wiki), or null if no specific agent targeted
   - intent: default is "query". Other values:
     · "add" — writing a new item: "add to my list: X" / "remind me to X" / "add X to buddy" → target_agent: "buddy", intent: "add", question: the clean statement
     · "ingest" — a bare URL drop (with no other words or just "ingest this") → target_agent: "milli", intent: "ingest", question: the URL
     · "promote_surface" — "buddy promote" / "what should I promote" / "show me promotion candidates" / "surface new items for my list" → target_agent: "buddy", intent: "promote_surface", question: null
     · "close_surface" — "buddy cleanup" / "what's stale" / "clean up my list" / "close loop" → target_agent: "buddy", intent: "close_surface", question: null
     · "synthesis_surface" — "buddy surface" / "brief me" / "what should I be thinking about" / "morning read" / "what's rising" → target_agent: "buddy", intent: "synthesis_surface", question: null
     · (promote/close/synthesis replies like "promote 2,5", "done 1 recur 2", bare "2" are matched by regex before you see them — never emit reply intents yourself)
     · Everything else that names an agent → intent: "query"
   - question: the actual task/question stripped of dispatch words ("ask Timi who..." → question: "Who...")

4. Write a short reply. Rules:
   - For captures/queries: confirm what you did in 1-3 sentences, casual and warm.
   - For commands WITH a target_agent: do NOT promise the agent will respond — set reply to "dispatching to {agent}..." (a real answer will replace this). Never fake a confirmation.
   - For commands WITHOUT a target_agent: log it honestly as pending.

Match Ben's voice: compressed, no hedging, position-taking. No corporate tone.
Banned words: leverage, ecosystem, seamless, robust, unlock, dig into.

Return strict JSON only:
{
  "kind": "capture|query|command|unknown",
  "destination": "wiki-inbox|ideas|decisions|commitments|reference|loops|skip",
  "target_agent": "timi|buddy|guy|dood|bruh|clark|milli|null",
  "intent": "query|add|ingest",
  "question": "clean question or null",
  "reason": "one short sentence",
  "reply": "what you send back to Ben"
}

For non-commands, set target_agent, intent, and question to null/query. For non-captures, set destination to null.`;

function buildUserPrompt(text: string): string {
  return `Message from Ben:

"""
${text}
"""

Classify and respond. JSON only.`;
}

const VALID_AGENTS: TargetAgent[] = ["timi", "buddy", "guy", "dood", "bruh", "clark", "milli"];

const VALID_INTENTS: AgentIntent[] = [
  "query",
  "add",
  "ingest",
  "promote_surface",
  "promote_reply",
  "close_surface",
  "close_reply",
  "synthesis_surface",
  "synthesis_reply",
];

function parseClassification(raw: string): Classification | null {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!["capture", "query", "command", "unknown"].includes(parsed.kind)) return null;
    if (typeof parsed.reply !== "string") return null;
    const target = typeof parsed.target_agent === "string" && VALID_AGENTS.includes(parsed.target_agent as TargetAgent)
      ? (parsed.target_agent as TargetAgent)
      : null;
    const question = typeof parsed.question === "string" && parsed.question.trim().length > 0
      ? parsed.question.trim()
      : null;
    const intent: AgentIntent = VALID_INTENTS.includes(parsed.intent as AgentIntent)
      ? (parsed.intent as AgentIntent)
      : "query";
    return {
      kind: parsed.kind as CaptureKind,
      destination: parsed.destination ?? null,
      target_agent: target,
      intent,
      question,
      reason: parsed.reason ?? "",
      reply: parsed.reply,
    };
  } catch {
    return null;
  }
}

// ── Pre-classifier (regex short-circuit) ───────────
// Promote/close replies have a known shape. Matching them here saves a
// Haiku round-trip and keeps parsing deterministic.

const CLOSE_ACTION_VERBS = /\b(done|close[dn]?|complete[d]?|archive[d]?|recur(?:ring)?|keep|live|active)\b/i;

export function preClassify(text: string): Classification | null {
  const t = text.trim();
  if (!t) return null;

  // "promote 2,5" or "promote 2 as: rewrite"
  if (/^promote\s+\d/i.test(t)) {
    return {
      kind: "command",
      destination: null,
      target_agent: "buddy",
      intent: "promote_reply",
      question: t,
      reason: "matched promote-reply regex",
      reply: "dispatching to buddy...",
    };
  }

  // "done 1,4 recur 2 keep 3 archive 5,6" — must start with an action verb
  // followed by a digit, to avoid matching "done." as casual acknowledgement.
  if (/^(done|close[dn]?|complete[d]?|archive[d]?|recur(?:ring)?|keep)\s+\d/i.test(t)) {
    return {
      kind: "command",
      destination: null,
      target_agent: "buddy",
      intent: "close_reply",
      question: t,
      reason: "matched close-reply regex",
      reply: "dispatching to buddy...",
    };
  }

  // Also catch close replies that don't start with a verb (e.g. line breaks,
  // leading whitespace, or replies reformatted by Telegram). Require at least
  // TWO verb→digit patterns to avoid false positives like "keep active on 3
  // projects" (which has verbs but no verb-followed-by-digit structure).
  const verbDigitRx = /\b(done|close[dn]?|complete[d]?|archive[d]?|recur(?:ring)?|keep|live|active)\s+\d/gi;
  const verbDigitMatches = t.match(verbDigitRx);
  if (verbDigitMatches && verbDigitMatches.length >= 2) {
    return {
      kind: "command",
      destination: null,
      target_agent: "buddy",
      intent: "close_reply",
      question: t,
      reason: "matched close-reply multi-verb-digit shape",
      reply: "dispatching to buddy...",
    };
  }

  return null;
}

export async function classifyMessage(text: string): Promise<Classification> {
  try {
    const anthropic = getAnthropicClient(20_000);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(text) }],
    });
    const content = response.content[0];
    const raw = content.type === "text" ? content.text : "";
    const parsed = parseClassification(raw);
    if (!parsed) {
      return {
        kind: "unknown",
        destination: null,
        target_agent: null,
        intent: "query",
        question: null,
        reason: "classifier parse failure",
        reply: "Got it, but couldn't classify. Filed as unknown — check back at /boot.",
      };
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "unknown",
      destination: null,
      target_agent: null,
      intent: "query",
      question: null,
      reason: `classifier error: ${msg}`,
      reply: "Classifier offline — stored as unknown. I'll retry later.",
    };
  }
}

// ── Storage ────────────────────────────────────────
export async function storeCapture(
  update: TelegramUpdate,
  classification: Classification,
): Promise<{ id: string }> {
  const msg = update.message ?? update.edited_message;
  if (!msg) throw new Error("No message in update");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("desk_captures")
    .insert({
      telegram_user_id: msg.from?.id ?? 0,
      telegram_chat_id: msg.chat.id,
      telegram_message_id: msg.message_id,
      raw_text: msg.text ?? msg.caption ?? null,
      raw_payload: update,
      kind: classification.kind,
      proposed_destination: classification.destination,
      classification_reason: classification.reason,
      status: "pending",
      reply_text: classification.reply,
    })
    .select("id")
    .single();
  if (error) throw new Error(`desk_captures insert: ${error.message}`);
  return { id: data.id as string };
}

// ── Telegram reply ─────────────────────────────────
const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramReply(
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

// ── Query answering (reads all siblings) ───────────

async function gatherSiblingContext(): Promise<string> {
  const [guy, buddy, dood, bruh, milli, timi] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
    readLatestAgentOutput("security-steward"),
    readLatestAgentOutput("what-if"),
    readLatestAgentOutput("wiki-librarian"),
    readLatestAgentOutput("notion-steward"),
  ]);

  const lines: string[] = [];
  if (guy) lines.push(`**Guy (pipeline)** [${guy.severity}]: ${guy.markdown.slice(0, 300)}`);
  if (buddy) lines.push(`**Buddy (EA)** [${buddy.severity}]: ${buddy.markdown.slice(0, 300)}`);
  if (dood) lines.push(`**Dood (security)** [${dood.severity}]: ${dood.markdown.slice(0, 300)}`);
  if (bruh) lines.push(`**Bruh (pitches)** [${bruh.severity}]: ${bruh.markdown.slice(0, 300)}`);
  if (milli) lines.push(`**Milli (wiki)** [${milli.severity}]: ${milli.markdown.slice(0, 200)}`);
  if (timi) lines.push(`**Timi (Notion)** [${timi.severity}]: ${timi.markdown.slice(0, 400)}`);
  return lines.join("\n\n");
}

const QUERY_SYSTEM = `You are Keys, Ben Langsfeld's Telegram front door. Ben just asked a question. You have:
1. The latest reports from his agents (Guy, Buddy, Dood, Bruh, Clark, Milli, Timi)
2. Direct data from his Grain database (voice atoms, quotes, commitments, recent transcripts)
3. Timi's Notion report covers People Intelligence and LinkedIn Prospects — refer to it for anything about stakeholders, enrichment status, or prospect pipeline

Answer using whichever source has the answer. Be concise (2-6 sentences). Casual, warm, direct. Quote exact voice atoms or quotes when relevant — don't paraphrase, give him the real words.

Banned: leverage, ecosystem, seamless, robust.`;

// ── Direct DB queries for specific lookups ──────────

async function gatherQueryData(question: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const q = question.toLowerCase();
  const lines: string[] = [];

  // Voice atoms
  if (q.includes("voice") || q.includes("quote") || q.includes("moment") || q.includes("compression") || q.includes("reframe") || q.includes("leaderboard")) {
    const limit = q.match(/(\d+)\s*(voice|quote|moment)/)?.[1];
    const n = limit ? Math.min(parseInt(limit), 20) : 5;

    const { data } = await supabase
      .from("dx_atoms")
      .select("content, source_title, source_date")
      .eq("type", "voice")
      .order("created_at", { ascending: false })
      .limit(n);

    if (data?.length) {
      lines.push(`## Last ${data.length} voice atoms:`);
      for (const r of data) {
        const c = r.content as Record<string, string>;
        lines.push(`- "${c.quote}" — ${c.why_it_works ?? ""}`);
        lines.push(`  From: ${r.source_title} (${r.source_date})`);
      }
      lines.push("");
    }
  }

  // Commitments — join with labels so Keys respects Buddy's training
  if (q.includes("commitment") || q.includes("open loop") || q.includes("what did i") || q.includes("owe") || q.includes("promised")) {
    const { data } = await supabase
      .from("dx_commitments")
      .select("id, statement, person, category, meeting_date, status, commitment_labels(weight, reason)")
      .eq("status", "open")
      .order("meeting_date", { ascending: false })
      .limit(15);

    if (data?.length) {
      // Separate real commitments from scaffolding using Buddy's labels
      type Row = { id: string; statement: string; person: string | null; category: string | null; meeting_date: string | null; status: string | null; commitment_labels: Array<{ weight: string; reason: string | null }> | { weight: string; reason: string | null } | null };
      const rows = data as unknown as Row[];
      const real: Row[] = [];
      const skipped: string[] = [];

      for (const r of rows) {
        const label = Array.isArray(r.commitment_labels) ? r.commitment_labels[0] : r.commitment_labels;
        if (label?.weight === "skip") {
          skipped.push(r.statement);
        } else {
          real.push(r);
        }
      }

      lines.push(`## Open commitments (${real.length} real, ${skipped.length} filtered as scaffolding):`);
      for (const r of real) {
        const label = Array.isArray(r.commitment_labels) ? r.commitment_labels[0] : r.commitment_labels;
        const weightTag = label ? ` [${label.weight}]` : "";
        lines.push(`- ${r.person}: "${r.statement}"${weightTag} (${r.category}, ${r.meeting_date})`);
      }
      if (skipped.length > 0) {
        lines.push(`\n_Filtered ${skipped.length} items Buddy labeled as skip (scaffolding/logistics)._`);
      }
      lines.push("");
    }
  }

  // Recent meetings/transcripts
  if (q.includes("meeting") || q.includes("transcript") || q.includes("last call") || q.includes("talked about")) {
    // NULLS LAST + filter — legacy Source v2 `source_type='transcript'` rows
    // with NULL source_date would otherwise bubble to the top of a DESC sort
    // (Postgres DESC defaults to NULLS FIRST) and fool Keys into reporting
    // February titles as "the latest transcripts."
    const { data } = await supabase
      .from("dx_transcripts")
      .select("source_title, source_date, source_type, participants")
      .not("source_date", "is", null)
      .order("source_date", { ascending: false, nullsFirst: false })
      .limit(5);

    if (data?.length) {
      lines.push("## Recent meetings:");
      for (const r of data) {
        const participants = r.participants as Array<{ name: string }> | null;
        const names = participants?.map((p) => p.name).join(", ") ?? "?";
        lines.push(`- ${r.source_title} (${r.source_date}) — ${names}`);
      }
      lines.push("");
    }
  }

  // Vault content (wiki, projects, priorities, decisions from vault_snapshots)
  if (q.includes("wiki") || q.includes("skill") || q.includes("technique") || q.includes("pattern") || q.includes("how-to") || q.includes("howto")) {
    const { data } = await supabase
      .from("vault_snapshots")
      .select("content")
      .in("kind", ["wiki_index", "wiki_pages"])
      .limit(2);
    if (data?.length) {
      for (const r of data) {
        lines.push((r.content as string).slice(0, 2000));
      }
      lines.push("");
    }
  }

  if (q.includes("project") || q.includes("app") || q.includes("what am i building") || q.includes("stack") || q.includes("canvas") || q.includes("grain") || q.includes("lore") || q.includes("buck") || q.includes("source")) {
    const { data } = await supabase
      .from("vault_snapshots")
      .select("content")
      .eq("kind", "project_summaries")
      .maybeSingle();
    if (data) {
      lines.push("## Project summaries from vault:");
      lines.push((data.content as string).slice(0, 2500));
      lines.push("");
    }
  }

  if (q.includes("priorit") || q.includes("what's hot") || q.includes("what am i focused") || q.includes("initiative")) {
    const { data } = await supabase
      .from("vault_snapshots")
      .select("content")
      .eq("kind", "active_priorities")
      .maybeSingle();
    if (data) {
      lines.push("## Active priorities:");
      lines.push((data.content as string).slice(0, 1500));
      lines.push("");
    }
  }

  // Tensions
  if (q.includes("tension") || q.includes("conflict") || q.includes("friction")) {
    const { data } = await supabase
      .from("dx_atoms")
      .select("content, source_date")
      .eq("type", "tension")
      .order("created_at", { ascending: false })
      .limit(8);

    if (data?.length) {
      lines.push("## Recent tensions:");
      for (const r of data) {
        const c = r.content as Record<string, string>;
        lines.push(`- ${c.pair || c.title || c.name || "?"} (${r.source_date})`);
      }
      lines.push("");
    }
  }

  // Notion / People Intelligence / Prospects — route to Timi's latest report
  if (
    q.includes("notion") ||
    q.includes("people intel") ||
    q.includes("prospect") ||
    q.includes("linkedin") ||
    q.includes("enrichment") ||
    q.includes("stale people") ||
    q.includes("who should i enrich") ||
    q.includes("who to reach out") ||
    q.includes("promotion candidate") ||
    q.includes("timi")
  ) {
    const timi = await readLatestAgentOutput("notion-steward");
    if (timi) {
      lines.push(`## Timi's latest Notion report [${timi.severity}, ${timi.run_at}]`);
      lines.push(timi.markdown.slice(0, 2500));
      lines.push("");
    }
  }

  // Decisions
  if (q.includes("decision") || q.includes("decided") || q.includes("agreed")) {
    const { data } = await supabase
      .from("dx_atoms")
      .select("content, source_title, source_date")
      .eq("type", "decision")
      .order("created_at", { ascending: false })
      .limit(8);

    if (data?.length) {
      lines.push("## Recent decisions:");
      for (const r of data) {
        const c = r.content as Record<string, string>;
        lines.push(`- ${c.statement || c.decision || c.title || "?"} — ${r.source_title} (${r.source_date})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function answerQuery(question: string): Promise<string> {
  const [siblingContext, dbContext] = await Promise.all([
    gatherSiblingContext(),
    gatherQueryData(question),
  ]);

  if (!siblingContext && !dbContext) return "None of the agents have reported yet and I couldn't find matching data. Boot a session and run them first.";

  try {
    const anthropic = getAnthropicClient(20_000);
    const context = [
      dbContext ? `# Direct from database\n\n${dbContext}` : "",
      siblingContext ? `# Agent reports\n\n${siblingContext}` : "",
    ].filter(Boolean).join("\n\n---\n\n");

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: QUERY_SYSTEM,
      messages: [{
        role: "user",
        content: `${context}\n\n---\n\nBen's question: "${question}"\n\nAnswer concisely. Quote exact data when available.`,
      }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    return text || "Couldn't generate an answer. Check /boot for full reports.";
  } catch {
    return "Query processing failed. Agent reports are available at /boot.";
  }
}

// ── Command dispatch ───────────────────────────────
// When Ben sends "ask Timi X" / "tell Bruh Y", classifier sets target_agent
// and question. This function actually runs the agent and returns its
// answer. Only Timi has a query entrypoint in v1 — other agents return
// honest "not wired yet" responses instead of faking confirmation.

async function dispatchAgentCommand(
  target: TargetAgent,
  intent: AgentIntent,
  question: string,
  chatId: number,
): Promise<string> {
  // Milli URL ingest — intent="ingest" routes here regardless of query/add shape.
  // Writes a stub to 00-inbox/; triage runs at 06:45 / 19:45 (or on-demand).
  if (target === "milli" && intent === "ingest") {
    try {
      const { url, kind, filename } = await runMilliIngest(question);
      return `Milli queued ${kind === "video" ? "video" : kind === "claude_chat" ? "chat" : "link"} for triage.\n→ _${filename}_\n\nShelved on the next tick.\n\n_${url}_`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Milli ingest failed: ${msg}`;
    }
  }

  // Buddy add — "add to list" flow writes to Notion Personal Commitments.
  if (target === "buddy" && intent === "add") {
    try {
      const { url, category, priority } = await runBuddyAdd({ statement: question, source: "Buddy" });
      return `Added to your list: "${question}"\n_${category} · ${priority}_\n${url}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Buddy add failed: ${msg}`;
    }
  }

  // Buddy promote — surface candidates from dx_commitments to Telegram.
  if (target === "buddy" && intent === "promote_surface") {
    try {
      const { message } = await runBuddyPromoteSurface(chatId);
      return message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Buddy promote failed: ${msg}`;
    }
  }

  // Buddy promote reply — "promote 2,5" or "promote 2 as: rewrite"
  if (target === "buddy" && intent === "promote_reply") {
    try {
      const { message } = await resolvePromotionReply(chatId, question);
      return message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Promote resolve failed: ${msg}`;
    }
  }

  // Buddy synthesis surface — the chief-of-staff briefing.
  if (target === "buddy" && intent === "synthesis_surface") {
    try {
      const { message } = await runBuddySurface(chatId);
      return message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Buddy synthesis failed: ${msg}`;
    }
  }

  // Buddy cleanup — surface stale items from Notion kept list.
  if (target === "buddy" && intent === "close_surface") {
    try {
      const { message } = await runBuddyCloseSurface(chatId);
      return message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Buddy cleanup failed: ${msg}`;
    }
  }

  // Buddy close reply — "done 1,4 recur 2 keep 3 archive 5,6"
  if (target === "buddy" && intent === "close_reply") {
    try {
      const { message } = await resolveCloseReply(chatId, question);
      return message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Close resolve failed: ${msg}`;
    }
  }

  switch (target) {
    case "timi": {
      try {
        const { answer, people_count } = await runTimiQuery(question);
        return `${answer}\n\n_Timi · ${people_count} people_`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Timi errored: ${msg}`;
      }
    }
    case "buddy": {
      try {
        const { answer, commitment_count } = await runBuddyQueryExtended(question);
        return `${answer}\n\n_Buddy · ${commitment_count} items scanned (kept + heard)_`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Buddy errored: ${msg}`;
      }
    }
    case "bruh": {
      try {
        const { answer, corpus_summary } = await runBruhQuery(question);
        const c = corpus_summary;
        return `${answer}\n\n_Bruh · corpus: ${c.tensions} tensions, ${c.decisions} decisions, ${c.commitments} commitments_`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Bruh errored: ${msg}`;
      }
    }
    case "guy":
    case "dood":
    case "clark":
      return `${target[0].toUpperCase() + target.slice(1)} doesn't have an on-demand query mode yet. Logged for the next cron run.`;
    case "milli":
      return "Milli handles URL ingest (drop a link — she queues it for the next triage tick). No query mode yet. Logged.";
    default:
      return "No target agent identified. Logged as a generic command.";
  }
}

// ── Authorization ──────────────────────────────────
// Only Ben's user ID should be allowed. Set TELEGRAM_ALLOWED_USER_ID env var.
export function isAuthorizedUser(update: TelegramUpdate): boolean {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed) return false;
  const msg = update.message ?? update.edited_message;
  if (!msg?.from) return false;
  return String(msg.from.id) === allowed.trim();
}

// ── Main handler ───────────────────────────────────
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<{
  ok: boolean;
  capture_id?: string;
  reason?: string;
}> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return { ok: false, reason: "no message" };

  if (!isAuthorizedUser(update)) {
    return { ok: false, reason: "unauthorized user" };
  }

  const text = msg.text ?? msg.caption ?? "";
  if (!text) {
    await sendTelegramReply(msg.chat.id, "_(empty message — nothing to capture)_", msg.message_id).catch(() => {});
    return { ok: false, reason: "empty text" };
  }

  // Synthesis reply short-circuit — "2", "#3", "task 1", "watch 2".
  // These reference the most recent Buddy briefing for this chat and don't
  // match any other regex. Checking first keeps the hot path fast; misses
  // return kind="none" and fall through to the normal pipeline.
  try {
    const synReply = await resolveSynthesisReply(msg.chat.id, text);
    if (synReply.kind === "item" || synReply.kind === "task") {
      const classification: Classification = {
        kind: "command",
        destination: null,
        target_agent: "buddy",
        intent: "synthesis_reply",
        question: text,
        reason: `synthesis ${synReply.section}[${synReply.index}]`,
        reply: synReply.message,
      };
      const { id } = await storeCapture(update, classification);
      await sendTelegramReply(msg.chat.id, synReply.message, msg.message_id).catch((err) =>
        console.error("telegram reply failed:", err),
      );
      return { ok: true, capture_id: id };
    }
  } catch (err) {
    console.error("synthesis reply resolution failed:", err);
    // fall through to normal pipeline
  }

  // Regex short-circuit for known reply shapes (promote/close). Saves a
  // Haiku round-trip and keeps parsing deterministic for known formats.
  const classification = preClassify(text) ?? (await classifyMessage(text));

  // If a target agent was identified (from a command OR a query worded like
  // "Buddy, show me..."), dispatch directly — fresher than summarizing the
  // agent's last cron output.
  if (classification.target_agent) {
    const question = classification.question || text;
    classification.reply = await dispatchAgentCommand(
      classification.target_agent,
      classification.intent,
      question,
      msg.chat.id,
    );
  } else if (classification.kind === "query") {
    // Generic query with no named agent — use sibling-context synthesis
    classification.reply = await answerQuery(text);
  }

  // Store
  const { id } = await storeCapture(update, classification);

  // Reply — dispatched and synthesized answers return the full body;
  // non-routed captures/commands get the classification tag appended
  const replyBody = (classification.target_agent || classification.kind === "query")
    ? classification.reply
    : [
        classification.reply,
        "",
        `_${classification.kind}${classification.destination ? ` → ${classification.destination}` : ""}_`,
      ].join("\n");

  try {
    await sendTelegramReply(msg.chat.id, replyBody, msg.message_id);
  } catch (err) {
    console.error("telegram reply failed:", err);
  }

  return { ok: true, capture_id: id };
}
