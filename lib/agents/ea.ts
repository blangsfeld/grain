/**
 * Buddy — Executive Assistant (agent version).
 *
 * Gathers open commitments with classifier labels, reads sibling outputs
 * (Guy, Dood), and reasons about what's rising using Claude. The classifier
 * labels (from Ben's training pass) become facts in the context, not the
 * final word — Claude synthesizes the triage.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  readOwnHistory,
  type AgentSeverity,
} from "@/lib/agents/agent-output";
import {
  classifyBatch,
  type Classification,
  type CommitmentRow,
} from "@/lib/agents/ea-classifier";

const AGENT_ID = "ea";
const PERSONA = "Buddy";
const OWNER = "Ben";
const MODEL = "claude-haiku-4-5-20251001";

// ── Fact gathering ─────────────────────────────────

interface ClassifiedCommitment {
  commitment: CommitmentRow;
  classification: Classification;
  age_days: number;
  overdue_days: number | null;
}

interface BuddyFacts {
  all_open: ClassifiedCommitment[];
  ben_items: ClassifiedCommitment[];
  others_items: ClassifiedCommitment[];
  skipped_count: number;
  total_open: number;
}

async function gatherFacts(): Promise<BuddyFacts> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dx_commitments")
    .select("id, statement, category, meeting_title, meeting_date, due_date, status, person")
    .eq("status", "open")
    .order("meeting_date", { ascending: true });

  if (error) throw new Error(`dx_commitments query: ${error.message}`);
  const commitments = (data ?? []) as CommitmentRow[];

  const classifications = await classifyBatch(commitments);
  const today = new Date();

  const all_open: ClassifiedCommitment[] = [];
  let skipped = 0;

  for (const c of commitments) {
    const cl = classifications.get(c.id) ?? { weight: "medium" as const, reason: "unclassified", source: "fallback" as const };
    if (cl.weight === "skip") { skipped++; continue; }

    const meetDate = c.meeting_date ? new Date(c.meeting_date) : null;
    const dueDate = c.due_date ? new Date(c.due_date) : null;
    const age = meetDate ? Math.floor((today.getTime() - meetDate.getTime()) / 86_400_000) : 0;
    const overdue = dueDate ? Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000) : null;

    all_open.push({ commitment: c, classification: cl, age_days: age, overdue_days: overdue });
  }

  return {
    all_open,
    ben_items: all_open.filter((x) => x.commitment.person === OWNER),
    others_items: all_open.filter((x) => x.commitment.person !== OWNER),
    skipped_count: skipped,
    total_open: commitments.length,
  };
}

// ── Sibling context ────────────────────────────────

async function readSiblings(): Promise<{ guy: string | null; dood: string | null }> {
  const [guy, dood] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("security-steward"),
  ]);
  return {
    guy: guy ? `Severity: ${guy.severity}\n${guy.markdown.slice(0, 600)}` : null,
    dood: dood ? `Severity: ${dood.severity}\n${dood.markdown.slice(0, 400)}` : null,
  };
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are Buddy, Ben Langsfeld's executive assistant agent. You track commitments — things Ben and his team agreed to do in meetings — and surface what's rising.

## How you think
You don't list everything. You triage. What's rising means: what has a deadline approaching, what's been dormant long enough to signal a dropped ball, what connects to something Guy or Dood flagged. A commitment that's 24 days old with no deadline isn't urgent — it might just be done and unlogged. Say so.

You understand Ben's labeling system (high/medium/low/skip from his training pass). Use these as signal but don't just repeat them. Ben labeled "Block calendar time" as skip because it's scaffolding — apply that logic to similar items even if they haven't been explicitly labeled.

## What you receive
- Classified commitments (statement, person, category, meeting_date, due_date, classifier weight + reason, age, overdue days)
- Guy's latest pipeline report
- Dood's latest security sweep

## What you produce
A short triage (under 250 words):
1. Lead with what needs attention, if anything
2. Split: what's on Ben's plate vs. what's on others' plates
3. Cross-signal if Guy or Dood found something that relates (e.g., "pipeline's quiet today so no new commitments are being extracted")
4. If everything is stale/aging, say it plainly — "nothing's urgent, but the commitment DB needs a cleanup pass"

## Voice
Direct. No corporate hedging. "You have two things. Neither is urgent. Here's why they're still open." Like a capable chief of staff who doesn't waste your morning.

Banned: leverage, ecosystem, seamless, robust, actionable, circle back.

## History awareness
You receive your last report. If the same commitments are still open with no change in age/status, say "Same picture as yesterday — N items, nothing moved." Don't re-triage identical data. Only write a full report when items close, new ones appear, or deadlines approach.

## Severity
- green: nothing needs attention today
- attention: something is overdue or approaching a deadline
- failure: a high-weight commitment is significantly overdue and unaddressed

## Output
Return strict JSON:
{"severity": "green|attention|failure", "markdown": "full report with frontmatter"}`;

// ── Reasoning ──────────────────────────────────────

function buildContext(facts: BuddyFacts, siblings: { guy: string | null; dood: string | null }, ownHistory: Array<{ markdown_preview: string }> = []): string {
  const lines: string[] = [];
  lines.push(`# Commitment data (${facts.total_open} open, ${facts.skipped_count} classified as skip/scaffolding, ${facts.all_open.length} real)`);
  lines.push("");

  if (facts.ben_items.length > 0) {
    lines.push(`## Ben's plate (${facts.ben_items.length})`);
    for (const x of facts.ben_items) {
      const c = x.commitment;
      const cl = x.classification;
      lines.push(`- "${c.statement}" [${cl.weight}, ${cl.source}: ${cl.reason}]`);
      lines.push(`  person: ${c.person} · category: ${c.category ?? "—"} · meeting: ${c.meeting_title ?? "—"}`);
      lines.push(`  age: ${x.age_days}d${x.overdue_days !== null ? ` · overdue: ${x.overdue_days}d` : " · no deadline"}`);
    }
    lines.push("");
  }

  if (facts.others_items.length > 0) {
    lines.push(`## Others' plates (${facts.others_items.length})`);
    for (const x of facts.others_items.slice(0, 10)) {
      const c = x.commitment;
      const cl = x.classification;
      lines.push(`- ${c.person}: "${c.statement}" [${cl.weight}] · ${x.age_days}d old`);
    }
    lines.push("");
  }

  if (siblings.guy) {
    lines.push("# Guy's latest (pipeline health)");
    lines.push(siblings.guy);
    lines.push("");
  }
  if (siblings.dood) {
    lines.push("# Dood's latest (security)");
    lines.push(siblings.dood);
    lines.push("");
  }

  if (ownHistory.length > 0) {
    lines.push("# Your last report (don't repeat if nothing changed)");
    lines.push(ownHistory[0].markdown_preview);
    lines.push("");
  }

  lines.push("---");
  lines.push("Write your triage. Return JSON with severity and markdown.");
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

export interface BuddyReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  facts: { total_open: number; skipped: number; ben_count: number; others_count: number };
  had_siblings: { guy: boolean; dood: boolean };
}

export async function runAndWriteEa(): Promise<{ output_id: string; report: BuddyReport }> {
  const run_at = new Date().toISOString();
  const [facts, siblings, ownHistory] = await Promise.all([gatherFacts(), readSiblings(), readOwnHistory(AGENT_ID, 2)]);

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
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
    markdown = `# ${PERSONA} — triage\n\n_Reasoning step failed. ${facts.ben_items.length} items on your plate, ${facts.others_items.length} on others'._`;
  }

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: ${severity}\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  const reportData: BuddyReport = {
    run_at,
    severity,
    markdown,
    facts: {
      total_open: facts.total_open,
      skipped: facts.skipped_count,
      ben_count: facts.ben_items.length,
      others_count: facts.others_items.length,
    },
    had_siblings: { guy: !!siblings.guy, dood: !!siblings.dood },
  };

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity,
    markdown,
    findings: reportData.facts,
    metadata: { version: "0.2-agent", model: MODEL, reasoning: true },
  });

  return { output_id: id, report: reportData };
}
