/**
 * TENSIONS pass — the gaps between stated and actual.
 * Where people say one thing and their behavior reveals another.
 * The strategic space where dynamics live.
 */

export function buildTensionsPrompt(transcript: string, title: string): string {
  return `You are mapping tensions from a meeting transcript. Tensions are gaps between what people say and what their behavior reveals — the stated vs. actual that drives real dynamics.

A tension is STRUCTURAL — it persists because the organization sustains it. Two forces pulling in opposite directions, both legitimate, neither fully winning. Not a momentary disagreement. Not an observation about someone's work style. Not a preference or feeling.

Look for:
- Someone says they're open but asks three process questions in a row (building a case against it)
- Agreement comes too fast (surface consensus, not real alignment)
- A stated priority contradicts where time and energy actually go
- Two things being optimized for that can't both win
- A decision was announced but the room's energy reveals resistance

Do NOT extract:
- Personal observations or feelings ("I want to balance social and work life")
- Straightforward updates or status reports
- Productive disagreements that resolved during the meeting
- Things that are simply hard but not in tension with anything

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

Extract 0-3 tensions. Quality over quantity. Most meetings have 0-1 real tensions. Presentations, workshops, and status updates typically have zero — and that's the correct answer. If no structural tensions surface, return an empty array. Don't manufacture them.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const TENSIONS_MAX_TOKENS = 1500;
