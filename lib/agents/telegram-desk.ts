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

interface Classification {
  kind: CaptureKind;
  destination: Destination | null;
  reason: string;
  reply: string;
}

const SYSTEM_PROMPT = `You are Keys, the Telegram front door for Ben Langsfeld's agent ecosystem. You receive whatever Ben drops in (thoughts, links, voice notes, requests) and do three things:

1. Classify the message kind:
   - "capture" — a thought, link, or idea Ben wants saved
   - "query" — a question about his system (status, who, what)
   - "command" — a directive (e.g. "run Milli", "show me Buddy's latest")
   - "unknown" — unclear, ask for clarification

2. For captures, propose a destination:
   - "wiki-inbox" — link or reference material (articles, videos, tools)
   - "ideas" — half-formed project ideas or pitches
   - "decisions" — a decision Ben is recording for himself
   - "commitments" — something he agreed to do
   - "reference" — factual info he wants to look up later
   - "loops" — an open thread/question he needs to return to
   - "skip" — probably shouldn't be saved (ephemeral chatter)

3. Write a short reply (1-3 sentences) confirming what you did. Casual, warm, direct. Match Ben's voice: compressed, no hedging, position-taking. No corporate tone. Banned words: leverage, ecosystem, seamless, robust, unlock.

Return strict JSON only:
{
  "kind": "capture|query|command|unknown",
  "destination": "wiki-inbox|ideas|decisions|commitments|reference|loops|skip",
  "reason": "one short sentence",
  "reply": "what you send back to Ben"
}

For query/command/unknown, set destination to null.`;

function buildUserPrompt(text: string): string {
  return `Message from Ben:

"""
${text}
"""

Classify and respond. JSON only.`;
}

function parseClassification(raw: string): Classification | null {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!["capture", "query", "command", "unknown"].includes(parsed.kind)) return null;
    if (typeof parsed.reply !== "string") return null;
    return {
      kind: parsed.kind as CaptureKind,
      destination: parsed.destination ?? null,
      reason: parsed.reason ?? "",
      reply: parsed.reply,
    };
  } catch {
    return null;
  }
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
  const [guy, buddy, dood, bruh, milli] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
    readLatestAgentOutput("security-steward"),
    readLatestAgentOutput("what-if"),
    readLatestAgentOutput("wiki-librarian"),
  ]);

  const lines: string[] = [];
  if (guy) lines.push(`**Guy (pipeline)** [${guy.severity}]: ${guy.markdown.slice(0, 300)}`);
  if (buddy) lines.push(`**Buddy (EA)** [${buddy.severity}]: ${buddy.markdown.slice(0, 300)}`);
  if (dood) lines.push(`**Dood (security)** [${dood.severity}]: ${dood.markdown.slice(0, 300)}`);
  if (bruh) lines.push(`**Bruh (pitches)** [${bruh.severity}]: ${bruh.markdown.slice(0, 300)}`);
  if (milli) lines.push(`**Milli (wiki)** [${milli.severity}]: ${milli.markdown.slice(0, 200)}`);
  return lines.join("\n\n");
}

const QUERY_SYSTEM = `You are Keys, Ben Langsfeld's Telegram front door. Ben just asked a question. You have access to the latest reports from his five agents. Answer his question using their findings. Be concise (2-5 sentences). Casual, warm, direct. If the answer isn't in the agent reports, say so and suggest he check at /boot.

Banned: leverage, ecosystem, seamless, robust.`;

async function answerQuery(question: string): Promise<string> {
  const context = await gatherSiblingContext();
  if (!context) return "None of the agents have reported yet. Boot a session and run them first.";

  try {
    const anthropic = getAnthropicClient(20_000);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: QUERY_SYSTEM,
      messages: [{
        role: "user",
        content: `Agent reports:\n\n${context}\n\n---\n\nBen's question: "${question}"\n\nAnswer concisely.`,
      }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    return text || "Couldn't generate an answer. Check /boot for full reports.";
  } catch {
    return "Query processing failed. Agent reports are available at /boot.";
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

  // Classify
  const classification = await classifyMessage(text);

  // For queries, enrich the reply with sibling context
  if (classification.kind === "query") {
    const answer = await answerQuery(text);
    classification.reply = answer;
  }

  // Store
  const { id } = await storeCapture(update, classification);

  // Reply
  const replyBody = classification.kind === "query"
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
