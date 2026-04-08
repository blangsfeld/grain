/**
 * BELIEFS pass — the user's operating philosophy made visible.
 * What you're learning is true about your world, revealed through conversations.
 * Beliefs are YOURS — other people's convictions are quotes.
 */

export function buildBeliefsPrompt(transcript: string, title: string): string {
  return `You are extracting beliefs from a meeting transcript. Beliefs are convictions the USER (the person speaking as "You:") is developing about how their world works — revealed through what they say, how they frame things, and what positions they take.

Beliefs are the USER's, not other people's. If Ryan says "quality is the brand," that's a quote from Ryan. If the user says "I'm starting to think network collaboration beats individual company performance," that's a belief.

Look for:
- **Stated**: The user explicitly said it — a clear position or conviction
- **Implied**: Revealed by the user's behavior, framing, or emphasis — they act on this belief without stating it
- **Aspirational**: Where the user wants their thinking to go but isn't fully there yet

For each belief:
1. State it as a clear declarative sentence (the user's voice, first person OK)
2. Classify: stated / implied / aspirational
3. Confidence: strong (multiple evidence points) / moderate (some support) / emerging (single signal)
4. Evidence: what in the transcript supports this
5. What this rules out — what positions or behaviors become impossible if this belief is true

## OUTPUT

Return a JSON array:

[
  {
    "statement": "clear declarative sentence",
    "class": "stated | implied | aspirational",
    "confidence": "strong | moderate | emerging",
    "evidence": "what supports this",
    "rules_out": "what becomes impossible if this is true"
  }
]

Extract 0-5 beliefs. Only include beliefs that would change strategy or behavior if they were different. Generic convictions ("teamwork is good") are not beliefs. If no real beliefs surface, return an empty array.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const BELIEFS_MAX_TOKENS = 1500;
