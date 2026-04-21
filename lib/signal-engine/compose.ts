/**
 * Signal Engine — nightly composer
 *
 * Reads the latest signal_nightly_runs row for a given date and writes
 * the nightly read to the vault in Town register. No status tags, no
 * counts-as-lede, no dashboard chrome.
 *
 * Runs on the Mac only (vault is iCloud-symlinked). Vercel invokes the
 * Tier 1 pipeline and writes to DB; the Mac composer reads the DB row
 * and writes to disk.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import type { NightlyTier1Result } from "@/lib/signal-engine/nightly";

const COMPOSE_MODEL = "claude-sonnet-4-20250514";
const COMPOSE_MAX_TOKENS = 1200;

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const NIGHTLY_DIR = join(VAULT_ROOT, "70-agents");

export interface ComposeResult {
  run_id: string;
  run_date: string;
  narrative: string;
  vault_path: string | null;
  tokens: number;
}

export async function composeNightly(runDateISO: string): Promise<ComposeResult> {
  const db = getSupabaseAdmin();

  const { data: run, error: runErr } = await db
    .from("signal_nightly_runs")
    .select("*")
    .eq("run_date", runDateISO)
    .eq("status", "succeeded")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runErr) throw new Error(`composer fetch failed: ${runErr.message}`);
  if (!run) throw new Error(`no succeeded run for ${runDateISO}`);

  const tier1: NightlyTier1Result = {
    run_id: run.id,
    run_date: run.run_date,
    retirements: run.retirements ?? [],
    dormancies: run.dormancies ?? [],
    crystallizations: run.crystallizations ?? [],
    merges_auto: run.merges_auto ?? [],
    merges_proposed: run.merges_proposed ?? [],
    cadence_updated: 0,
    tokens_used: run.tokens_used ?? 0,
    errors: run.errors ?? [],
  };

  // If nothing changed, write a one-line quiet-night note and bail
  const hasSignal =
    tier1.crystallizations.length +
      tier1.retirements.length +
      tier1.dormancies.length +
      tier1.merges_auto.length +
      tier1.merges_proposed.length >
    0;

  if (!hasSignal) {
    const quiet = `Quiet night. No state transitions, no dormancies, no merges. ${runDateISO}.`;
    const vaultPath = writeNightlyToVault(runDateISO, quiet);
    await db
      .from("signal_nightly_runs")
      .update({ composed_narrative: quiet, vault_path: vaultPath })
      .eq("id", run.id);
    return { run_id: run.id, run_date: runDateISO, narrative: quiet, vault_path: vaultPath, tokens: 0 };
  }

  // Narrative composition
  const prompt = buildComposerPrompt(tier1);
  const client = getAnthropicClient();
  // Dedupe: if an entity is in retirements, it was also in dormancies
  // (retirement implies silence). Drop from dormancies to avoid the
  // composer reporting the same entity twice with contradictory framing.
  const retiredIds = new Set((tier1.retirements ?? []).map((r) => r.entity_id));
  tier1.dormancies = (tier1.dormancies ?? []).filter((d) => !retiredIds.has(d.entity_id));

  const response = await client.messages.create({
    model: COMPOSE_MODEL,
    max_tokens: COMPOSE_MAX_TOKENS,
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  });

  const narrative = response.content[0]?.type === "text" ? response.content[0].text : "";
  const tokens = response.usage.input_tokens + response.usage.output_tokens;

  const vaultPath = writeNightlyToVault(runDateISO, narrative);

  await db
    .from("signal_nightly_runs")
    .update({
      composed_narrative: narrative,
      vault_path: vaultPath,
      tokens_used: (run.tokens_used ?? 0) + tokens,
    })
    .eq("id", run.id);

  return { run_id: run.id, run_date: runDateISO, narrative, vault_path: vaultPath, tokens };
}

// ─── Prompt ────────────────────────────────────────

function buildComposerPrompt(t: NightlyTier1Result): string {
  return `You are composing Ben Langsfeld's nightly intelligence read from Grain's signal engine.

VOICE
Town briefing register. Short paragraphs. No hedge language. No corporate chrome. Lead every signal with a scene or a verb, not a category label. Counts are footnotes to scenes, never ledes. No status tags like [CRYSTALLIZED] or [DORMANT]. Prose over bullets. Section headers forbidden unless signal density demands one. Order by loudness, not by category. A quiet night produces a short read — that's correct on a quiet night. Don't manufacture depth.

DO NOT include a title heading, date line, byline, or "Nightly Intelligence Read" header in your output — the file wrapper handles frontmatter and the H1. Start directly with the first signal paragraph.

When a voice-type entity's label is a Ben-compression, quote it verbatim in your prose (e.g. *"motion is a dialect, not decoration"*). Don't paraphrase. For tensions, the label is a slug — describe it, don't quote it.

NO EDITORIAL GLOSS. Do not speculate about what a voice compression "shaped," what a tension "drove," what a framework "helped teams with," or what an entity "appears to be." You have no evidence for those claims. If you don't have a fact, say less. A short sentence that's true beats a flowery sentence that isn't.

HARD RULES — anti-fabrication
You have ONLY the structured data below. You have NO access to underlying atoms, meeting titles, attendees, or verbatim quotes beyond the canonical labels I give you.
- NEVER invent quotes, meeting titles, participant names, or context not present in this payload.
- NEVER fabricate specifics like "last seen in February budget planning" — you have a date, not a meeting.
- If a signal's label is a compression/voice quote, you may use it verbatim in your prose. If it's a tension slug, describe it but do NOT pretend it's a quote.
- If you don't have enough material to write a scene, write the shortest factual sentence possible and move on. Short is better than invented.

SEMANTIC RULES — what each signal type actually means
- CRYSTALLIZATION: an entity that today reached 3+ mentions across 2+ contexts. A thesis *stabilizing*. This is emergence — something earning its way in. Do NOT describe this as "returning" or "roaring back."
- DORMANCY: an entity that was on a stable cadence and just broke it by exceeding 2× its historical median gap. This is *silence*. Describe as "went quiet," "broke cadence," "silent 37 days vs median 6." Do NOT describe this as "surfacing" or "returning" or "crystallizing."
- RETIREMENT: an entity that was crystallized and has now been silent for 6+ weeks. A thesis going dark. Describe as "retired," "went dark," "fell out of the corpus."
- AUTO-MERGE: two entities the LLM judged as the same underlying thing. Already applied. Describe briefly.
- PROPOSED MERGE: two entities the LLM flagged as possibly same. Awaiting your review. One line total for all of them.

SIGNALS FROM TONIGHT'S RUN
Date: ${t.run_date}

Crystallizations (${t.crystallizations.length}):
${t.crystallizations.length === 0 ? "(none)" : t.crystallizations.map((c) => `- [${c.type}] "${c.label}" — ${c.mention_count} mentions across ${c.mention_count} contexts`).join("\n")}

Dormancies (${t.dormancies.length}):
${t.dormancies.length === 0 ? "(none)" : t.dormancies.map((d) => `- [${d.type}] "${d.label}" — silent ${d.last_gap_days}d vs median ${d.median_gap_days}d`).join("\n")}

Retirements (${t.retirements.length}):
${t.retirements.length === 0 ? "(none)" : t.retirements.map((r) => `- [${r.type}] "${r.label}" — last seen ${r.last_seen}, silent 6+ weeks`).join("\n")}

Auto-merges (${t.merges_auto.length}):
${t.merges_auto.length === 0 ? "(none)" : t.merges_auto.map((m) => `- "${m.label}" — confidence ${m.confidence.toFixed(2)}`).join("\n")}

Proposed merges (${t.merges_proposed.length}):
${t.merges_proposed.length === 0 ? "(none)" : t.merges_proposed.map((m) => `- "${m.a_label}" + "${m.b_label}" — ${m.confidence.toFixed(2)}`).join("\n")}

COMPOSE
Write the nightly read. 150–400 words, often less on a quiet night. One paragraph per signal, ordered by loudness. Most interesting goes first. Close with a brief note on auto-merges and a one-line aside on any proposed merges. If a crystallization label is a real compression (voice type), quote it. Otherwise just describe it factually.`;
}

// ─── Vault write ──────────────────────────────────

function writeNightlyToVault(runDateISO: string, narrative: string): string | null {
  try {
    if (!existsSync(VAULT_ROOT)) return null;
    if (!existsSync(NIGHTLY_DIR)) mkdirSync(NIGHTLY_DIR, { recursive: true });

    const filename = `signals-nightly-${runDateISO}.md`;
    const filePath = join(NIGHTLY_DIR, filename);

    const lines = [
      "---",
      "grain_managed: true",
      "type: nightly-signals",
      `run_date: ${runDateISO}`,
      "---",
      "",
      `# Nightly signals — ${runDateISO}`,
      "",
      narrative,
    ];

    writeFileSync(filePath, lines.join("\n"), "utf-8");
    return filePath;
  } catch (err) {
    console.error("nightly vault write failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
