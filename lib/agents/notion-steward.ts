/**
 * Timi — Notion steward. Keeps Ben's people intelligence graph healthy.
 *
 * v1 scope: People Intelligence + LinkedIn Prospects. Observes enrichment
 * status, stale entries, orphaned records, and promotion candidates
 * (LinkedIn prospects with engagement signal ready to move into People).
 *
 * Reads Buddy and Guy as siblings — commitment overlap with people, and
 * pipeline context. Adds to the crew's cross-signal picture.
 */

import { getAnthropicClient } from "@/lib/anthropic";
import {
  queryDatabase,
  getTitle,
  getSelect,
  getMultiSelect,
  getRichText,
  getDate,
  getUrl,
  getNumber,
  getRelationIds,
  daysSince,
  type NotionPage,
} from "@/lib/notion";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  readOwnHistory,
  type AgentSeverity,
} from "@/lib/agents/agent-output";

const AGENT_ID = "notion-steward";
const PERSONA = "Timi";
const MODEL = "claude-haiku-4-5-20251001";
const STALE_DAYS = 90; // Enriched > 90d ago → stale
const HOT_PROSPECT_THRESHOLD = 2; // engagement_count >= N with no People link

// ── Fact gathering ─────────────────────────────────

interface PeopleFacts {
  total: number;
  by_status: { raw: number; enriched: number; deep: number; stale: number; unset: number };
  by_tier: { core: number; active: number; peripheral: number; dormant: number; unset: number };
  by_context: Record<string, number>;
  stale_enriched: Array<{ name: string; role: string; enriched_days_ago: number | null; url: string }>;
  orphans: Array<{ name: string; role: string; missing: string[]; url: string }>;
  recent_additions: Array<{ name: string; role: string; created_days_ago: number; url: string }>;
}

interface ProspectFacts {
  total: number;
  by_outreach_tier: Record<string, number>;
  promotion_candidates: Array<{
    name: string;
    role: string;
    engagement: number;
    warm_hooks: string[];
    outreach_tier: string | null;
    has_people_link: boolean;
    url: string;
  }>;
  contacted_without_promotion: Array<{ name: string; role: string; last_seen_days_ago: number | null; url: string }>;
  stale_tier_one: Array<{ name: string; role: string; first_seen_days_ago: number | null; url: string }>;
}

interface TimiFacts {
  people: PeopleFacts;
  prospects: ProspectFacts;
}

