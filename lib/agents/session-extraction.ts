/**
 * Session extraction — voice + belief passes on Claude Code conversation.
 *
 * Adapts Grain's voice.ts and beliefs.ts prompts for session transcripts.
 * Ben's messages are the "You:" speaker. Claude's responses are context.
 * Quality-gated: if the session was tactical (mostly "proceed" and "yes"),
 * the extraction returns empty arrays. No forced output.
 *
 * Called by /wrap. Results written to dx_atoms with source_type: "session".
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";

const MODEL = "claude-haiku-4-5-20251001";

// ── Voice extraction (adapted from lib/prompts/voice.ts) ──

const SESSION_VOICE_PROMPT = `You are extracting the strongest verbal moments from a Claude Code working session. The user's messages (labeled "Ben:") are the source — these are their real-time compressions, reframes, metaphors, and philosophy captures.

This is NOT a meeting transcript. It's a technical/design conversation. Many sessions are purely tactical ("yes", "proceed", "looks good"). If the session was tactical with no notable verbal moments, return an empty array. Don't manufacture moments from routine exchanges.

Types of moments to capture (only when genuinely strong):
- **Compression**: Complex idea collapsed into one sentence
- **Reframe**: Shifted how to see a problem, changed the conversation's direction
- **Cross-domain bridge**: Mapped one domain onto another
- **Philosophy capture**: A belief system made tangible in the moment
- **Naming move**: Chose a name that encoded a design decision (e.g., "stewards not twins")
- **Kill decision**: Articulated why something should NOT be built — often more revealing than what to build

For each moment:
1. The exact quote (or tightest faithful version if Ben rambled)
2. Why it works — the specific technique
3. Where to use it — which kind of piece, argument, or audience
4. Context — what prompted it in the session

Return a JSON array:
[{"quote": "...", "why_it_works": "...", "use_it_for": "...", "context": "..."}]

Extract 0-8 moments. Quality over quantity. A coding session with zero moments is normal and correct. A brainstorm session with eight is also normal. Let the content decide.

ONLY return valid JSON. No commentary.`;

const SESSION_BELIEFS_PROMPT = `You are extracting beliefs from a Claude Code working session. Beliefs are convictions Ben is developing about how his world works — revealed through design decisions, architecture choices, pushback on suggestions, and how he frames problems.

This is NOT a meeting. It's a building session. Beliefs here show up as:
- Architecture convictions ("agents own corpora, not personas")
- Naming decisions that encode philosophy ("stewards, not twins")
- Repeated pushback patterns (what he rejects reveals what he believes)
- Design principles articulated in the moment

If the session was purely tactical with no design philosophy visible, return an empty array.

For each belief:
1. Statement as a clear declarative sentence
2. Class: stated / implied / aspirational
3. Confidence: strong / moderate / emerging
4. Evidence: what in the session supports this
5. Rules out: what becomes impossible if this belief is true

Return a JSON array:
[{"statement": "...", "class": "...", "confidence": "...", "evidence": "...", "rules_out": "..."}]

Extract 0-5 beliefs. Only include beliefs that would change architecture or strategy if they were different. If no real beliefs surface, return an empty array.

ONLY return valid JSON. No commentary.`;

// ── Parser ─────────────────────────────────────────

function parseJsonArray(raw: string): unknown[] {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to find array in the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { return JSON.parse(match[0]); } catch { return []; }
  }
}

// ── Extract + write ────────────────────────────────

interface ExtractionResult {
  voice_count: number;
  belief_count: number;
  voice_atoms: Array<{ quote: string; why_it_works: string; use_it_for: string; context: string }>;
  belief_atoms: Array<{ statement: string; class: string; confidence: string; evidence: string; rules_out: string }>;
}

export async function extractSessionAtoms(
  conversationHighlights: string,
  sessionTitle: string,
  project?: string,
): Promise<ExtractionResult> {
  if (!conversationHighlights || conversationHighlights.length < 100) {
    return { voice_count: 0, belief_count: 0, voice_atoms: [], belief_atoms: [] };
  }

  const anthropic = getAnthropicClient(30_000);

  // Run both passes in parallel
  const [voiceRes, beliefRes] = await Promise.all([
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SESSION_VOICE_PROMPT,
      messages: [{ role: "user", content: `Session: ${sessionTitle}\n\n${conversationHighlights}` }],
    }),
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SESSION_BELIEFS_PROMPT,
      messages: [{ role: "user", content: `Session: ${sessionTitle}\n\n${conversationHighlights}` }],
    }),
  ]);

  const voiceText = voiceRes.content[0]?.type === "text" ? voiceRes.content[0].text : "[]";
  const beliefText = beliefRes.content[0]?.type === "text" ? beliefRes.content[0].text : "[]";

  const voice_atoms = parseJsonArray(voiceText) as ExtractionResult["voice_atoms"];
  const belief_atoms = parseJsonArray(beliefText) as ExtractionResult["belief_atoms"];

  // Write to dx_atoms if anything was extracted
  if (voice_atoms.length > 0 || belief_atoms.length > 0) {
    const supabase = getSupabaseAdmin();
    const today = new Date().toISOString().slice(0, 10);
    const rows: Array<Record<string, unknown>> = [];

    for (const v of voice_atoms) {
      rows.push({
        type: "voice",
        content: v,
        source_title: sessionTitle,
        source_date: today,
        entities: project ? [project] : [],
        domain: "session",
      });
    }

    for (const b of belief_atoms) {
      rows.push({
        type: "belief",
        content: b,
        source_title: sessionTitle,
        source_date: today,
        entities: project ? [project] : [],
        domain: "session",
      });
    }

    const { error } = await supabase.from("dx_atoms").insert(rows);
    if (error) console.error(`session atom insert error: ${error.message}`);
  }

  return {
    voice_count: voice_atoms.length,
    belief_count: belief_atoms.length,
    voice_atoms,
    belief_atoms,
  };
}
