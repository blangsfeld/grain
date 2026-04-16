/**
 * Dood — Security Watchdog (agent version).
 *
 * Gathers Supabase advisor findings across all 6 projects, reads sibling
 * outputs (Guy, Buddy), and reasons about what the security posture means
 * in context. Not a compliance report — a pointed heads-up.
 */

import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  type AgentSeverity,
} from "@/lib/agents/agent-output";

const AGENT_ID = "security-steward";
const PERSONA = "Dood";
const MODEL = "claude-haiku-4-5-20251001";

const PROJECTS = [
  { ref: "wizrcoqlkgjaofvoosdk", name: "JPMP" },
  { ref: "fchixvkvunfwsxkdjeln", name: "buck-crm" },
  { ref: "hkqnbwbkqgrfcawxppsz", name: "LORE" },
  { ref: "hinyjklmmbtrapqzqlhm", name: "Canvas" },
  { ref: "sgzmlhlpkjcesvpggvxa", name: "Attic" },
  { ref: "znyermbuvnpulpfutros", name: "Source (grain)" },
] as const;

// ── Fact gathering ─────────────────────────────────

interface AdvisorLint {
  name: string;
  title: string;
  level: string;
  detail: string;
  remediation: string;
  metadata?: Record<string, unknown>;
}

interface ProjectFindings {
  ref: string;
  name: string;
  ok: boolean;
  error?: string;
  errors: AdvisorLint[];
  warnings: AdvisorLint[];
  info_count: number;
  info_rules: Record<string, number>;
}

interface DoodFacts {
  projects: ProjectFindings[];
  total_errors: number;
  total_warnings: number;
  total_info: number;
}

