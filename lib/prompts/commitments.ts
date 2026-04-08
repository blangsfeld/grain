/**
 * COMMITMENTS pass — who owes what to whom by when.
 * Separate from the Read's commitments_summary — this produces
 * individual addressable commitment atoms.
 */

export function buildCommitmentsPrompt(transcript: string, title: string): string {
  return `You are extracting commitments and follow-ups from a meeting transcript. A commitment is something someone explicitly agreed to do. A follow-up is softer — something that should happen but wasn't firmly committed to.

For each item:
1. The actionable statement (what needs to happen)
2. Type: commitment (firm obligation) or follow_up (softer intent)
3. Who owns it (name, not role — or null if unclear)
4. Company/organization context (if relevant)
5. Project (if mentioned)
6. Due date (YYYY-MM-DD if stated, null if not)
7. Conviction: firm (specific + timeline + no hedging), soft (intent stated, details vague), aspirational ("we should" language)

## OUTPUT

Return a JSON array:

[
  {
    "statement": "what needs to happen",
    "type": "commitment | follow_up",
    "person": "who owns it or null",
    "company": "org context or null",
    "project": "project name or null",
    "due_date": "YYYY-MM-DD or null",
    "conviction": "firm | soft | aspirational"
  }
]

Include everything actionable. "We should look into that" with no owner or timeline is aspirational. "I'll send you the deck by Friday" is firm. If no commitments were made, return an empty array.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const COMMITMENTS_MAX_TOKENS = 1500;