async function gatherPeopleFacts(): Promise<PeopleFacts> {
  const dbId = process.env.NOTION_PEOPLE_DB_ID;
  if (!dbId) throw new Error("NOTION_PEOPLE_DB_ID missing");

  const pages = await queryDatabase(dbId);

  const facts: PeopleFacts = {
    total: pages.length,
    by_status: { raw: 0, enriched: 0, deep: 0, stale: 0, unset: 0 },
    by_tier: { core: 0, active: 0, peripheral: 0, dormant: 0, unset: 0 },
    by_context: {},
    stale_enriched: [],
    orphans: [],
    recent_additions: [],
  };

  for (const page of pages) {
    const name = getTitle(page);
    const role = getRichText(page, "Current Role");
    const status = getSelect(page, "Enrichment Status");
    const tier = getSelect(page, "Tier");
    const context = getSelect(page, "Context");
    const enrichedDate = getDate(page, "Enriched Date");
    const companyRels = getRelationIds(page, "Company");

    // Status tally
    const statusKey = status?.toLowerCase() ?? "unset";
    if (statusKey === "raw") facts.by_status.raw++;
    else if (statusKey === "enriched") facts.by_status.enriched++;
    else if (statusKey === "deep") facts.by_status.deep++;
    else if (statusKey === "stale") facts.by_status.stale++;
    else facts.by_status.unset++;

    // Tier tally
    const tierKey = tier?.toLowerCase() ?? "unset";
    if (tierKey === "core") facts.by_tier.core++;
    else if (tierKey === "active") facts.by_tier.active++;
    else if (tierKey === "peripheral") facts.by_tier.peripheral++;
    else if (tierKey === "dormant") facts.by_tier.dormant++;
    else facts.by_tier.unset++;

    // Context tally
    if (context) {
      facts.by_context[context] = (facts.by_context[context] ?? 0) + 1;
    } else {
      facts.by_context["Unset"] = (facts.by_context["Unset"] ?? 0) + 1;
    }

    // Stale enriched: enriched or deep but enriched date > 90d old
    const enrichedAge = daysSince(enrichedDate);
    if ((status === "Enriched" || status === "Deep") && enrichedAge !== null && enrichedAge > STALE_DAYS) {
      facts.stale_enriched.push({
        name,
        role: role || "—",
        enriched_days_ago: enrichedAge,
        url: page.url,
      });
    }

    // Orphans: Raw or unset, missing multiple key fields
    if ((!status || status === "Raw") && name) {
      const missing: string[] = [];
      if (!tier) missing.push("Tier");
      if (!context) missing.push("Context");
      if (companyRels.length === 0) missing.push("Company");
      if (missing.length >= 2) {
        facts.orphans.push({ name, role: role || "—", missing, url: page.url });
      }
    }

    // Recent additions: created in last 14 days
    const createdAge = daysSince(page.created_time);
    if (createdAge !== null && createdAge <= 14 && name) {
      facts.recent_additions.push({
        name,
        role: role || "—",
        created_days_ago: createdAge,
        url: page.url,
      });
    }
  }

  // Trim lists so we don't blow up the prompt
  facts.stale_enriched = facts.stale_enriched
    .sort((a, b) => (b.enriched_days_ago ?? 0) - (a.enriched_days_ago ?? 0))
    .slice(0, 10);
  facts.orphans = facts.orphans.slice(0, 15);
  facts.recent_additions = facts.recent_additions
    .sort((a, b) => a.created_days_ago - b.created_days_ago)
    .slice(0, 10);

  return facts;
}

async function gatherProspectFacts(): Promise<ProspectFacts> {
  const dbId = process.env.NOTION_LINKEDIN_PROSPECTS_DB_ID;
  if (!dbId) throw new Error("NOTION_LINKEDIN_PROSPECTS_DB_ID missing");

  const pages = await queryDatabase(dbId);

  const facts: ProspectFacts = {
    total: pages.length,
    by_outreach_tier: {},
    promotion_candidates: [],
    contacted_without_promotion: [],
    stale_tier_one: [],
  };

  for (const page of pages) {
    const name = getTitle(page);
    const role = getRichText(page, "Current Role");
    const engagement = getNumber(page, "Engagement Count") ?? 0;
    const warmHooks = getRichTextArrayFromMultiSelect(page, "Warm Hooks");
    const outreachTier = getSelect(page, "Outreach Tier");
    const peopleLink = getRelationIds(page, "People Intelligence");
    const firstSeen = getDate(page, "First Seen");
    const lastSeen = getDate(page, "Last Seen");

    // Outreach tier tally
    const tierKey = outreachTier ?? "Unset";
    facts.by_outreach_tier[tierKey] = (facts.by_outreach_tier[tierKey] ?? 0) + 1;

    // Promotion candidates: high engagement, no People link, not already promoted
    if (
      engagement >= HOT_PROSPECT_THRESHOLD &&
      peopleLink.length === 0 &&
      outreachTier !== "Promoted" &&
      name
    ) {
      facts.promotion_candidates.push({
        name,
        role: role || "—",
        engagement,
        warm_hooks: warmHooks,
        outreach_tier: outreachTier,
        has_people_link: false,
        url: page.url,
      });
    }

    // Contacted but not promoted — stalled in funnel
    if (outreachTier === "Contacted" && peopleLink.length === 0 && name) {
      facts.contacted_without_promotion.push({
        name,
        role: role || "—",
        last_seen_days_ago: daysSince(lastSeen),
        url: page.url,
      });
    }

    // Tier 1 — Reach Out prospects seen > 30d ago with no action
    const firstSeenAge = daysSince(firstSeen);
    if (
      outreachTier === "Tier 1 — Reach Out" &&
      firstSeenAge !== null &&
      firstSeenAge > 30 &&
      name
    ) {
      facts.stale_tier_one.push({
        name,
        role: role || "—",
        first_seen_days_ago: firstSeenAge,
        url: page.url,
      });
    }
  }

  // Sort + trim
  facts.promotion_candidates = facts.promotion_candidates
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 10);
  facts.contacted_without_promotion = facts.contacted_without_promotion.slice(0, 10);
  facts.stale_tier_one = facts.stale_tier_one
    .sort((a, b) => (b.first_seen_days_ago ?? 0) - (a.first_seen_days_ago ?? 0))
    .slice(0, 10);

  return facts;
}

