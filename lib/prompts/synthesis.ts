/**
 * SYNTHESIS pass — per-meeting trajectory diagnosis.
 * Mirrors the quarterly trajectory shape at single-meeting granularity.
 * Beliefs formed/challenged, tensions chronic/resolved, commitments kept/made/drifting,
 * open questions, and a density signal. Feeds the `/probe` skill via open_questions.
 */

export function buildSynthesisPrompt(transcript: string, title: string): string {
  return `You are synthesizing a single meeting into the trajectory shape used for quarterly company analysis — but applied to one conversation. The output is a structured diagnosis: what shifted, which beliefs moved, which tensions are chronic vs. resolved, where commitments stand, and what didn't get answered.

This output is permanent record. Accuracy matters more than narrative. Skip a section with insufficient evidence rather than guess.

## OUTPUT

Return a single JSON object:

{
  "arc": "1-2 sentences. What shifted in this meeting? Where did it move from / move to? If nothing meaningfully shifted (status update, social meeting), say so plainly.",
  "beliefs_formed": [
    "Concrete belief that emerged or strengthened in this conversation. Include who holds it. Example: 'Emily strengthened her view that the JPMP timeline is real, after Daniel confirmed Q3 dates.'"
  ],
  "beliefs_challenged": [
    "Belief that weakened, was contradicted, or got pushback. Include who held it and what challenged it. Example: 'Jay's belief that Airbnb was a flagship account got challenged when the renewal terms came in flat.'"
  ],
  "tensions_chronic": [
    "Tensions visible in this meeting that have shown up before — the same dynamic recurring without resolution. State the tension as 'X vs. Y' or 'stated X, actual Y'."
  ],
  "tensions_resolved": [
    "Tensions that were stuck and got unstuck in this meeting. What unblocked them?"
  ],
  "commitments_kept": [
    "Prior commitments that were honored in or by this meeting. Name the person and the commitment."
  ],
  "commitments_made": [
    "New commitments made in this meeting. Name the person, the commitment, the timeframe if given."
  ],
  "commitments_drifting": [
    "Commitments past their date or quietly slipping. Name the person, the commitment, what was supposed to happen by when."
  ],
  "open_questions": [
    "Questions raised in this meeting that didn't get answered. Gaps in the conversation. Things someone tried to ask but the meeting moved past. The next-meeting agenda."
  ],
  "density_signal": {
    "thick_on": ["Topics this meeting was rich on — sustained discussion, multiple speakers, real exploration"],
    "thin_on": ["Topics that came up briefly but didn't get developed — one mention, no follow-through, surface-level"]
  }
}

## RULES

1. **Skip empty sections** — return [] for arrays that have no real content. Don't manufacture entries to fill a section. Most meetings don't have entries in every category.
2. **Names, not roles.** "Spencer" not "the designer."
3. **Specifics over themes.** "Daniel committed to interviewing 3 CD candidates by next Friday" beats "Daniel committed to hiring."
4. **Distinguish chronic from one-off.** A tension is chronic only if you can see it as the same dynamic that's surfaced before. Don't label every disagreement as chronic.
5. **open_questions is unanswered, not unasked.** A question someone *tried to raise* and got deflected counts. A question nobody asked but you think they should have — does not.
6. **density_signal calibrates probe targeting.** Be honest about what was thick vs. thin. If the meeting was 80% one topic, that one topic is "thick" — name it specifically. If commitments were brushed past in 30 seconds, that's "thin."
7. **No hedge words.** Never: appears, seems, potentially, may, somewhat.
8. **For status updates and social meetings**, expect almost everything to be empty. arc may be one sentence, density_signal may have a couple entries, everything else returns []. That's correct.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const SYNTHESIS_MAX_TOKENS = 1800;
