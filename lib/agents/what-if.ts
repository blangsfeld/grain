/**
 * Bruh — What-If pitch guy.
 *
 * Weekly run. Reads grain's corpus (decisions, tensions, beliefs, commitments,
 * voice atoms, recent patterns) and pitches 3 novel moves using existing
 * resources — people Ben already works with, apps already in the portfolio,
 * services already paid for.
 *
 * Hard constraint: every pitch cites specific atoms from the corpus. No
 * blue-sky "maybe try AI for X" slop — if it can't point at a real signal
 * in the data, it's not a pitch.
 *
 * Voice: speculative, pitch-guy energy, cross-domain allowed. Short.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  type AgentSeverity,
} from "@/lib/agents/agent-output";

const AGENT_ID = "what-if";
const PERSONA = "Bruh";
const MODEL = "claude-sonnet-4-6";

// ── Context pulled from corpus ─────────────────────
interface CorpusContext {
  recent_decisions: Array<{ title: string; date: string | null; meeting: string | null }>;
  active_tensions: Array<{ title: string; frequency: number; last_seen: string | null }>;
  open_commitments: Array<{ statement: string; person: string | null; date: string | null }>;
  recent_beliefs: Array<{ content: string; person: string | null }>;
  voice_moments: Array<{ quote: string; why_it_works: string | null; use_it_for: string | null }>;
}

async function gatherCorpus(days = 30): Promise<CorpusContext> {
  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [decisionsRes, tensionsRes, commitmentsRes, beliefsRes, voiceRes] = await Promise.all([
    supabase
      .from("dx_atoms")
      .select("content, source_title, source_date")
      .eq("type", "decision")
      .gte("created_at", since)
      .limit(40)
      .order("created_at", { ascending: false }),
    supabase
      .from("dx_atoms")
      .select("content, source_title, source_date")
      .eq("type", "tension")
      .gte("created_at", since)
      .limit(40)
      .order("created_at", { ascending: false }),
    supabase
      .from("dx_commitments")
      .select("statement, person, meeting_date")
      .eq("status", "open")
      .limit(30)
      .order("meeting_date", { ascending: false }),
    supabase
      .from("dx_atoms")
      .select("content")
      .eq("type", "belief")
      .gte("created_at", since)
      .limit(25)
      .order("created_at", { ascending: false }),
    supabase
      .from("dx_atoms")
      .select("content")
      .eq("type", "voice")
      .gte("created_at", since)
      .limit(15)
      .order("created_at", { ascending: false }),
  ]);

  function extractContent(data: unknown): Record<string, unknown> {
    if (typeof data === "object" && data !== null) return data as Record<string, unknown>;
    return {};
  }

  const recent_decisions = (decisionsRes.data ?? []).map((r) => {
    const c = extractContent(r.content);
    return {
      title: (c.statement as string) || (c.title as string) || (c.decision as string) || JSON.stringify(c).slice(0, 140),
      date: (r.source_date as string) ?? null,
      meeting: (r.source_title as string) ?? null,
    };
  });

  // Cluster tensions by title/pair
  const tensionFreq = new Map<string, { count: number; last_seen: string | null }>();
  for (const r of tensionsRes.data ?? []) {
    const c = extractContent(r.content);
    const key = (c.pair as string) || (c.title as string) || (c.name as string) || "";
    if (!key) continue;
    const existing = tensionFreq.get(key);
    const last = (r.source_date as string) ?? null;
    if (existing) {
      existing.count++;
      if (last && (!existing.last_seen || last > existing.last_seen)) existing.last_seen = last;
    } else {
      tensionFreq.set(key, { count: 1, last_seen: last });
    }
  }
  const active_tensions = Array.from(tensionFreq.entries())
    .map(([title, v]) => ({ title, frequency: v.count, last_seen: v.last_seen }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 12);

  const open_commitments = (commitmentsRes.data ?? []).map((r) => ({
    statement: r.statement as string,
    person: (r.person as string) ?? null,
    date: (r.meeting_date as string) ?? null,
  }));

  const recent_beliefs = (beliefsRes.data ?? []).map((r) => {
    const c = extractContent(r.content);
    return {
      content: (c.statement as string) || (c.belief as string) || JSON.stringify(c).slice(0, 200),
      person: (c.holder as string) || (c.person as string) || null,
    };
  });

  const voice_moments = (voiceRes.data ?? []).map((r) => {
    const c = extractContent(r.content);
    return {
      quote: (c.quote as string) || "",
      why_it_works: (c.why_it_works as string) ?? null,
      use_it_for: (c.use_it_for as string) ?? null,
    };
  }).filter((v) => v.quote.length > 0);

  return { recent_decisions, active_tensions, open_commitments, recent_beliefs, voice_moments };
}

// ── Resources Ben already has ─────────────────────
// Small, curated list — Bruh constrains pitches to these. Avoids hallucinating
// non-existent tools. Expand this as the Studio registry grows.
const EXISTING_RESOURCES = {
  apps: [
    "grain (Next.js 16 + Supabase, autonomous intelligence pipeline, 8-pass atom extraction, weekly digest, 8301 atoms, 406 transcripts. Has agent_outputs table for inter-agent state.)",
    "canvas (Next.js + Supabase, strategic workspace, pillar constellations, 16 cv_* tables. Pre-auth-sprint.)",
    "buck-crm (Next.js 16 + Supabase + Drizzle, relationship intelligence, 3782 contacts, network_entities + memberships. Wave 1 Day 2 complete.)",
    "lore (Next.js + Supabase, multi-agent prospecting pod for BUCK, RFP-to-opportunity-brief pipeline)",
    "source-v2 (Next.js + Supabase, instruments + writing surface, extraction superseded by Grain)",
    "slack-bot (Python, simplest deployed app, no DB)",
    "obsidian vault (knowledge layer, 60-reference/wiki/, 70-agents/, boot-context, decision logs)",
  ],
  services: [
    "Anthropic Claude (Opus 4.6 + Sonnet + Haiku, API key in .env.master)",
    "OpenAI + Grok (API keys in .env.master, used for enrichment)",
    "Supabase (6 projects: JPMP, buck-crm, LORE, Canvas, Attic, Source. Management API PAT available.)",
    "Vercel (all apps deployed, Pro tier, 40 crons/project)",
    "Resend (transactional email, replaced Gmail OAuth for sending)",
    "Granola (meeting ingest pipeline, public API with grn_ key)",
    "Apify (web scraping)",
    "Coda (existing BUCK client data, Chrome extension)",
    "Telegram Bot API (Keys agent, webhook-based)",
  ],
  wiki_techniques: [
    "agent-teams — parallel Claude Code instances with shared tasks and direct messaging",
    "llm-wiki-pattern — persistent knowledge bases that compound instead of re-deriving via RAG",
    "auto-mode — Claude Code permission mode that auto-classifies tool calls as safe/risky",
    "competing-hypotheses — spawn agents with different theories, have them disprove each other",
    "ingest-compound-file — one source touches many wiki pages; connections matter more than storage",
  ],
  agent_ecosystem: [
    "Guy (grain-steward) — hourly pipeline health, reads siblings, reasons with Haiku",
    "Buddy (ea) — daily commitment triage with trained classifier, reads siblings",
    "Dood (security-steward) — daily cross-project Supabase advisor sweep",
    "Bruh (what-if) — weekly pitch generation from corpus (this is you)",
    "Milli (wiki-librarian) — local vault lint, wiki inventory",
    "Keys (telegram-desk) — Telegram front door, capture + classify + query-answer",
    "shared state via agent_outputs table, /boot materializes to vault",
  ],
  network: [
    "BUCK (design/brand systems, Nick Carmen, Jan Jensen, Monica Lynn)",
    "Wild (digital product/AI tools, Thomas Ragger, Daniell Phillips)",
    "VTPro (experiential/events)",
    "Part+Sum (full-funnel marketing)",
    "Giant Ant (boutique animation, Jay Grandin)",
    "It's Nice That (design community/culture)",
    "OK Cool (social-first creative)",
    "CLIP/IYC (talent development)",
  ],
  residence_roles: [
    "Ryan Honey (CEO)",
    "Madison Wharton (COO)",
    "Wade Milne (CFO)",
    "Orion Tait (Creative Chair)",
    "Ben Langsfeld (CCO, building the agent ecosystem)",
  ],
};

// ── Prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = `You are Bruh — the pitch guy for Ben Langsfeld's agent ecosystem. You read Ben's corpus (grain atoms, decisions, tensions, commitments) and pitch three novel moves per run that use resources Ben already has.

## Voice
Casual-but-sharp. Pitch-guy energy. Stacked declaratives over hedged corporate speak. Cross-domain metaphors encouraged. Compressed — if a pitch takes three paragraphs, it's not sharp enough. Match the tone of a smart friend riffing in a bar, not a McKinsey deck.

No: "leverage," "ecosystem," "synergy," "unlock value," "transform," "innovate," "seamless," "robust," "best-in-class." Banned.

## Hard constraint
Every pitch MUST cite specific atoms from the corpus:
- At least one tension or decision that motivated it
- At least one app or service from the existing stack it would use
- At least one specific person it involves (from the network or Residence leadership)

If you can't anchor all three, that pitch isn't ready — replace it with something you can.

## What Ben cares about (direct quotes from his profile)
- Network-level collaboration patterns (share of culture, return on experience)
- Strategic work that compounds (Brand Imprint, Canvas constellations)
- Productive contradictions held as advantage
- Psychology as operating system — surface problems are symptoms of deeper dynamics
- Solutions from adjacent fields over best practices
- Compression — one clear number over ranges, specific over abstract

## Two pitch categories — alternate between them
1. **Business moves** — collaboration patterns, new offerings, network positioning, client strategy
2. **Coding projects** — things to build using existing apps, services, wiki techniques, and the agent ecosystem. Reference specific wiki patterns (agent-teams, competing-hypotheses, llm-wiki) when applicable. These should be concrete: "build X in grain that does Y using Z pattern."

Aim for at least one of each category in every run. The third can be whichever has stronger signal.

## What Ben doesn't want
- Generic "add AI to X" pitches
- Process improvements without diagnosing the incentive underneath
- Feature ideas so small they're just bugs/tweaks (those belong in a project's backlog)
- Anything that would need a new team, new funding, or external hires

## Output format — strict JSON, no prose outside

{
  "pitches": [
    {
      "title": "Short, punchy, observational. Not a product name.",
      "observation": "What pattern did you see in the corpus? 1-2 sentences. Cite specifically.",
      "what_if": "The speculative move. 1-2 sentences. Concrete action, not vision.",
      "uses": {
        "apps": ["grain", "buck-crm"],
        "services": ["Claude API"],
        "people": ["Nick Carmen", "Madison Wharton"]
      },
      "why_now": "What makes this timely. Tie to a recent decision or active tension.",
      "anchor_atoms": ["one-line atom reference", "another one"]
    }
  ]
}

You also receive your siblings' latest reports (Guy on pipeline health, Buddy on commitment triage, Dood on security, Milli on the wiki). These are ADDITIONAL pitch fuel. If Dood found security drift, that could be a pitch ("what if the RLS audit becomes a network-wide security offering?"). If Buddy says commitments are stale, that's a pattern worth pitching against. Use siblings as signal, not as constraints.

Return exactly 3 pitches. Return JSON only, no commentary before or after.`;

function buildUserMessage(ctx: CorpusContext): string {
  const lines: string[] = [];
  lines.push("# Corpus snapshot — last 30 days");
  lines.push("");

  if (ctx.active_tensions.length > 0) {
    lines.push("## Active tensions (sorted by frequency)");
    for (const t of ctx.active_tensions) {
      lines.push(`- **${t.title}** — ${t.frequency}× · last: ${t.last_seen ?? "?"}`);
    }
    lines.push("");
  }

  if (ctx.recent_decisions.length > 0) {
    lines.push("## Recent decisions");
    for (const d of ctx.recent_decisions.slice(0, 20)) {
      lines.push(`- [${d.date ?? "?"}] ${d.title}`);
    }
    lines.push("");
  }

  if (ctx.open_commitments.length > 0) {
    lines.push("## Open commitments");
    for (const c of ctx.open_commitments.slice(0, 15)) {
      lines.push(`- ${c.person ?? "?"}: ${c.statement}`);
    }
    lines.push("");
  }

  if (ctx.recent_beliefs.length > 0) {
    lines.push("## Beliefs surfaced");
    for (const b of ctx.recent_beliefs.slice(0, 12)) {
      lines.push(`- ${b.person ? `${b.person}: ` : ""}${b.content}`);
    }
    lines.push("");
  }

  if (ctx.voice_moments.length > 0) {
    lines.push("## Ben's voice moments (how he already thinks about things)");
    for (const v of ctx.voice_moments.slice(0, 8)) {
      lines.push(`- "${v.quote}"${v.use_it_for ? ` — deploy for: ${v.use_it_for}` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Existing resources (don't invent new ones)");
  lines.push("");
  lines.push("**Apps (with stack):**");
  for (const a of EXISTING_RESOURCES.apps) lines.push(`- ${a}`);
  lines.push("");
  lines.push("**Services:**");
  for (const s of EXISTING_RESOURCES.services) lines.push(`- ${s}`);
  lines.push("");
  lines.push("**Wiki techniques (for coding pitches):**");
  for (const w of EXISTING_RESOURCES.wiki_techniques) lines.push(`- ${w}`);
  lines.push("");
  lines.push("**Agent ecosystem (self-referential — can pitch improvements):**");
  for (const a of EXISTING_RESOURCES.agent_ecosystem) lines.push(`- ${a}`);
  lines.push("");
  lines.push("**Network companies:** " + EXISTING_RESOURCES.network.join("; "));
  lines.push("");
  lines.push("**Residence leadership:** " + EXISTING_RESOURCES.residence_roles.join("; "));
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Pitch three novel moves. Cite corpus atoms. Existing resources only. Voice: sharp, casual. Return JSON per the schema.");

  return lines.join("\n");
}

// ── Sibling context ────────────────────────────────

async function readSiblings(): Promise<string> {
  const [guy, buddy, dood, milli] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
    readLatestAgentOutput("security-steward"),
    readLatestAgentOutput("wiki-librarian"),
  ]);

  const lines: string[] = [];
  lines.push("");
  lines.push("# Siblings' latest reports (use as pitch fuel)");
  lines.push("");

  if (guy) {
    lines.push(`## Guy (pipeline health) — ${guy.severity}`);
    lines.push(guy.markdown.slice(0, 500));
    lines.push("");
  }
  if (buddy) {
    lines.push(`## Buddy (EA triage) — ${buddy.severity}`);
    lines.push(buddy.markdown.slice(0, 400));
    lines.push("");
  }
  if (dood) {
    lines.push(`## Dood (security) — ${dood.severity}`);
    lines.push(dood.markdown.slice(0, 500));
    lines.push("");
  }
  if (milli) {
    lines.push(`## Milli (wiki) — ${milli.severity}`);
    lines.push(milli.markdown.slice(0, 300));
    lines.push("");
  }

  return lines.join("\n");
}

// ── Types ──────────────────────────────────────────
interface Pitch {
  title: string;
  observation: string;
  what_if: string;
  uses: { apps?: string[]; services?: string[]; people?: string[] };
  why_now: string;
  anchor_atoms: string[];
}

interface BruhReport {
  run_at: string;
  severity: AgentSeverity;
  pitches: Pitch[];
  corpus_summary: { tensions: number; decisions: number; commitments: number; beliefs: number; voice: number };
}

// ── Parser ─────────────────────────────────────────
function parsePitches(raw: string): Pitch[] | null {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.pitches)) return null;
    return parsed.pitches as Pitch[];
  } catch {
    return null;
  }
}

// ── Render ─────────────────────────────────────────
function renderMarkdown(report: BruhReport): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("grain_managed: true");
  lines.push("type: agent-output");
  lines.push(`agent_id: ${AGENT_ID}`);
  lines.push(`persona: ${PERSONA}`);
  lines.push(`severity: ${report.severity}`);
  lines.push(`run_at: ${report.run_at}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${PERSONA} — three what-ifs`);
  lines.push("");

  if (report.pitches.length === 0) {
    lines.push("_No pitches this run. Classifier parse failed or corpus too thin._");
    return lines.join("\n");
  }

  lines.push(
    `Pulled from the last 30 days: ${report.corpus_summary.tensions} tensions, ${report.corpus_summary.decisions} decisions, ${report.corpus_summary.commitments} commitments, ${report.corpus_summary.beliefs} beliefs, ${report.corpus_summary.voice} voice moments.`,
  );
  lines.push("");

  for (const [i, p] of report.pitches.entries()) {
    lines.push(`## ${i + 1}. ${p.title}`);
    lines.push("");
    lines.push(`**What I saw.** ${p.observation}`);
    lines.push("");
    lines.push(`**What if.** ${p.what_if}`);
    lines.push("");
    lines.push(`**Why now.** ${p.why_now}`);
    lines.push("");
    const uses: string[] = [];
    if (p.uses.apps?.length) uses.push(`apps: ${p.uses.apps.join(", ")}`);
    if (p.uses.services?.length) uses.push(`services: ${p.uses.services.join(", ")}`);
    if (p.uses.people?.length) uses.push(`people: ${p.uses.people.join(", ")}`);
    if (uses.length > 0) {
      lines.push(`_Uses:_ ${uses.join(" · ")}`);
      lines.push("");
    }
    if (p.anchor_atoms?.length > 0) {
      lines.push(`_Anchors:_`);
      for (const a of p.anchor_atoms) lines.push(`- ${a}`);
      lines.push("");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Entrypoint ─────────────────────────────────────
export async function runWhatIf(): Promise<BruhReport> {
  const [ctx, siblingContext] = await Promise.all([gatherCorpus(30), readSiblings()]);
  const anthropic = getAnthropicClient(60_000);

  const userMessage = buildUserMessage(ctx) + siblingContext;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const content = response.content[0];
  const text = content.type === "text" ? content.text : "";
  const pitches = parsePitches(text) ?? [];

  return {
    run_at: new Date().toISOString(),
    severity: pitches.length === 0 ? "attention" : "green",
    pitches,
    corpus_summary: {
      tensions: ctx.active_tensions.length,
      decisions: ctx.recent_decisions.length,
      commitments: ctx.open_commitments.length,
      beliefs: ctx.recent_beliefs.length,
      voice: ctx.voice_moments.length,
    },
  };
}

export async function runAndWriteWhatIf(): Promise<{ output_id: string; report: BruhReport }> {
  const report = await runWhatIf();
  const markdown = renderMarkdown(report);

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity: report.severity,
    markdown,
    findings: {
      pitches_count: report.pitches.length,
      pitches: report.pitches,
      corpus_summary: report.corpus_summary,
    },
    metadata: { version: "0.1", model: MODEL },
  });

  return { output_id: id, report };
}