// Small helper for multi-select (Warm Hooks is multi_select, not rich_text)
function getRichTextArrayFromMultiSelect(page: NotionPage, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "multi_select") return [];
  const items = (prop.multi_select as Array<{ name: string }> | undefined) ?? [];
  return items.map((i) => i.name);
}

async function gatherFacts(): Promise<TimiFacts> {
  const [people, prospects] = await Promise.all([gatherPeopleFacts(), gatherProspectFacts()]);
  return { people, prospects };
}

// ── Sibling context ────────────────────────────────

async function readSiblings(): Promise<{ guy: string | null; buddy: string | null }> {
  const [guy, buddy] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
  ]);
  return {
    guy: guy ? `Severity: ${guy.severity}\n${guy.markdown.slice(0, 400)}` : null,
    buddy: buddy ? `Severity: ${buddy.severity}\n${buddy.markdown.slice(0, 500)}` : null,
  };
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are Timi, the steward of Ben Langsfeld's Notion intelligence databases. You keep the people graph healthy.

## What you know
You watch two connected databases:
- **20 · People Intelligence** — stakeholder dossiers (current 30+). Tier (Core/Active/Peripheral/Dormant), Context (Client/Partner/Prospect/Industry/Personal/Residence), Enrichment Status (Raw/Enriched/Deep/Stale). Enriched entries age and go stale after ~90 days.
- **30 · LinkedIn Prospects** — inbound funnel. Outreach Tier (Tier 1 Reach Out / Tier 2 Connect / Tier 3 Watch / Contacted / Promoted), Engagement Count, Warm Hooks. Promoted prospects flow into People Intelligence via relation.

## How you think
You're the hygiene layer. The databases are tools, not products — they only work if they stay current. You don't list everything. You triage:
- What needs attention (stale enrichments, orphans missing key fields)
- What's rising (LinkedIn prospects with engagement signal ready to promote)
- What's stuck (Contacted prospects that never got promoted, Tier 1 outreach targets that never got reached out to)

You respect Ben's framing: Notion is the structured lake, Obsidian is the synthesis graph. You don't invent new categories; you maintain the ones that exist.

## Cross-signal
If Buddy flagged a commitment involving someone who isn't yet in People Intelligence, that's a gap worth surfacing. If Guy reports the pipeline is quiet, a People Intelligence cleanup pass is good idle-time work.

## What you receive
- Counts by enrichment status, tier, context
- Stale enriched list (top 10, oldest first)
- Orphans: entries missing 2+ key fields
- Recent additions (last 14 days)
- Prospect promotion candidates (high engagement, no People link yet)
- Prospect funnel stalls (Contacted without promotion, Tier 1 over 30d idle)
- Buddy's latest commitment triage
- Guy's latest pipeline report

