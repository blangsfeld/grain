/**
 * WEEKLY DIGEST — synthesis across a week of atoms.
 *
 * Not a summary of meetings. A read on what's building,
 * what's stuck, where your voice is landing, and what
 * narratives are emerging that might be worth writing about.
 */

export function buildWeeklyDigestPrompt(atomsSummary: string, weekLabel: string): string {
  return `You are synthesizing a week of extracted intelligence into a digest. Not summarizing meetings — reading across them. Finding what compounds.

This person is a CCO running eight creative companies. They're in 50+ meetings a month across clients, leadership, strategy, and personal conversations. The atoms below were extracted from those meetings — beliefs they're developing, tensions they're navigating, quotes worth remembering, their verbal frameworks, and commitments made.

Your job: what's the story of this week? What's building? What's stuck? What did they say that's worth developing? What narratives are emerging across domains?

## OUTPUT

Return valid JSON:

{
  "themes": "2-4 themes that emerged this week. Not meeting topics — forces. What keeps showing up across different rooms? Name the dynamic, not the subject. 3-5 sentences total.",

  "tensions_in_play": "Which tensions are active right now? Are any resolving? Any new ones emerging? Are the same stated/actual gaps persisting or shifting? 2-4 sentences.",

  "beliefs_strengthening": "Which beliefs got reinforced this week? Any that got challenged or contradicted? Is the operating philosophy evolving? 2-3 sentences.",

  "your_voice_this_week": "Patterns in how they showed up verbally. Which compressions recurred? Which metaphor domains did they reach for? What reframes landed? What does the language pattern reveal about where their head is? 2-4 sentences.",

  "emerging_narratives": "The big one. What's building toward something publishable or actionable? When the same tension or belief appears in 3+ contexts, that convergence IS the narrative. Name it as a potential piece or position. 1-3 narrative seeds, each 1-2 sentences.",

  "commitments_snapshot": "What's the commitment load look like? Anything overdue or piling up? Any patterns in what keeps getting committed to? 1-2 sentences.",

  "open_questions": "1-3 questions this week raised but didn't answer. The kind worth carrying into next week."
}

## RULES

1. No hedge words. State it or skip it.
2. Name people when relevant — this is private intelligence, not public writing.
3. Emerging narratives are the most important section. Spend the most thought there.
4. If a section has nothing meaningful, write "Nothing notable this week" — don't manufacture.
5. Cross-domain connections are the highest value. A tension that appears in both a client call and a leadership sync is more interesting than one that appears twice in the same meeting.
6. "Your voice this week" should feel like coaching feedback — what are they reaching for, what's landing, what's becoming a signature.

ONLY return valid JSON. No commentary.

## WEEK: ${weekLabel}

## ATOMS

${atomsSummary}`;
}

export const WEEKLY_DIGEST_MAX_TOKENS = 2500;
