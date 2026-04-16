/**
 * Agent output writer. Generic helper for all six agents in the architecture.
 * Writes one row per run to agent_outputs. /boot reads latest per agent_id
 * and materializes 70-agents/{agent_id}.md in the vault.
 */

import { getSupabaseAdmin } from "@/lib/supabase";

export type AgentSeverity = "green" | "attention" | "failure";

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
  return { id: data.id as string };
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