## What you produce
A short report (under 300 words):
1. Lead with the headline: what's the state of the graph?
2. One section per signal that matters today (don't pad with zero-finding sections)
3. Promotion candidates listed by name + engagement + warm hooks (Ben acts on this)
4. Cross-signal if Buddy/Guy connect

## Voice
Direct. You're a librarian with opinions. "You have 4 prospects with engagement >=2 who aren't in People yet. Here they are." No corporate hedging. No "consider reviewing" — say what to do or say "all clear."

Banned: leverage, ecosystem, seamless, robust, actionable, circle back, streamline.

## History awareness
You receive your last report. If the same candidates are still waiting with the same signal, say "Same picture as last week — N candidates still waiting." Don't re-triage identical data.

## Severity
- green: nothing to act on — graph is healthy and nothing rising
- attention: promotion candidates waiting, or stale enrichments accumulating, or >5 orphans
- failure: graph is decaying (major stale count, most entries Raw/unset, critical data gaps)

## Output
Return strict JSON:
{"severity": "green|attention|failure", "markdown": "full report with frontmatter"}`;

// ── Context builder ────────────────────────────────

function buildContext(
  facts: TimiFacts,
  siblings: { guy: string | null; buddy: string | null },
  ownHistory: Array<{ markdown_preview: string }> = [],
): string {
  const lines: string[] = [];
  const p = facts.people;
  const pr = facts.prospects;

  lines.push(`# People Intelligence (${p.total} total)`);
  lines.push(`**Enrichment:** Raw ${p.by_status.raw} · Enriched ${p.by_status.enriched} · Deep ${p.by_status.deep} · Stale ${p.by_status.stale} · Unset ${p.by_status.unset}`);
  lines.push(`**Tier:** Core ${p.by_tier.core} · Active ${p.by_tier.active} · Peripheral ${p.by_tier.peripheral} · Dormant ${p.by_tier.dormant} · Unset ${p.by_tier.unset}`);
  const ctxParts = Object.entries(p.by_context).map(([k, v]) => `${k} ${v}`).join(" · ");
  lines.push(`**Context:** ${ctxParts}`);
  lines.push("");

  if (p.stale_enriched.length > 0) {
    lines.push(`## Stale enriched (>${STALE_DAYS}d since Enriched Date, top ${p.stale_enriched.length})`);
    for (const s of p.stale_enriched) {
      lines.push(`- ${s.name} (${s.role}) — enriched ${s.enriched_days_ago}d ago`);
    }
    lines.push("");
  }

  if (p.orphans.length > 0) {
    lines.push(`## Orphans — Raw entries missing 2+ key fields (${p.orphans.length})`);
    for (const o of p.orphans) {
      lines.push(`- ${o.name} (${o.role}) — missing: ${o.missing.join(", ")}`);
    }
    lines.push("");
  }

  if (p.recent_additions.length > 0) {
    lines.push(`## Recent additions (last 14d, ${p.recent_additions.length})`);
    for (const r of p.recent_additions) {
      lines.push(`- ${r.name} (${r.role}) — added ${r.created_days_ago}d ago`);
    }
    lines.push("");
  }

  lines.push(`# LinkedIn Prospects (${pr.total} total)`);
  const tierParts = Object.entries(pr.by_outreach_tier).map(([k, v]) => `${k} ${v}`).join(" · ");
  lines.push(`**Outreach:** ${tierParts}`);
  lines.push("");

  if (pr.promotion_candidates.length > 0) {
    lines.push(`## Promotion candidates — engagement ≥${HOT_PROSPECT_THRESHOLD}, not yet in People (${pr.promotion_candidates.length})`);
    for (const c of pr.promotion_candidates) {
      const hooks = c.warm_hooks.length > 0 ? ` · hooks: ${c.warm_hooks.join(", ")}` : "";
      const tierTag = c.outreach_tier ? ` · ${c.outreach_tier}` : "";
      lines.push(`- ${c.name} (${c.role}) — engagement ${c.engagement}${tierTag}${hooks}`);
    }
    lines.push("");
  }

  if (pr.contacted_without_promotion.length > 0) {
    lines.push(`## Contacted without promotion — stalled in funnel (${pr.contacted_without_promotion.length})`);
    for (const c of pr.contacted_without_promotion) {
      const age = c.last_seen_days_ago !== null ? `last seen ${c.last_seen_days_ago}d ago` : "no Last Seen date";
      lines.push(`- ${c.name} (${c.role}) — ${age}`);
    }
    lines.push("");
  }

  if (pr.stale_tier_one.length > 0) {
    lines.push(`## Stale Tier 1 — flagged to reach out, no action (${pr.stale_tier_one.length})`);
    for (const s of pr.stale_tier_one) {
      lines.push(`- ${s.name} (${s.role}) — first seen ${s.first_seen_days_ago}d ago`);
    }
    lines.push("");
  }

  if (siblings.buddy) {
    lines.push("# Buddy's latest (commitment triage)");
    lines.push(siblings.buddy);
    lines.push("");
  }
  if (siblings.guy) {
    lines.push("# Guy's latest (pipeline)");
    lines.push(siblings.guy);
    lines.push("");
  }

  if (ownHistory.length > 0) {
    lines.push("# Your last report (don't repeat if nothing changed)");
    lines.push(ownHistory[0].markdown_preview);
    lines.push("");
  }

  lines.push("---");
  lines.push("Write your report. Return JSON with severity and markdown.");
  return lines.join("\n");
}

