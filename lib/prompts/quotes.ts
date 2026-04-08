/**
 * QUOTES pass — the moments worth remembering.
 * Exact words that reveal how someone actually thinks,
 * capture a dynamic in action, or would change how you
 * show up next time.
 */

export function buildQuotesPrompt(transcript: string, title: string): string {
  return `You are extracting the most important quotes from a meeting transcript. Not every interesting sentence — the ones worth remembering. The moments someone said the quiet part out loud, the room shifted, or a real position became visible.

What makes a quote worth keeping:
- It reveals how someone actually thinks (not what they say they think)
- It contains a tension, contradiction, or unresolved decision
- It captures a dynamic in action — not being discussed, but happening
- It's specific enough to build on later
- It shows where aspiration and reality diverge

For each quote:
1. The exact words (tightest faithful version if the original rambles)
2. Who said it
3. One sentence: why this matters
4. Weight: **high** (would pin to the wall), **medium** (supports an argument), **signal** (worth noting)

## OUTPUT

Return a JSON array:

[
  {
    "text": "exact quote",
    "speaker": "who said it",
    "weight": "high | medium | signal",
    "reasoning": "one sentence on why this matters"
  }
]

Aim for 3-10 quotes depending on meeting richness. Order by weight (high first). If the meeting has nothing worth quoting, return an empty array.

## RULES

1. Exact words from the transcript. Not paraphrases dressed as quotes.
2. Every quote must earn its place. Generic statements aren't quotes.
3. Include quotes from ALL speakers, not just the dominant voice.
4. "We should probably look at the numbers again" = not a quote. "I already told the board we'd hit Q3, so we need to figure out how to make that true" = a quote.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const QUOTES_MAX_TOKENS = 2000;
