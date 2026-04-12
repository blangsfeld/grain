/**
 * RELATIONSHIPS pass — the human network structure of a meeting.
 * Who showed up, how they moved, what tensions live between them,
 * what loops were opened. A single object payload, not a list of atoms.
 */

export function buildRelationshipsPrompt(transcript: string, title: string): string {
  return `You are mapping the relationship dynamics of a meeting. This is not about who said what — it's about how people moved, what psychology drove them, and what structure the meeting revealed or opened.

You are returning a single JSON object (not an array) with three sections:

## people[]
Each person who showed up with a meaningful speaking role. For each:
- **name**: Their full name as used in the transcript. Use the most complete form available (e.g., "Madison Wharton" not just "Madison"). If only a first name is available, use that. Never use pronouns ("you", "them"), speaker labels ("Speaker A"), or role descriptions ("the presenter") as names.
- **role**: Their role or position (or "unknown" if not visible)
- **pattern_observed**: How they moved in this meeting — not what they said, but how they operated (e.g., "pushed for clarity three times before accepting the answer", "deflected every question about timeline")
- **psychology**: The underlying dynamic driving that pattern (e.g., "loss aversion around team autonomy", "status protection under new leadership")
- **tension_involved**: If they're visibly on one side of a structural tension, the kebab-case slug (e.g., "centralization-vs-autonomy"). Null if not.
- **energy**: One of "generative" (creating clarity, unlocking movement), "tense" (friction, guardedness, defensive), or "neutral"

## tension_slugs[]
Kebab-case slugs naming structural tensions visible in this meeting. A structural tension is two forces within the organization that pull in opposite directions and persist because something sustains them. Not every disagreement or observation — only tensions that affect how the organization operates or makes decisions. Examples: "centralization-vs-autonomy", "speed-vs-quality", "founder-vs-operator-control".

Informal presentations, workshops, and social meetings typically have zero structural tensions. Return an empty array unless you see genuine organizational forces in opposition.

## loops_opened[]
Explicit commitments to take action that need tracking beyond this meeting. The test for inclusion: "Would someone be held accountable if this didn't happen?" and "Could you write a calendar reminder for this?"

Include:
- Concrete deliverables someone committed to ("I'll send the proposal by Friday")
- Follow-up meetings or reviews that were agreed to
- Decisions that were deferred to a specific future action

Do NOT include:
- Casual observations or hypotheticals ("we should think about X someday")
- Questions that went unanswered (these are conversation gaps, not commitments)
- Personal to-dos mentioned in passing ("I need to pack for my trip")
- Aspirational statements without a concrete next step
- Things that are clearly already in progress and don't need tracking

For each loop:
- **statement**: Plain language description of the commitment
- **owner**: Who committed to doing it (full name)
- **deadline**: YYYY-MM-DD if mentioned, otherwise null
- **linked_tension**: Kebab-slug of a related tension, or null

## OUTPUT

Return a single JSON object:

{
  "people": [
    {
      "name": "person name",
      "role": "their role",
      "pattern_observed": "how they moved",
      "psychology": "the dynamic driving it",
      "tension_involved": "kebab-slug or null",
      "energy": "generative"
    }
  ],
  "tension_slugs": ["kebab-slug-1"],
  "loops_opened": [
    {
      "statement": "what was committed to",
      "owner": "who committed",
      "deadline": "YYYY-MM-DD or null",
      "linked_tension": "kebab-slug or null"
    }
  ]
}

Be generous with people but precise with tensions and loops. Most meetings have 0-2 tensions and 0-3 real loops. If the meeting is a presentation, workshop, or social gathering, tensions and loops will typically be empty arrays. That's correct — don't force them.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const RELATIONSHIPS_MAX_TOKENS = 1536;