function parseResponse(raw: string): { severity: AgentSeverity; markdown: string } | null {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!["green", "attention", "failure"].includes(parsed.severity)) return null;
    if (typeof parsed.markdown !== "string") return null;
    return { severity: parsed.severity as AgentSeverity, markdown: parsed.markdown };
  } catch {
    return null;
  }
}

// ── Entrypoint ─────────────────────────────────────

export interface TimiReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  facts: {
    people_total: number;
    prospects_total: number;
    stale_count: number;
    orphan_count: number;
    promotion_candidate_count: number;
  };
  had_siblings: { guy: boolean; buddy: boolean };
}

export async function runAndWriteTimi(): Promise<{ output_id: string; report: TimiReport }> {
  const run_at = new Date().toISOString();
  const [facts, siblings, ownHistory] = await Promise.all([
    gatherFacts(),
    readSiblings(),
    readOwnHistory(AGENT_ID, 2),
  ]);

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: buildContext(facts, siblings, ownHistory) }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const parsed = parseResponse(text);

  let severity: AgentSeverity = "green";
  let markdown: string;

  if (parsed) {
    severity = parsed.severity;
    markdown = parsed.markdown;
  } else {
    severity = "attention";
    markdown = `# ${PERSONA} — Notion steward\n\n_Reasoning step failed. ${facts.people.total} people, ${facts.prospects.total} prospects. ${facts.prospects.promotion_candidates.length} promotion candidates._`;
  }

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: ${severity}\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  const reportData: TimiReport = {
    run_at,
    severity,
    markdown,
    facts: {
      people_total: facts.people.total,
      prospects_total: facts.prospects.total,
      stale_count: facts.people.stale_enriched.length,
      orphan_count: facts.people.orphans.length,
      promotion_candidate_count: facts.prospects.promotion_candidates.length,
    },
    had_siblings: { guy: !!siblings.guy, buddy: !!siblings.buddy },
  };

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity,
    markdown,
    findings: reportData.facts,
    metadata: { version: "0.1-agent", model: MODEL, reasoning: true },
  });

  return { output_id: id, report: reportData };
}

// ── Ad-hoc query mode ──────────────────────────────
// Keys dispatches "ask Timi X" messages here. Loads the full People
// Intelligence dossier and reasons against it. Does not write to
// agent_outputs (would overwrite the hygiene report in materialization);
// Keys stores the Q+A in desk_captures.reply_text as the audit trail.

