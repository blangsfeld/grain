/**
 * Clark — Voice Reporter / Columnist.
 *
 * Weekly agent that surfaces Ben's voice corpus — the quotes, compressions,
 * reframes, and cross-domain bridges extracted by Grain's voice pass. Two outputs:
 *
 * 1. **Voice Leaderboard** — top 15 voice moments ranked by reusability,
 *    technique power, and quotability. Tracks weekly movement (new, up, held, down).
 *
 * 2. **Writing Pitches** — 3 essay/substack/thought-leadership concepts seeded
 *    by the strongest voice atoms, crossed with tensions and beliefs.
 *
 * The leaderboard gamifies the voice corpus so Ben actually sees it instead of
 * leaving it hidden in Supabase.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  readOwnHistory,
  type AgentSeverity,
} from "@/lib/agents/agent-output";

const AGENT_ID = "columnist";
const PERSONA = "Clark";
const MODEL = "claude-sonnet-4-6";

// ── Fact gathering ─────────────────────────────────

interface VoiceAtom {
  id: string;
  quote: string;
  technique: string | null;
  use_for: string | null;
  context: string | null;
  source_title: string | null;
  source_date: string | null;
}

interface QuoteAtom {
  id: string;
  text: string;
  speaker: string | null;
  weight: string | null;
  reasoning: string | null;
  source_title: string | null;
  source_date: string | null;
}

interface ClarkFacts {
  voice_atoms: VoiceAtom[];
  top_quotes: QuoteAtom[];
  recent_tensions: Array<{ pair: string; count: number }>;
  recent_beliefs: Array<{ statement: string; person: string | null }>;
  voice_total: number;
  quote_total: number;
  previous_leaderboard: string[] | null; // atom IDs from last run, for movement tracking
}

async function gatherFacts(): Promise<ClarkFacts> {
  const supabase = getSupabaseAdmin();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [voiceRes, quoteRes, tensionRes, beliefRes, voiceTotalRes, quoteTotalRes] = await Promise.all([
    supabase
      .from("dx_atoms")
      .select("id, content, source_title, source_date")
      .eq("type", "voice")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("dx_atoms")
      .select("id, content, source_title, source_date")
      .eq("type", "quote")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("dx_atoms")
      .select("content")
      .eq("type", "tension")
      .gte("created_at", thirtyDaysAgo)
      .limit(40),
    supabase
      .from("dx_atoms")
      .select("content")
      .eq("type", "belief")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(15),
    supabase.from("dx_atoms").select("id", { count: "exact", head: true }).eq("type", "voice"),
    supabase.from("dx_atoms").select("id", { count: "exact", head: true }).eq("type", "quote"),
  ]);

  function extractContent(raw: unknown): Record<string, unknown> {
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  }

  const voice_atoms: VoiceAtom[] = (voiceRes.data ?? []).map((r) => {
    const c = extractContent(r.content);
    return {
      id: r.id as string,
      quote: (c.quote as string) || "",
      technique: (c.why_it_works as string) ?? null,
      use_for: (c.use_it_for as string) ?? null,
      context: (c.context as string) ?? null,
      source_title: (r.source_title as string) ?? null,
      source_date: (r.source_date as string) ?? null,
    };
  }).filter((v) => v.quote.length > 0);

  const top_quotes: QuoteAtom[] = (quoteRes.data ?? []).map((r) => {
    const c = extractContent(r.content);
    return {
      id: r.id as string,
      text: (c.text as string) || "",
      speaker: (c.speaker as string) ?? null,
      weight: (c.weight as string) ?? null,
      reasoning: (c.reasoning as string) ?? null,
      source_title: (r.source_title as string) ?? null,
      source_date: (r.source_date as string) ?? null,
    };
  }).filter((q) => q.text.length > 0);

  // Cluster tensions
  const tensionFreq = new Map<string, number>();
  for (const r of tensionRes.data ?? []) {
    const c = extractContent(r.content);
    const key = (c.pair as string) || (c.title as string) || (c.name as string) || "";
    if (key) tensionFreq.set(key, (tensionFreq.get(key) ?? 0) + 1);
  }
  const recent_tensions = Array.from(tensionFreq.entries())
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const recent_beliefs = (beliefRes.data ?? []).map((r) => {
    const c = extractContent(r.content);
    return {
      statement: (c.statement as string) || (c.belief as string) || "",
      person: (c.holder as string) || (c.person as string) || null,
    };
  }).filter((b) => b.statement.length > 0);

  // Previous leaderboard for movement tracking
  const prevOutput = await readLatestAgentOutput(AGENT_ID);
  let previous_leaderboard: string[] | null = null;
  if (prevOutput?.findings) {
    const prev = (prevOutput.findings as { leaderboard_ids?: string[] }).leaderboard_ids;
    if (Array.isArray(prev)) previous_leaderboard = prev;
  }

  return {
    voice_atoms,
    top_quotes,
    recent_tensions,
    recent_beliefs,
    voice_total: voiceTotalRes.count ?? 0,
    quote_total: quoteTotalRes.count ?? 0,
    previous_leaderboard,
  };
}

// ── Sibling context ────────────────────────────────

async function readSiblings(): Promise<string> {
  const [guy, buddy, bruh] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
    readLatestAgentOutput("what-if"),
  ]);

  const lines: string[] = [];
  if (guy) lines.push(`**Guy** [${guy.severity}]: ${guy.markdown.slice(0, 300)}`);
  if (buddy) lines.push(`**Buddy** [${buddy.severity}]: ${buddy.markdown.slice(0, 300)}`);
  if (bruh) lines.push(`**Bruh** [${bruh.severity}]: ${bruh.markdown.slice(0, 300)}`);
  return lines.length > 0 ? "\n# Siblings\n\n" + lines.join("\n\n") : "";
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are Clark, a voice reporter and columnist for Ben Langsfeld. You read his voice corpus — the quotes, compressions, reframes, and cross-domain bridges that Grain extracts from his meetings — and produce two things:

## 1. Voice Leaderboard (top 15)

Rank the voice atoms by:
- **Quotability** — would someone screenshot this and share it? Could it open an essay?
- **Technique power** — how strong is the compression, reframe, or cross-domain bridge?
- **Reusability** — can this line work across multiple contexts (pitches, essays, talks)?
- **Originality** — does it say something nobody else would say this way?

For each entry: position, the quote, a 3-5 word technique tag (e.g. "biology→branding bridge", "reset-loop diagnosis", "ski metaphor for growth"), and the source meeting.

If previous_leaderboard IDs are provided, mark movement:
- 🆕 = new entry this week
- ↑ = moved up from last week
- → = held position
- ↓ = moved down

End the leaderboard with one stat line: total voice moments captured, top technique category, streak info if any.

## 2. Writing Pitches (3 essays)

Each pitch is seeded by a voice atom from the leaderboard. The atom is the hook; the essay is the argument. Cross with tensions and beliefs for thematic depth.

For each pitch:
- **Title** — punchy, observational, magazine-cover energy
- **Hook** — the voice atom that seeds it (quote it)
- **Angle** — the argument or thesis, 2-3 sentences
- **Audience** — who reads this (Residence network, broader creative industry, LinkedIn, Substack)
- **Tension it engages** — which active tension this speaks to

## Voice
You're a features editor at a magazine that covers creative leadership. Intelligent, curious, appreciative of craft. You don't gush — you notice. When a line is good, you say why it works, not that it's "amazing."

Banned: leverage, ecosystem, synergy, thought leader, innovative, game-changing.

## Output format
Return ONLY markdown (no JSON wrapping). Structure:

---
(no frontmatter needed — I add it)

# Clark — Voice Report

## Voice Leaderboard

1. 🆕 [atom-uuid-here] "exact quote" — _technique tag_ · Source Meeting (YYYY-MM-DD)
2. 🆕 [atom-uuid-here] "exact quote" — _technique tag_ · Source Meeting (YYYY-MM-DD)
...(up to 15)

_Stats: X total voice moments captured. Top technique: compression. Y new this week._

## Writing Pitches

### 1. Essay Title
**Hook:** "the voice atom quote"
**Angle:** the argument, 2-3 sentences
**Audience:** who reads this
**Tension:** which active tension

(repeat for 3 pitches)

IMPORTANT: Each leaderboard entry MUST include the atom UUID in square brackets [uuid] so I can track movement week over week. Use the IDs from the corpus I gave you. Keep total output under 1500 words.

## History awareness — EVOLVE, DON'T REPEAT
You receive your previous outputs. Don't pitch the same essays again. If a voice atom held #1 for 3 weeks, note its streak but find a new pitch angle. If essay pitches from previous runs haven't been acted on, try completely different themes. The leaderboard CAN have repeat entries (good quotes stay good), but the pitches should always be fresh.`;

// ── Context building ───────────────────────────────

function buildContext(facts: ClarkFacts, siblings: string): string {
  const lines: string[] = [];
  lines.push(`# Voice corpus: ${facts.voice_total} total voice atoms, ${facts.quote_total} total quotes`);
  lines.push(`Last 30 days: ${facts.voice_atoms.length} voice atoms, ${facts.top_quotes.length} quotes`);
  lines.push("");

  lines.push("## Voice atoms (last 30 days, ranked candidates)");
  for (const [i, v] of facts.voice_atoms.entries()) {
    lines.push(`${i + 1}. [${v.id}] "${v.quote}"`);
    if (v.technique) lines.push(`   Technique: ${v.technique}`);
    if (v.use_for) lines.push(`   Use for: ${v.use_for}`);
    if (v.source_title) lines.push(`   From: ${v.source_title} (${v.source_date ?? "?"})`);
    lines.push("");
  }

  if (facts.top_quotes.length > 0) {
    lines.push("## Notable quotes from others (context, not leaderboard candidates)");
    for (const q of facts.top_quotes.slice(0, 15)) {
      lines.push(`- ${q.speaker ?? "?"}: "${q.text}" [${q.weight ?? "?"}] — ${q.reasoning ?? ""}`);
    }
    lines.push("");
  }

  if (facts.recent_tensions.length > 0) {
    lines.push("## Active tensions (for essay angles)");
    for (const t of facts.recent_tensions) {
      lines.push(`- ${t.pair} (${t.count}×)`);
    }
    lines.push("");
  }

  if (facts.recent_beliefs.length > 0) {
    lines.push("## Beliefs surfaced (for thematic grounding)");
    for (const b of facts.recent_beliefs.slice(0, 10)) {
      lines.push(`- ${b.person ? `${b.person}: ` : ""}${b.statement}`);
    }
    lines.push("");
  }

  if (facts.previous_leaderboard) {
    lines.push("## Last week's leaderboard (atom IDs, top to bottom, for movement tracking)");
    for (const [i, id] of facts.previous_leaderboard.entries()) {
      lines.push(`${i + 1}. ${id}`);
    }
    lines.push("");
  } else {
    lines.push("_No previous leaderboard — this is the inaugural run. All entries are 🆕._");
    lines.push("");
  }

  if (siblings) lines.push(siblings);

  lines.push("---");
  lines.push("Produce the leaderboard (top 15) and three writing pitches. Return JSON per the schema.");
  return lines.join("\n");
}

// ── Parse leaderboard IDs from markdown ────────────

function extractLeaderboardIds(markdown: string): string[] {
  // Pattern: [atom-uuid] in leaderboard entries
  const UUID_PATTERN = /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
  const ids: string[] = [];
  for (const match of markdown.matchAll(UUID_PATTERN)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids.slice(0, 15); // cap at 15
}

// ── Entrypoint ─────────────────────────────────────

export interface ClarkReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  leaderboard_ids: string[];
  pitches_count: number;
  stats: { total_voice: number; total_quotes: number };
}

export async function runAndWriteColumnist(): Promise<{ output_id: string; report: ClarkReport }> {
  const run_at = new Date().toISOString();
  const [facts, siblings, history] = await Promise.all([gatherFacts(), readSiblings(), readOwnHistory(AGENT_ID, 4)]);

  // Build history context
  let historyBlock = "";
  if (history.length > 0) {
    const lines = ["\n# Your previous outputs (DON'T REPEAT ESSAY PITCHES)", ""];
    for (const h of history) {
      lines.push(`Run: ${h.run_at} — ${h.markdown_preview.slice(0, 400)}`);
      lines.push("");
    }
    historyBlock = lines.join("\n");
  }

  const anthropic = getAnthropicClient(90_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: buildContext(facts, siblings) + historyBlock }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";

  let markdown: string;
  let leaderboard_ids: string[] = [];

  if (text.length > 100) {
    // Clean any code fences Claude might have wrapped around the markdown
    markdown = text.replace(/^```(?:markdown)?\s*\n?|\n?```\s*$/g, "").trim();
    leaderboard_ids = extractLeaderboardIds(markdown);
  } else {
    markdown = `# ${PERSONA} — voice report\n\n_Reasoning failed. ${facts.voice_atoms.length} voice atoms available. Retry next week._`;
  }

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: green\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  const report: ClarkReport = {
    run_at,
    severity: "green",
    markdown,
    leaderboard_ids,
    pitches_count: leaderboard_ids.length > 0 ? 3 : 0, // pitches embedded in markdown
    stats: { total_voice: facts.voice_total, total_quotes: facts.quote_total },
  };

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity: report.severity,
    markdown,
    findings: {
      leaderboard_ids, // stored for next week's movement tracking
      pitches_count: report.pitches_count,
      stats: { total_voice: facts.voice_total, total_quotes: facts.quote_total },
    },
    metadata: { version: "0.1", model: MODEL, reasoning: true },
  });

  return { output_id: id, report };
}