async function fetchAdvisors(
  ref: string, token: string,
): Promise<{ ok: true; lints: AdvisorLint[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/advisors/security`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    const data = (await res.json()) as { lints?: AdvisorLint[] };
    return { ok: true, lints: data.lints ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function gatherFacts(): Promise<DoodFacts> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    return {
      projects: [],
      total_errors: 0, total_warnings: 0, total_info: 0,
    };
  }

  const results = await Promise.all(
    PROJECTS.map(async (p): Promise<ProjectFindings> => {
      const res = await fetchAdvisors(p.ref, token);
      if (!res.ok) {
        return { ref: p.ref, name: p.name, ok: false, error: res.error, errors: [], warnings: [], info_count: 0, info_rules: {} };
      }
      const errors: AdvisorLint[] = [];
      const warnings: AdvisorLint[] = [];
      const info_rules: Record<string, number> = {};
      let info_count = 0;
      for (const l of res.lints) {
        if (l.level === "ERROR") errors.push(l);
        else if (l.level === "WARN") warnings.push(l);
        else { info_count++; info_rules[l.name] = (info_rules[l.name] ?? 0) + 1; }
      }
      return { ref: p.ref, name: p.name, ok: true, errors, warnings, info_count, info_rules };
    }),
  );

  return {
    projects: results,
    total_errors: results.reduce((a, r) => a + r.errors.length, 0),
    total_warnings: results.reduce((a, r) => a + r.warnings.length, 0),
    total_info: results.reduce((a, r) => a + r.info_count, 0),
  };
}

// ── Sibling context ────────────────────────────────

async function readSiblings(): Promise<{ guy: string | null; buddy: string | null }> {
  const [guy, buddy] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
  ]);
  return {
    guy: guy ? `Severity: ${guy.severity}\n${guy.markdown.slice(0, 500)}` : null,
    buddy: buddy ? `Severity: ${buddy.severity}\n${buddy.markdown.slice(0, 400)}` : null,
  };
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are Dood, a security watchdog for Ben Langsfeld's app ecosystem. You sweep six Supabase projects daily for security findings and tell Ben what matters.

## How you think
You prioritize by blast radius and exploitability, not by count. 36 permissive RLS policies on JPMP is one pattern ("someone used USING(true) everywhere"), not 36 separate incidents. Group them. Name the pattern.

Cross-reference with siblings. If Guy says the pipeline is healthy but you found 19 WARN findings in the grain source DB, that's worth connecting — "pipeline works, but the data it produces is more exposed than it should be."

The 2026-04-15 baseline said all 6 projects were remediated. If your scan shows otherwise, call it drift — that's the whole point of monitoring.

## What you receive
- Per-project advisor findings (ERRORS, WARNINGS, INFO counts + details)
- Guy's latest pipeline report
- Buddy's latest triage

## What you produce
A security sweep (under 300 words):
1. Lead with the worst finding or "all clear" if clean
2. Group warnings by pattern, not by table name
3. Cross-signal with siblings if relevant
4. For each pattern, include the remediation link
5. Don't list 30 tables — name the pattern, count them, show 3-4 examples

## Voice
Casual but clear. "Yo, 36 tables in JPMP have wide-open RLS" not "Multiple tables were found to have overly permissive policies." You're the friend who actually tells you the door's unlocked.

Banned: leverage, ecosystem, robust, proactive, remediate (use "fix"), holistic.

## Severity
- green: no WARN or ERROR findings
- attention: WARN findings exist
- failure: ERROR findings or fetch failures

## Output
Return strict JSON:
{"severity": "green|attention|failure", "markdown": "full report with frontmatter"}`;

// ── Reasoning ──────────────────────────────────────

function buildContext(facts: DoodFacts, siblings: { guy: string | null; buddy: string | null }): string {
  const lines: string[] = [];

  if (facts.projects.length === 0) {
    lines.push("SUPABASE_ACCESS_TOKEN is missing. Cannot scan projects.");
    lines.push("Tell Ben: generate a PAT at supabase.com/dashboard/account/tokens and add to .env.local.");
    lines.push("---");
    lines.push("Return a failure-severity report explaining the missing token.");
    return lines.join("\n");
  }

  lines.push(`# Security scan — ${facts.projects.length} projects`);
  lines.push(`Totals: ${facts.total_errors} ERROR, ${facts.total_warnings} WARN, ${facts.total_info} INFO`);
  lines.push("");

  for (const p of facts.projects) {
    lines.push(`## ${p.name} (${p.ref.slice(0, 8)}…)`);
    if (!p.ok) { lines.push(`FETCH FAILED: ${p.error}`); lines.push(""); continue; }
    if (p.errors.length === 0 && p.warnings.length === 0 && p.info_count === 0) {
      lines.push("Clean.");
    } else {
      if (p.errors.length > 0) {
        lines.push(`ERRORS (${p.errors.length}):`);
        for (const e of p.errors.slice(0, 5)) lines.push(`  - ${e.title}: ${e.detail} [${e.remediation}]`);
      }
      if (p.warnings.length > 0) {
        // Group by rule
        const byRule = new Map<string, { count: number; first: AdvisorLint; tables: string[] }>();
        for (const w of p.warnings) {
          const existing = byRule.get(w.name);
          const tableName = (w.metadata as { name?: string })?.name ?? "?";
          if (existing) { existing.count++; existing.tables.push(tableName); }
          else byRule.set(w.name, { count: 1, first: w, tables: [tableName] });
        }
        for (const [rule, group] of byRule) {
          lines.push(`WARN: ${group.first.title} × ${group.count} — tables: ${group.tables.slice(0, 6).join(", ")}${group.tables.length > 6 ? ` +${group.tables.length - 6} more` : ""}`);
          lines.push(`  fix: ${group.first.remediation}`);
        }
      }
      if (p.info_count > 0) {
        const rules = Object.entries(p.info_rules).map(([k, v]) => `${v}× ${k}`).join(", ");
        lines.push(`INFO (${p.info_count}): ${rules}`);
      }
    }
    lines.push("");
  }

  if (siblings.guy) {
    lines.push("# Guy's latest (pipeline)");
    lines.push(siblings.guy);
    lines.push("");
  }
  if (siblings.buddy) {
    lines.push("# Buddy's latest (triage)");
    lines.push(siblings.buddy);
    lines.push("");
  }

  lines.push("---");
  lines.push("Write your sweep report. Return JSON with severity and markdown.");
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

export interface DoodReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  totals: { errors: number; warnings: number; info: number };
  had_siblings: { guy: boolean; buddy: boolean };
}

export async function runAndWriteSecuritySteward(): Promise<{ output_id: string; report: DoodReport }> {
  const run_at = new Date().toISOString();
  const [facts, siblings] = await Promise.all([gatherFacts(), readSiblings()]);

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: buildContext(facts, siblings) }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const parsed = parseResponse(text);

  let severity: AgentSeverity;
  let markdown: string;

  if (parsed) {
    severity = parsed.severity;
    markdown = parsed.markdown;
  } else {
    severity = facts.total_errors > 0 || facts.projects.some((p) => !p.ok) ? "failure"
      : facts.total_warnings > 0 ? "attention" : "green";
    markdown = `# ${PERSONA} — security sweep\n\n_Reasoning failed. Totals: ${facts.total_errors} errors, ${facts.total_warnings} warnings across ${facts.projects.length} projects._`;
  }

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: ${severity}\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  const report: DoodReport = {
    run_at,
    severity,
    markdown,
    totals: { errors: facts.total_errors, warnings: facts.total_warnings, info: facts.total_info },
    had_siblings: { guy: !!siblings.guy, buddy: !!siblings.buddy },
  };

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity,
    markdown,
    findings: {
      ...report.totals,
      projects: facts.projects.map((p) => ({
        name: p.name, ok: p.ok, errors: p.errors.length, warnings: p.warnings.length, info: p.info_count,
      })),
    },
    metadata: { version: "0.2-agent", model: MODEL, reasoning: true },
  });

  return { output_id: id, report };
}
