/**
 * VOICE pass — the user's verbal frameworks captured for reuse.
 * Compressions, reframes, cross-domain bridges, metaphor landings.
 * Only runs when the user was an active speaker (practitioner lens).
 */

export function buildVoicePrompt(transcript: string, title: string): string {
  return `You are extracting the strongest verbal moments from the speaker labeled "You:" in this transcript. These are their signature moves — compressions, reframes, metaphors, and philosophy captures that landed in the room.

Types of moments to capture:
- **Compression**: A complex idea collapsed into one short sentence — the kind of line a reader would underline.
- **Reframe**: A shift in how to see something that changed the conversation's direction.
- **Cross-domain bridge**: Using the vocabulary of one domain to explain another.
- **Philosophy capture**: A conviction or belief made tangible in concrete language.
- **Posture articulation**: How they approach the work, made explicit.

Do not invent or paraphrase quotes. The "quote" field must be a verbatim substring of the "You:" speech in the transcript below. If no moment in the transcript meets the bar, return an empty array.

For each moment:
1. The exact quote from the transcript
2. Why it works — the technique (compression, metaphor, frame shift, emotional register). Be specific, not "good metaphor."
3. Where to use it — which kind of piece, argument, or audience this would serve in written form
4. Context — what prompted it, what it was responding to

## OUTPUT

Return a JSON array:

[
  {
    "quote": "exact words from You:",
    "why_it_works": "specific coaching on the technique",
    "use_it_for": "where to deploy in written form",
    "context": "what prompted this moment"
  }
]

Extract 0-5 moments. Only from "You:" speaker. Quality over quantity — one strong moment is better than four thin ones. If the user barely spoke or nothing notable happened, return an empty array.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const VOICE_MAX_TOKENS = 1500;
