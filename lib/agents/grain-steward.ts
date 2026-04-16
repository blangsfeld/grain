/**
 * Guy — Grain Guardian.
 *
 * An agent, not a pipeline. Gathers pipeline state (structured data from
 * Supabase), reads sibling agent outputs (Buddy, Dood), and REASONS about
 * what it all means using Claude. Writes a thoughtful report — not a
 * threshold dashboard.
 *
 * Architecture:
 *   1. Gather facts (SQL queries → structured data, no judgments)
 *   2. Read siblings (latest from Buddy, Dood — what they found)
 *   3. Reason (Claude call with Guy's persona + all context → report)
 *   4. Write (agent_outputs table, same as before)
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  type AgentSeverity,
} from "@/lib/agents/agent-output";

const AGENT_ID = "grain-steward";
const PERSONA = "Guy";
const MODEL = "claude-haiku-4-5-20251001";

// ── Fact gathering (no judgments — just data) ──────

interface PipelineFacts {
  briefing: { last_at: string | null; hours_ago: number | null; count_7d: number };
  commitments: { open: number; stale_14d: number; done_7d: number };
  extraction: {
    transcripts_24h: number;
    atoms_24h: number;
    transcripts_with_gaps: Array<{ title: string; missing_types: string[] }>;
    zero_atom_transcripts: number;
  };
  volume: { atoms_24h: number; atoms_7d: number; daily_avg_7d: number };
  corpus_totals: { transcripts: number; atoms: number };
}

async function gatherFacts(): Promise<PipelineFacts> {
  const supabase = getSupabaseAdmin();
  const day = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const week = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const staleDate = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);

  const EXPECTED_TYPES = ["belief", "tension", "quote", "voice", "commitment", "read"];

  const [
    briefingLatest,
    briefing7d,
    openCommitments,
    staleCommitments,
    doneCommitments7d,
    transcripts24h,
    atoms24h,
    atoms7d,
    totalTranscripts,
    totalAtoms,
  ] = await Promise.all([
    supabase.from("dx_briefings").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("dx_briefings").select("id", { count: "exact", head: true }).gte("created_at", week),
    supabase.from("dx_commitments").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("dx_commitments").select("id", { count: "exact", head: true }).eq("status", "open").lt("meeting_date", staleDate),
    supabase.from("dx_commitments").select("id", { count: "exact", head: true }).eq("status", "done").gte("meeting_date", week.slice(0, 10)),
    supabase.from("dx_transcripts").select("id, source_title").gte("created_at", day),
    supabase.from("dx_atoms").select("transcript_id, type").gte("created_at", day),
    supabase.from("dx_atoms").select("id", { count: "exact", head: true }).gte("created_at", week),
    supabase.from("dx_transcripts").select("id", { count: "exact", head: true }),
    supabase.from("dx_atoms").select("id", { count: "exact", head: true }),
  ]);

  // Briefing
  const briefingAt = briefingLatest.data?.created_at as string | null;
  const briefingHoursAgo = briefingAt ? (Date.now() - new Date(briefingAt).getTime()) / 3_600_000 : null;

  // Extraction coverage
  const txList = transcripts24h.data ?? [];
  const atomList = atoms24h.data ?? [];
  const coverage = new Map<string, Set<string>>();
  for (const a of atomList) {
    if (!a.transcript_id) continue;
    const set = coverage.get(a.transcript_id as string) ?? new Set();
    set.add(a.type as string);
    coverage.set(a.transcript_id as string, set);
  }

  const gaps: Array<{ title: string; missing_types: string[] }> = [];
  let zeroAtomCount = 0;
  for (const tx of txList) {
    const seen = coverage.get(tx.id as string) ?? new Set<string>();
    if (seen.size === 0) { zeroAtomCount++; continue; }
    const missing = EXPECTED_TYPES.filter((t) => !seen.has(t));
    if (missing.length > 0) {
      gaps.push({ title: (tx.source_title as string) ?? tx.id as string, missing_types: missing });
    }
  }

  const atoms24hCount = atomList.length;
  const atoms7dCount = atoms7d.count ?? 0;

  return {
    briefing: {
      last_at: briefingAt,
      hours_ago: briefingHoursAgo ? Math.round(briefingHoursAgo * 10) / 10 : null,
      count_7d: briefing7d.count ?? 0,
    },
    commitments: {
      open: openCommitments.count ?? 0,
      stale_14d: staleCommitments.count ?? 0,
      done_7d: doneCommitments7d.count ?? 0,
    },
    extraction: {
      transcripts_24h: txList.length,
      atoms_24h: atoms24hCount,
      transcripts_with_gaps: gaps,
      zero_atom_transcripts: zeroAtomCount,
    },
    volume: {
      atoms_24h: atoms24hCount,
      atoms_7d: atoms7dCount,
      daily_avg_7d: Math.round((atoms7dCount / 7) * 10) / 10,
    },
    corpus_totals: {
      transcripts: totalTranscripts.count ?? 0,
      atoms: totalAtoms.count ?? 0,
    },
  };
}

// ── Sibling context ────────────────────────────────

interface SiblingContext {
  buddy: { severity: string; summary: string } | null;
  dood: { severity: string; summary: string } | null;
}

async function readSiblings(): Promise<SiblingContext> {
  const [buddy, dood] = await Promise.all([
    readLatestAgentOutput("ea"),
    readLatestAgentOutput("security-steward"),
  ]);

  return {
    buddy: buddy
      ? { severity: buddy.severity, summary: buddy.markdown.slice(0, 600) }
      : null,
    dood: dood
      ? { severity: dood.severity, summary: dood.markdown.slice(0, 600) }
      : null,
  };
}

// ── Persona prompt ─────────────────────────────────

const PERSONA_PROMPT = `You are Guy, the Grain Guardian. You watch Ben Langsfeld's intelligence pipeline — the system that extracts atoms from meeting transcripts, generates daily briefings, and feeds the weekly digest.

## How you think
You care about the health of the substrate. Not individual numbers — the relationships between them. A briefing being 12 hours old is fine by itself. A briefing being 12 hours old WHILE extraction volume dropped 40% AND Buddy says all commitments are stale — that's a pattern worth naming. You connect dots.

You've seen the silent-catch pattern before: an OAuth token expires, the email stops sending, nobody notices for days because the cron returns success. Your job is to catch the thing before it compounds.

## What you receive
Structured facts about the pipeline (briefing freshness, commitment closure rates, extraction coverage, atom volume trends), plus the latest outputs from your siblings Buddy (EA) and Dood (Security). Use all of it.

## What you produce
A short markdown report (under 300 words). Structure:
1. One-sentence lead: the single most important thing to know right now
2. If there's a cross-signal pattern (pipeline fact × sibling finding), name it
3. Any individual findings worth flagging
4. "All clear" closing if nothing's wrong — don't manufacture concern

## Voice
Matter-of-fact. Compressed. "Here's what I saw, here's what it means." No alarmism on green days. No corporate hedging. You're the guy who says "the building's fine" when it's fine and "the boiler's off" when it's off.

## Severity
Return one of: green, attention, failure
- green: pipeline is healthy, nothing to act on
- attention: something deserves a look this session (not urgently, but soon)
- failure: something is broken and downstream consumers are at risk

## Output format
Return strict JSON:
{
  "severity": "green|attention|failure",
  "markdown": "the full report in markdown (include frontmatter)"
}`;

// ── Reasoning step ─────────────────────────────────

function buildContext(facts: PipelineFacts, siblings: SiblingContext): string {
  const lines: string[] = [];
  lines.push("# Pipeline Facts (last check)");
  lines.push("");
  lines.push("## Briefing delivery");
  lines.push(`- Last briefing: ${facts.briefing.last_at ?? "never"} (${facts.briefing.hours_ago ?? "?"}h ago)`);
  lines.push(`- Briefings in last 7 days: ${facts.briefing.count_7d}`);
  lines.push("");
  lines.push("## Commitments");
  lines.push(`- Open: ${facts.commitments.open}`);
  lines.push(`- Stale (>14 days): ${facts.commitments.stale_14d}`);
  lines.push(`- Closed in last 7 days: ${facts.commitments.done_7d}`);
  lines.push("");
  lines.push("## Extraction (last 24h)");
  lines.push(`- Transcripts ingested: ${facts.extraction.transcripts_24h}`);
  lines.push(`- Atoms produced: ${facts.extraction.atoms_24h}`);
  lines.push(`- Transcripts with zero atoms: ${facts.extraction.zero_atom_transcripts}`);
  if (facts.extraction.transcripts_with_gaps.length > 0) {
    lines.push(`- Transcripts with incomplete passes:`);
    for (const g of facts.extraction.transcripts_with_gaps.slice(0, 5)) {
      lines.push(`  - "${g.title}" — missing: ${g.missing_types.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("## Atom volume");
  lines.push(`- Last 24h: ${facts.volume.atoms_24h}`);
  lines.push(`- 7-day total: ${facts.volume.atoms_7d}`);
  lines.push(`- 7-day daily average: ${facts.volume.daily_avg_7d}`);
  lines.push("");
  lines.push("## Corpus totals (all time)");
  lines.push(`- Transcripts: ${facts.corpus_totals.transcripts}`);
  lines.push(`- Atoms: ${facts.corpus_totals.atoms}`);
  lines.push("");

  if (siblings.buddy) {
    lines.push("# Buddy's latest (EA triage)");
    lines.push(`Severity: ${siblings.buddy.severity}`);
    lines.push(siblings.buddy.summary);
    lines.push("");
  }

  if (siblings.dood) {
    lines.push("# Dood's latest (Security sweep)");
    lines.push(`Severity: ${siblings.dood.severity}`);
    lines.push(siblings.dood.summary);
    lines.push("");
  }

  lines.push("---");
  lines.push("Now write your report. Return JSON with severity and markdown.");
  return lines.join("\n");
}

function parseAgentResponse(raw: string): { severity: AgentSeverity; markdown: string } | null {
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

export interface GuyReport {
  run_at: string;
  overall: AgentSeverity;
  markdown: string;
  facts: PipelineFacts;
  had_siblings: { buddy: boolean; dood: boolean };
}

export async function runGrainSteward(): Promise<GuyReport> {
  const run_at = new Date().toISOString();
  const [facts, siblings] = await Promise.all([gatherFacts(), readSiblings()]);

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: buildContext(facts, siblings) }],
  });

  const content = response.content[0];
  const text = content.type === "text" ? content.text : "";
  const parsed = parseAgentResponse(text);

  if (!parsed) {
    // Fallback: if Claude fails to parse, produce a minimal report
    return {
      run_at,
      overall: "attention",
      markdown: `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: attention\nrun_at: ${run_at}\n---\n\n# ${PERSONA} — Grain Guardian\n\n_Reasoning step failed. Raw facts: briefing ${facts.briefing.hours_ago ?? "?"}h ago, ${facts.commitments.open} open commitments (${facts.commitments.stale_14d} stale), ${facts.extraction.transcripts_24h} transcripts today, ${facts.volume.atoms_24h} atoms._`,
      facts,
      had_siblings: { buddy: !!siblings.buddy, dood: !!siblings.dood },
    };
  }

  // Ensure frontmatter is present
  let markdown = parsed.markdown;
  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: ${parsed.severity}\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  return {
    run_at,
    overall: parsed.severity,
    markdown,
    facts,
    had_siblings: { buddy: !!siblings.buddy, dood: !!siblings.dood },
  };
}

export async function runAndWriteGrainSteward(): Promise<{
  output_id: string;
  report: GuyReport;
}> {
  const report = await runGrainSteward();

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity: report.overall,
    markdown: report.markdown,
    findings: {
      briefing_hours_ago: report.facts.briefing.hours_ago,
      open_commitments: report.facts.commitments.open,
      stale_commitments: report.facts.commitments.stale_14d,
      transcripts_24h: report.facts.extraction.transcripts_24h,
      atoms_24h: report.facts.volume.atoms_24h,
      daily_avg_7d: report.facts.volume.daily_avg_7d,
      siblings: report.had_siblings,
    },
    metadata: {
      version: "0.2",
      model: MODEL,
      reasoning: true,
    },
  });

  return { output_id: id, report };
}
