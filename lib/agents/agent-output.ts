/**
 * Agent output writer. Generic helper for all six agents in the architecture.
 * Writes one row per run to agent_outputs. /boot reads latest per agent_id
 * and materializes 70-agents/{agent_id}.md in the vault.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { beat, type HeartbeatStatus } from "@/lib/heartbeat";

export type AgentSeverity = "green" | "attention" | "failure";

// Expected cadence per agent (hours). If no fresh pulse within this window,
// the heartbeat materializer flags stale. Derived from vercel.json schedules
// with a safety margin (~25% slack).
const AGENT_CADENCE_HOURS: Record<string, number> = {
  "grain-steward": 30,       // daily — Vercel 12:53 UTC
  "ea": 30,                  // daily — Vercel 13:07 UTC
  "security-steward": 30,    // daily — Vercel 13:23 UTC
  "wiki-librarian": 18,      // twice daily — local orchestrator 06:45/19:45
  "what-if": 200,            // weekly Mon — Vercel 14:37 UTC
  "columnist": 200,          // weekly Wed — Vercel 14:47 UTC
  "notion-steward": 200,     // weekly Mon — Vercel 14:27 UTC
  "wrap-steward": 0,         // ad-hoc, no schedule (0 = unknown)
};

function severityToHeartbeat(sev: AgentSeverity): HeartbeatStatus {
  if (sev === "green") return "ok";
  return sev; // "attention" | "failure"
}

export interface AgentOutput {
  agent_id: string;
  severity: AgentSeverity;
  markdown: string;
  findings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function writeAgentOutput(out: AgentOutput): Promise<{ id: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("agent_outputs")
    .insert({
      agent_id: out.agent_id,
      severity: out.severity,
      markdown: out.markdown,
      findings: out.findings ?? {},
      metadata: out.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) throw new Error(`agent_outputs insert failed: ${error.message}`);

  // Pulse — non-fatal. Absence of a fresh pulse tells us the agent didn't run.
  const cadence = AGENT_CADENCE_HOURS[out.agent_id];
  await beat({
    source: `agent.${out.agent_id}`,
    status: severityToHeartbeat(out.severity),
    summary: firstBodyLine(out.markdown) ?? `severity=${out.severity}`,
    cadenceHours: cadence && cadence > 0 ? cadence : undefined,
    metadata: { output_id: data.id, severity: out.severity },
  });

  return { id: data.id as string };
}

/**
 * Pull the first real content line out of an agent's markdown — skip
 * frontmatter, headings, and blank lines. Used for heartbeat summaries.
 */
function firstBodyLine(markdown: string): string | null {
  // Strip leading frontmatter block
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;        // headings
    if (line.startsWith("---")) continue;      // rules / delimiters
    if (line.startsWith("```")) continue;      // code fences
    return line.slice(0, 140);
  }
  return null;
}

/**
 * Latest output for an agent. Used by /boot materialization and sibling reads.
 */
export async function readLatestAgentOutput(agent_id: string): Promise<{
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  findings: Record<string, unknown>;
} | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("agent_outputs")
    .select("run_at, severity, markdown, findings")
    .eq("agent_id", agent_id)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`agent_outputs read failed: ${error.message}`);
  if (!data) return null;
  return {
    run_at: data.run_at as string,
    severity: data.severity as AgentSeverity,
    markdown: data.markdown as string,
    findings: (data.findings ?? {}) as Record<string, unknown>,
  };
}

/**
 * Own history — last N outputs for this agent. Used to avoid repetition.
 * Returns markdown summaries (truncated) for prompt context.
 */
export async function readOwnHistory(agent_id: string, limit = 4): Promise<Array<{
  run_at: string;
  severity: AgentSeverity;
  markdown_preview: string;
  findings: Record<string, unknown>;
}>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("agent_outputs")
    .select("run_at, severity, markdown, findings")
    .eq("agent_id", agent_id)
    .order("run_at", { ascending: false })
    .limit(limit + 1); // +1 because the most recent might be the current run's predecessor

  if (error) throw new Error(`agent_outputs history read failed: ${error.message}`);
  if (!data || data.length === 0) return [];

  return data.slice(0, limit).map((row) => ({
    run_at: row.run_at as string,
    severity: row.severity as AgentSeverity,
    markdown_preview: (row.markdown as string).slice(0, 500),
    findings: (row.findings ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Structured prior-run snapshot. Preferred over readOwnHistory for agents
 * that reason about deltas — passing numbers avoids re-importing yesterday's
 * narrative framing, which is the mechanism behind the Guy/Dood/Buddy echo
 * chamber where "RLS breach" and "Same findings as yesterday" persisted even
 * after the underlying numbers moved.
 */
export async function readOwnSnapshot(agent_id: string): Promise<{
  run_at: string;
  hours_ago: number;
  severity: AgentSeverity;
  findings: Record<string, unknown>;
} | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("agent_outputs")
    .select("run_at, severity, findings")
    .eq("agent_id", agent_id)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`agent_outputs snapshot read failed: ${error.message}`);
  if (!data) return null;

  const runAt = data.run_at as string;
  const hoursAgo = Math.round(((Date.now() - new Date(runAt).getTime()) / 3_600_000) * 10) / 10;

  return {
    run_at: runAt,
    hours_ago: hoursAgo,
    severity: data.severity as AgentSeverity,
    findings: (data.findings ?? {}) as Record<string, unknown>,
  };
}