const QUERY_MODEL = "claude-sonnet-4-5-20250929";

const QUERY_PERSONA_PROMPT = `You are Timi, steward of Ben Langsfeld's Notion people intelligence. Ben is asking you a specific question about the people in his database. You have the full dossier for every entry — current role, company, tier, context, career arc, career network (historical employers), public positions, sectors, city.

## How you answer
- Answer directly. Lead with the finding, not with setup.
- Cite specific people by name. Quote evidence from their profiles.
- If the question asks for surprising, interesting, or notable examples, pick ones with strong specific evidence — not generic.
- If the data doesn't support a clean answer, say so. Don't fabricate connections that aren't in the data.
- For questions about historical overlap (same company, same era), use Career Network + Career Arc text. Be honest about inference vs. fact — if two people both have "Nike" in Career Network but no dates, say "both worked at Nike at some point" not "they overlapped."

## Voice
Direct. Under 300 words. No corporate hedging. Write like a librarian with opinions.

Banned: leverage, ecosystem, seamless, robust, actionable, circle back, streamline, comprehensive.

## Output
Plain markdown text — NOT JSON. Ben reads this directly in Telegram.`;

function buildDossier(page: NotionPage): string {
  const name = getTitle(page);
  if (!name) return "";

  const role = getRichText(page, "Current Role");
  const tier = getSelect(page, "Tier");
  const context = getSelect(page, "Context");
  const city = getRichText(page, "City");
  const careerArc = getRichText(page, "Career Arc");
  const careerNetwork = getMultiSelect(page, "Career Network");
  const publicPositions = getRichText(page, "Public Positions");
  const sectors = getMultiSelect(page, "Sectors");
  const talkingPoints = getRichText(page, "Talking Points");
  const status = getSelect(page, "Enrichment Status");

  const lines: string[] = [`**${name}**`];
  const meta: string[] = [];
  if (role) meta.push(role);
  if (tier) meta.push(`tier: ${tier}`);
  if (context) meta.push(`context: ${context}`);
  if (city) meta.push(city);
  if (status) meta.push(`[${status}]`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  if (careerNetwork.length > 0) lines.push(`network: ${careerNetwork.join(", ")}`);
  if (sectors.length > 0) lines.push(`sectors: ${sectors.join(", ")}`);
  if (careerArc) lines.push(`arc: ${careerArc}`);
  if (publicPositions) lines.push(`positions: ${publicPositions}`);
  if (talkingPoints) lines.push(`talking points: ${talkingPoints}`);

  return lines.join("\n");
}

export interface TimiQueryResult {
  answer: string;
  people_count: number;
  question: string;
}

export async function runTimiQuery(question: string): Promise<TimiQueryResult> {
  const dbId = process.env.NOTION_PEOPLE_DB_ID;
  if (!dbId) throw new Error("NOTION_PEOPLE_DB_ID missing");

  const pages = await queryDatabase(dbId);
  const dossiers = pages
    .map(buildDossier)
    .filter((d) => d.length > 0);

  const context = `# People Intelligence dossier — ${dossiers.length} entries\n\n${dossiers.join("\n\n")}`;

  const anthropic = getAnthropicClient(60_000);
  const response = await anthropic.messages.create({
    model: QUERY_MODEL,
    max_tokens: 1500,
    system: QUERY_PERSONA_PROMPT,
    messages: [
      {
        role: "user",
        content: `${context}\n\n---\n\nBen's question: "${question}"\n\nAnswer directly. If the question asks for specific examples, give concrete named people with evidence from their profiles.`,
      },
    ],
  });

  const answer = response.content[0]?.type === "text" ? response.content[0].text : "";
  return {
    answer: answer || "Reasoning step returned empty. Try rephrasing.",
    people_count: dossiers.length,
    question,
  };
}
