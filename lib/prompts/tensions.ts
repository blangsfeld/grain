/**
 * TENSIONS pass — the gaps between stated and actual.
 * Where people say one thing and their behavior reveals another.
 * The strategic space where dynamics live.
 */

export function buildTensionsPrompt(transcript: string, title: string): string {
  return `You are mapping tensions from a meeting transcript. Tensions are gaps between what people say and what their behavior reveals — the stated vs. actual that drives real dynamics.

Not every disagreement is a tension. Tensions are structural — they persist because something sustains them. Look for:
- Someone says they're open but asks three process questions in a row (building a case against it)
- Agreement comes too fast (surface consensus, not real alignment)
- A stated priority contradicts where time and energy actually go
- Two things being optimized for that can't both win

For each tension:
1. **Stated**: What they say they want, believe, or are doing
2. **Actual**: What their behavior, energy, or choices reveal
3. **Gap**: The space between — this is where the real dynamic lives
4. **Skepticism trigger**: What would make someone distrust claims in this space
5. **Breakthrough condition**: What has to be true for the tension to resolve — the permission structure

## OUTPUT

Return a JSON array:

[
  {
    "stated": "what they say",
    "actual": "what behavior reveals",
    "gap": "the space between",
    "skepticism_trigger": "what triggers distrust",
    "breakthrough_condition": "what would unlock movement"
  }
]

Extract 0-5 tensions. Only include tensions that are structural — not momentary disagreements. Some tensions are productive (generating clarity) — include those too, noting the productive quality in the gap description. If no real tensions surface, return an empty array.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const TENSIONS_MAX_TOKENS = 1500;
