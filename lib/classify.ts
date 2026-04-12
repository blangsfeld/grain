/**
 * Classifier — lightweight Haiku gate.
 * Two independent booleans: source_grade + has_commitments.
 * Defaults both to true. Only pure noise gets both false.
 */

import { getAnthropicClient } from "@/lib/anthropic";
import type { AtomPass, ExtractionPlan } from "@/types/atoms";

// ─── Types ───────────────────────────────────────

export interface Classification {
  source_grade: boolean;
  recommended_lens: "practitioner" | "diagnostic";
  has_commitments: boolean;
  context: "professional" | "personal";
  summary: string;
  topics: string[];
}

// ─── Prompt ──────────────────────────────────────

const CLASSIFY_PROMPT = `You are a transcript classifier. Two questions, two booleans. Be generous — default to true unless there's clear evidence otherwise.

## Question 1: source_grade

Does this conversation reveal anything about how the primary speaker thinks, positions, communicates, or navigates dynamics?

true: Strategy discussions, advisory conversations, leadership meetings, presentations where the speaker performed, personal conversations where someone is processing or reflecting, any meeting where the speaker's frameworks or verbal moves are visible.

false: Pure admin (calendar coordination, IT troubleshooting), one-sided presentations the speaker watched passively with no speaking role, automated recordings with no real conversation.

Default: true. Most conversations reveal something.

## Question 2: has_commitments

Did anyone agree to do something, promise something, or take on an action item?

true: Any explicit or implied commitment, follow-up, deliverable, or "I'll do X by Y." Even soft ones ("we should look into that").

false: Pure brainstorming, philosophical discussion, or status update with no forward actions.

Default: true. Most meetings produce at least one follow-up.

## Lens recommendation

- **practitioner**: The primary speaker ("You:") was active — presenting, advising, strategizing, deploying frameworks, or processing personally.
- **diagnostic**: The primary speaker was mostly observing dynamics from outside.

Default: practitioner.

## Context

- **professional**: Work-related conversation
- **personal**: Therapy, coaching, family, personal reflection

## OUTPUT

Return valid JSON:

{
  "source_grade": true,
  "recommended_lens": "practitioner",
  "has_commitments": true,
  "context": "professional",
  "summary": "One sentence: what this conversation was about.",
  "topics": ["topic1", "topic2"]
}

ONLY return valid JSON.`;

const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

// ─── Classify ────────────────────────────────────

export async function classifyTranscript(
  transcript: string,
  sourceTitle?: string,
): Promise<Classification> {
  const client = getAnthropicClient();

  // Sample: first 1500 + last 1500 words for long transcripts
  const words = transcript.split(/\s+/);
  const sample =
    words.length > 3000
      ? words.slice(0, 1500).join(" ") + "\n\n[...middle truncated...]\n\n" + words.slice(-1500).join(" ")
      : transcript;

  const header = sourceTitle ? `Title: ${sourceTitle}\n\n` : "";

  const response = await client.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 256,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `${CLASSIFY_PROMPT}\n\n---\n\n${header}TRANSCRIPT:\n\n${sample}`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as Classification;
  } catch {
    // Fall through to default
  }

  // Default: both true, practitioner lens
  return {
    source_grade: true,
    recommended_lens: "practitioner",
    has_commitments: true,
    context: "professional",
    summary: "Classification failed — defaulting to extract everything.",
    topics: [],
  };
}

// ─── Extraction plan ─────────────────────────────

export function getExtractionPlan(c: Classification): ExtractionPlan {
  const passes: AtomPass[] = [];

  // Always-run passes (unless both are false)
  if (c.source_grade || c.has_commitments) {
    passes.push("read");
    passes.push("quotes");
  }

  // Commitment pass
  if (c.has_commitments) {
    passes.push("commitments");
  }

  // Source-grade passes
  if (c.source_grade) {
    passes.push("beliefs");
    passes.push("tensions");
    passes.push("decisions");
    if (c.recommended_lens === "practitioner") {
      passes.push("voice");
    }
  }

  // Relationships pass — runs on any substantive meeting
  if (c.source_grade || c.has_commitments) {
    passes.push("relationships");
  }

  return {
    passes,
    lens: c.recommended_lens,
    dismiss: passes.length === 0,
  };
}
