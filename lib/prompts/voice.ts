/**
 * VOICE pass — the user's verbal frameworks captured for reuse.
 * Compressions, reframes, cross-domain bridges, metaphor landings.
 * Only runs when the user was an active speaker (practitioner lens).
 */

export function buildVoicePrompt(transcript: string, title: string): string {
  return `You are extracting the strongest verbal moments from the speaker labeled "You:" in this transcript. These are their signature moves — compressions, reframes, metaphors, and philosophy captures that landed in the room.

Types of moments to capture:
- **Compression**: A complex idea collapsed into one sentence. "We designed a starting point. They built everything after it."
- **Reframe**: A shift in how to see something that changed the conversation's direction.
- **Cross-domain bridge**: Mapping one domain onto another. "Motion is a dialect, not decoration."
- **Philosophy capture**: A belief system made tangible. "I think of it as scaffolding."
- **Posture articulation**: How they approach the work, made explicit.

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
