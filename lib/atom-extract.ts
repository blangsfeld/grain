/**
 * Multi-pass extraction engine.
 * Runs focused extractors in parallel, collects typed atoms.
 */

import { getAnthropicClient } from "@/lib/anthropic";
import { buildReadPrompt, READ_MAX_TOKENS } from "@/lib/prompts/read";
import { buildQuotesPrompt, QUOTES_MAX_TOKENS } from "@/lib/prompts/quotes";
import { buildBeliefsPrompt, BELIEFS_MAX_TOKENS } from "@/lib/prompts/beliefs";
import { buildTensionsPrompt, TENSIONS_MAX_TOKENS } from "@/lib/prompts/tensions";
import { buildVoicePrompt, VOICE_MAX_TOKENS } from "@/lib/prompts/voice";
import { buildCommitmentsPrompt, COMMITMENTS_MAX_TOKENS } from "@/lib/prompts/commitments";
import { buildDecisionsPrompt, DECISIONS_MAX_TOKENS } from "@/lib/prompts/decisions";
import { buildRelationshipsPrompt, RELATIONSHIPS_MAX_TOKENS } from "@/lib/prompts/relationships";
import { buildSynthesisPrompt, SYNTHESIS_MAX_TOKENS } from "@/lib/prompts/synthesis";
import type {
  AtomPass,
  AtomType,
  DxAtomInsert,
  RelationshipsPayload,
  ReadContent,
  SynthesisContent,
} from "@/types/atoms";

const MODEL = "claude-sonnet-4-20250514";

// ─── Per-pass execution ──────────────────────────

interface PassConfig {
  buildPrompt: (transcript: string, title: string) => string;
  maxTokens: number;
  atomType: AtomType;
  temperature: number;
}

const PASS_CONFIG: Record<AtomPass, PassConfig> = {
  read: {
    buildPrompt: buildReadPrompt,
    maxTokens: READ_MAX_TOKENS,
    atomType: "read",
    temperature: 0.2,
  },
  quotes: {
    buildPrompt: buildQuotesPrompt,
    maxTokens: QUOTES_MAX_TOKENS,
    atomType: "quote",
    temperature: 0.2,
  },
  beliefs: {
    buildPrompt: buildBeliefsPrompt,
    maxTokens: BELIEFS_MAX_TOKENS,
    atomType: "belief",
    temperature: 0.3,
  },
  tensions: {
    buildPrompt: buildTensionsPrompt,
    maxTokens: TENSIONS_MAX_TOKENS,
    atomType: "tension",
    temperature: 0.3,
  },
  voice: {
    buildPrompt: buildVoicePrompt,
    maxTokens: VOICE_MAX_TOKENS,
    atomType: "voice",
    temperature: 0.3,
  },
  commitments: {
    buildPrompt: buildCommitmentsPrompt,
    maxTokens: COMMITMENTS_MAX_TOKENS,
    atomType: "commitment",
    temperature: 0.1,
  },
  decisions: {
    buildPrompt: buildDecisionsPrompt,
    maxTokens: DECISIONS_MAX_TOKENS,
    atomType: "decision",
    temperature: 0.2,
  },
  relationships: {
    buildPrompt: buildRelationshipsPrompt,
    maxTokens: RELATIONSHIPS_MAX_TOKENS,
    atomType: "relationships",
    temperature: 0.2,
  },
  synthesis: {
    buildPrompt: buildSynthesisPrompt,
    maxTokens: SYNTHESIS_MAX_TOKENS,
    atomType: "synthesis",
    temperature: 0.3,
  },
};

/** Run a single extraction pass. Returns atoms of one type. */
async function runPass(
  pass: AtomPass,
  transcript: string,
  title: string,
): Promise<{ atoms: DxAtomInsert[]; tokens: number }> {
  const config = PASS_CONFIG[pass];
  const client = getAnthropicClient();

  const prompt = config.buildPrompt(transcript, title);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const tokens = response.usage.input_tokens + response.usage.output_tokens;

  // Parse JSON response
  const parsed = parseJsonResponse(text, config.atomType);

  // Convert to atom inserts
  const atoms: DxAtomInsert[] = [];

  if (config.atomType === "read") {
    // Read produces a single atom with all sections
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      atoms.push({ type: "read", content: parsed as ReadContent });
    }
  } else if (config.atomType === "synthesis") {
    // Synthesis produces a single atom with the trajectory shape
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      atoms.push({ type: "synthesis", content: parsed as SynthesisContent });
    }
  } else if (config.atomType === "relationships") {
    // Relationships is a meta atom — single object payload, filtered
    // out before insertAtoms and persisted to dx_transcripts.meta_relationships.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      atoms.push({
        type: "relationships",
        meta: true,
        content: parsed as RelationshipsPayload,
      });
    }
  } else {
    // Other passes produce arrays of items
    const items = Array.isArray(parsed) ? parsed : [];
    for (const item of items) {
      atoms.push({ type: config.atomType, content: item });
    }
  }

  return { atoms, tokens };
}

/** Parse JSON from Claude response. Handles both objects and arrays. */
function parseJsonResponse(text: string, atomType: AtomType): unknown {
  const isObjectShape =
    atomType === "read" || atomType === "relationships" || atomType === "synthesis";
  try {
    // Try to find JSON in the response
    if (isObjectShape) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } else {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    }
  } catch {
    // Fall through
  }

  // Try parsing the whole response
  try {
    return JSON.parse(text);
  } catch {
    return isObjectShape ? null : [];
  }
}

// ─── Main orchestrator ───────────────────────────

export interface ExtractionResult {
  atoms: DxAtomInsert[];
  tokens: number;
  pass_results: Record<string, number>; // atom count per pass
}

/**
 * Run multiple extraction passes on a transcript in parallel.
 * Returns all atoms collected across passes.
 */
export async function extractAtoms(
  transcript: string,
  title: string,
  passes: AtomPass[],
): Promise<ExtractionResult> {
  const results = await Promise.all(
    passes.map((pass) => runPass(pass, transcript, title).then((r) => ({ pass, ...r })))
  );

  const allAtoms: DxAtomInsert[] = [];
  let totalTokens = 0;
  const passResults: Record<string, number> = {};

  for (const result of results) {
    allAtoms.push(...result.atoms);
    totalTokens += result.tokens;
    passResults[result.pass] = result.atoms.length;
  }

  return { atoms: allAtoms, tokens: totalTokens, pass_results: passResults };
}
