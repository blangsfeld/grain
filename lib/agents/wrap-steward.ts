/**
 * Wrap Steward — session closer.
 *
 * Runs at the END of a Claude Code session. Reads the session's git diff,
 * all sibling agent outputs, and the conversation context to produce:
 *
 * 1. Decisions made this session
 * 2. Open questions going forward
 * 3. Beliefs surfaced or reinforced
 * 4. Voice moments worth noting (from the conversation itself)
 * 5. Memory candidates (things worth persisting to MEMORY.md)
 * 6. Aha moments — connections or insights that emerged
 * 7. Session summary for the vault project note
 *
 * Writes to agent_outputs and materializes directly to the vault.
 * NOT a cron — invoked by /wrap skill or manually.
 */

import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  type AgentSeverity,
} from "@/lib/agents/agent-output";

const AGENT_ID = "wrap-steward";
const PERSONA = "Wrap";
const MODEL = "claude-sonnet-4-6";

// ── Sibling context ────────────────────────────────

const SIBLING_IDS = [
  "grain-steward", "ea", "security-steward",
  "what-if", "columnist", "wiki-librarian",
];

async function readAllSiblings(): Promise<string> {
  const results = await Promise.all(
    SIBLING_IDS.map(async (id) => {
      const output = await readLatestAgentOutput(id);
      if (!output) return null;
      return `## ${id} [${output.severity}]\n${output.markdown.slice(0, 400)}`;
    }),
  );
  return results.filter(Boolean).join("\n\n");
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are the Wrap Steward — the session closer for Ben Langsfeld's agent ecosystem. You run at the end of a Claude Code session to capture what happened, what was decided, and what to carry forward.

## What you receive
- A git diff summary (what code changed this session)
- A session description (what Ben was working on — provided by the caller)
- The latest outputs from all sibling agents
- Optionally: specific conversation highlights the caller passes in

## What you produce
A structured wrap report with these sections:

### Decisions Made
Things that were decided during this session — architecture calls, naming choices, scope decisions. Each as a one-liner with enough context to be useful in 30 days.

### Open Questions
What's unresolved going forward. What the next session should address first.

### Beliefs Surfaced
Principles or convictions that emerged or were reinforced. "Agents own corpora, not personas." "Naming is foundation work." These compound across sessions.

### Voice Moments
If the session description includes any strong framings, compressions, or reframes from Ben — capture them in the same format as Grain's voice pass.

### Aha Moments
Cross-domain connections, surprising insights, things that changed how we think about the problem. The "oh wait" moments.

### Memory Candidates
Specific things worth persisting to MEMORY.md. New facts about the user, feedback on Claude's approach, project state changes, reference pointers. Be selective — only what future sessions need.

### Session Summary
2-3 sentences. What happened, what shipped, what's next. This goes into the project's vault note.

## Voice
Concise, observational. You're writing for future-Ben who'll read this cold. Every line should survive a 30-day test: "would this still be useful in a month?"

## Output
Return ONLY markdown (no JSON wrapper). I'll add frontmatter.`;

// ── Entrypoint ─────────────────────────────────────

export interface WrapInput {
  session_description: string;
  git_diff_summary?: string;
  conversation_highlights?: string;
  project?: string;
}

export interface WrapReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  project: string | null;
}

export async function runWrapSteward(input: WrapInput): Promise<{ output_id: string; report: WrapReport }> {
  const run_at = new Date().toISOString();
  const siblings = await readAllSiblings();

  const contextLines: string[] = [];
  contextLines.push("# Session Context");
  contextLines.push("");
  contextLines.push(`**Project:** ${input.project ?? "Studio (meta)"}`);
  contextLines.push(`**Date:** ${run_at}`);
  contextLines.push("");
  contextLines.push("## What happened this session");
  contextLines.push(input.session_description);
  contextLines.push("");

  if (input.git_diff_summary) {
    contextLines.push("## Git changes");
    contextLines.push(input.git_diff_summary);
    contextLines.push("");
  }

  if (input.conversation_highlights) {
    contextLines.push("## Conversation highlights (scan for voice moments + aha moments)");
    contextLines.push(input.conversation_highlights);
    contextLines.push("");
  }

  if (siblings) {
    contextLines.push("# Sibling agent state at session close");
    contextLines.push(siblings);
    contextLines.push("");
  }

  contextLines.push("---");
  contextLines.push("Write the wrap report. Return only markdown.");

  const anthropic = getAnthropicClient(60_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: contextLines.join("\n") }],
  });

  let markdown = response.content[0]?.type === "text" ? response.content[0].text : "";
  markdown = markdown.replace(/^```(?:markdown)?\s*\n?|\n?```\s*$/g, "").trim();

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: green\nrun_at: ${run_at}\nproject: ${input.project ?? "studio"}\n---\n\n${markdown}`;
  }

  const report: WrapReport = {
    run_at,
    severity: "green",
    markdown,
    project: input.project ?? null,
  };

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity: report.severity,
    markdown,
    findings: {
      project: input.project,
      had_git_diff: !!input.git_diff_summary,
      had_highlights: !!input.conversation_highlights,
    },
    metadata: { version: "0.1", model: MODEL, reasoning: true },
  });

  return { output_id: id, report };
}
