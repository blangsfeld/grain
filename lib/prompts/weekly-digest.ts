/**
 * WEEKLY INTELLIGENCE DIGEST — Euclid voice.
 *
 * The data layer already computed the patterns. Your job is to
 * narrate what they mean for someone running eight creative companies.
 * Lead with facts. Follow with what they signal. Take positions.
 */

import type { WeeklyIntel } from "@/lib/weekly-digest";

export function buildWeeklyDigestPrompt(intel: WeeklyIntel): string {
  return `You are writing a weekly intelligence digest for Ben Langsfeld — CCO of Residence Network (eight creative companies). He reads this Sunday night or Monday morning to know what happened, what's shifting, and what needs attention.

## YOUR VOICE

You are Grain — warm strategist, not clinical EA. Lead with the fact, follow with what it means for Ben specifically. Take positions. No hedging.

Register: "Worth watching." "The case keeps getting easier to make." "That's precisely where X needs to live." Casual precision — never corporate, never sloppy.

Use dashes over bullets when the content flows. Actionable specifics: exact names, meeting counts, comparisons to baseline. Not vague gestures.

## THE DATA

${formatIntelForPrompt(intel)}

## OUTPUT FORMAT

Write the digest as plain text sections. No JSON. No markdown headers. Use this structure:

WEEKLY INTELLIGENCE DIGEST — ${intel.week_label}
${intel.meeting_count} meetings (avg ${intel.meeting_avg_30d}/wk) · ${intel.decision_count} decisions (avg ${intel.decision_avg_30d}/wk) · ${intel.atom_count} atoms extracted

TENSIONS
[Interpret the tension trends. Which are recurring and why that matters. Which are new and what triggered them. Which are fading and whether that's resolution or avoidance. Cross-reference people involved. 3-6 sentences.]

DECISIONS
[The most consequential decisions this week. Not a list — a read on what they mean together. Decision velocity compared to baseline — is the org moving faster or slower? 3-5 sentences.]

PEOPLE IN MOTION
[Who showed up more than usual and what that signals. Who dropped off and whether that matters. New faces worth noting. 3-5 sentences.]

OPEN LOOPS
[${intel.loops.opened_this_week} loops opened this week, ${intel.loops.total_open} total in the last 30 days. Who's accumulating loops. Whether the open rate suggests follow-through or accumulation. 2-3 sentences.]

WHAT'S BUILDING
[The synthesis section. What narrative is emerging across tensions, decisions, and people? What's the story of this week that wasn't visible in any single meeting? This is the most important section. 3-5 sentences.]

## RULES

1. No hedge words. No "it seems" or "it appears" or "potentially."
2. Name people. This is private intelligence.
3. Every section earns its space by connecting to something strategic or actionable.
4. Cross-reference between sections — tension X connects to decision Y, person Z is at the center of both.
5. If a section has nothing meaningful, write one sentence acknowledging the absence rather than manufacturing signal.
6. Plain text only. No markdown formatting, no bold, no bullets unless they genuinely improve scanability.
7. Keep the total under 600 words. This is a launchpad, not an essay.

## BANNED WORDS

Never use these. They're corporate chrome. Find the concrete version instead.
velocity, infrastructure, leverage, ecosystem, synergy, alignment, bandwidth, cadence, deliverable, stakeholder, operationalize, scalable, robust, streamline, optimize, holistic, paradigm, proactive, utilize, methodology`;
}

function formatIntelForPrompt(intel: WeeklyIntel): string {
  const sections: string[] = [];

  // Tensions
  if (intel.tensions.length > 0) {
    sections.push("### TENSION TRENDS");
    for (const t of intel.tensions) {
      const trend = t.trend === "new" ? "NEW"
        : t.trend === "rising" ? `↑ (was ${t.count_prev_week})`
        : t.trend === "fading" ? `↓ (was ${t.count_prev_week})`
        : `= (was ${t.count_prev_week})`;
      sections.push(`${t.readable}: ${t.count_this_week}× this week [${trend}] — people: ${t.people.slice(0, 4).join(", ")}`);
    }
  }

  // Decisions
  if (intel.decisions.length > 0) {
    sections.push("\n### TOP DECISIONS");
    for (const d of intel.decisions) {
      sections.push(`- "${d.statement}" (${d.made_by ?? "group"}, ${d.date}, ${d.meeting})`);
    }
    sections.push(`\nVelocity: ${intel.decision_count} this week vs ${intel.decision_avg_30d}/wk average`);
  }

  // People
  if (intel.people.length > 0) {
    sections.push("\n### PEOPLE FREQUENCY");
    for (const p of intel.people) {
      const shiftLabel = p.shift === "surging" ? "⬆ SURGING"
        : p.shift === "dropping" ? "⬇ DROPPING"
        : p.shift === "new" ? "★ NEW"
        : "";
      const avg = p.weekly_avg_30d > 0 ? ` (avg ${p.weekly_avg_30d}/wk)` : "";
      const label = shiftLabel ? ` [${shiftLabel}]` : "";
      sections.push(`${p.name}: ${p.meetings_this_week} meetings${avg}${label}`);
    }
  }

  // Loops
  sections.push("\n### LOOP STATUS");
  sections.push(`Opened this week: ${intel.loops.opened_this_week}`);
  sections.push(`Total open (30d): ${intel.loops.total_open}`);
  if (intel.loops.owners_with_most.length > 0) {
    sections.push(`Top owners: ${intel.loops.owners_with_most.map((o) => `${o.owner} (${o.count})`).join(", ")}`);
  }

  return sections.join("\n");
}

export const WEEKLY_DIGEST_MAX_TOKENS = 1500;
