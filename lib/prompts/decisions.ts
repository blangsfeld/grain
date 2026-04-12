/**
 * DECISIONS pass — confirmed choices that change course.
 * Structural, strategic, personnel, product, or financial.
 * What was actually decided vs. what was merely discussed.
 */

export function buildDecisionsPrompt(transcript: string, title: string): string {
  return `You are extracting confirmed decisions from a meeting transcript. A decision is a choice that changes course — a commitment to a direction, not just a discussion of options.

Not every discussion is a decision. A decision has three marks:
- It names what will be done (or stopped, or changed)
- Someone has the authority to make it, and did
- The room treats it as settled, not as a thing still being debated

Look for five decision types:
- **structural**: Org changes, reporting lines, team splits, P&L separations, governance shifts
- **strategic**: Market positioning, direction changes, priorities, what to stop doing
- **personnel**: Hires, fires, role changes, responsibility reassignments
- **product**: Feature scope, roadmap changes, launches, deprecations
- **financial**: Budget approvals, investments, pricing, commercial terms

For each decision:
1. **statement**: Plain language — what was decided
2. **type**: One of structural | strategic | personnel | product | financial
3. **made_by**: Who made the call (name or role)
4. **context**: The situation that forced the choice — why now
5. **alternatives_considered**: What else was on the table (null if none visible)
6. **linked_tension**: If this decision resolves or addresses a structural tension, the kebab-case slug naming it (e.g., "centralization-vs-autonomy"). Null if no tension is in play.
7. **confidence**: "confirmed" if the decision is settled; "tentative" if it's leaning but not locked

## OUTPUT

Return a JSON array:

[
  {
    "statement": "what was decided",
    "type": "structural",
    "made_by": "who made the call",
    "context": "why now",
    "alternatives_considered": "what else was on the table or null",
    "linked_tension": "kebab-slug or null",
    "confidence": "confirmed"
  }
]

Extract 0-6 decisions. Only include decisions that are actually made — not things someone said they'd think about. If the confidence is low, mark it "tentative" and let downstream filters handle it. If no decisions surface, return an empty array.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const DECISIONS_MAX_TOKENS = 1024;
