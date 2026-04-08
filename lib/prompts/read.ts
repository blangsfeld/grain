/**
 * READ pass — the trajectory diagnosis.
 * What's moving, what's stuck, what wasn't said, where things stand.
 * Runs on every meeting. The practical layer.
 */

export function buildReadPrompt(transcript: string, title: string): string {
  return `You are reading a meeting transcript. Not summarizing — reading. Finding where the energy moved, what got decided, what's stuck, and what nobody said out loud.

For each section, be specific. Names, not roles. Moments, not themes. If nothing fits a section, say "Nothing notable" — don't manufacture content.

## OUTPUT

Return valid JSON:

{
  "whats_moving": "Where energy built. Decisions that landed. Progress that's real. Who's driving it. 2-4 sentences.",
  "whats_stuck": "Deferred decisions, avoided topics, circular conversations. What's stuck AND what's keeping it stuck. 2-4 sentences.",
  "commitments_summary": "Who said they'd do what. For each: Name — action — when — conviction (firm/soft/aspirational). Firm = specific + timeline. Soft = intent, vague details. Aspirational = 'we should' language.",
  "what_wasnt_said": "The negative space. Topics you'd expect but didn't come up. Questions asked but not answered. Elephants. 1-3 sentences.",
  "the_read": "One paragraph. Not a summary — a diagnosis. Where is this group right now? What's the honest trajectory? Start with what's working, then name the risk."
}

## RULES

1. No hedge words. Never: appears, seems, potentially, may, somewhat.
2. Names, not roles. "Spencer" not "the designer."
3. Lead with what's working before naming what's not.
4. Every claim must trace to something specific in the transcript.
5. Commitments: distinguish firm from aspirational. "We should look into that" ≠ commitment.

ONLY return valid JSON. No commentary.

## MEETING

Title: ${title}

${transcript}`;
}

export const READ_MAX_TOKENS = 1500;
