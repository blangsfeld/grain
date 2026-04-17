/**
 * Buddy — promotion flow.
 *
 * Surfaces meeting commitments (heard list) as promotion candidates to
 * Ben's Notion Personal Commitments DB (kept list). Replies like
 * "promote 2,5" or "promote 3 as: rewrite" resolve against the most
 * recent unresolved menu for that chat.
 *
 * Candidates: Ben-owned commitments OR high-weight commitments where Ben
 * attended the meeting. Unpromoted only. Deduped via a Haiku pass before
 * the menu is shown.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { runBuddyAdd } from "@/lib/agents/ea";
import type { CommitmentCategory } from "@/types/atoms";

const OWNER = "Ben";
const DEDUP_MODEL = "claude-haiku-4-5-20251001";
const MAX_CANDIDATES = 20;
const MENU_SIZE = 10;

// ── Types ──────────────────────────────────────────

interface RawCandidate {
  commitment_id: string;
  statement: string;
  person: string | null;
  category: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  weight: "high" | "medium" | "low" | "skip" | null;
  ben_attended: boolean;
  age_days: number;
}

export interface PromotionMenuItem {
  /** 1-indexed number shown to Ben in Telegram */
  index: number;
  /** Commitment IDs collapsed into this slot (dedup merges multiples) */
  commitment_ids: string[];
  statement: string;
  category_hint: CommitmentCategory | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  age_days: number;
}

export interface PromotionSurfaceResult {
  menu_id: string;
  items: PromotionMenuItem[];
  message: string;
}

// ── Fact gathering ─────────────────────────────────

function participantsIncludeBen(participants: unknown): boolean {
  if (!Array.isArray(participants)) return false;
  const BEN_PATTERNS = [/\bben\b/i, /langsfeld/i];
  for (const p of participants) {
    if (!p || typeof p !== "object") continue;
    const name = (p as { name?: string }).name ?? "";
    const email = (p as { email?: string }).email ?? "";
    if (BEN_PATTERNS.some((rx) => rx.test(name))) return true;
    if (/^ben@|ben\.langsfeld/i.test(email)) return true;
  }
  return false;
}

export async function gatherPromotionCandidates(): Promise<RawCandidate[]> {
  const supabase = getSupabaseAdmin();

  // Fetch open, unpromoted commitments with their classifier labels and the
  // transcript participants (for the "Ben attended" check on others' items).
  const { data, error } = await supabase
    .from("dx_commitments")
    .select(`
      id, statement, person, category, meeting_title, meeting_date, due_date,
      transcript_id,
      commitment_labels(weight),
      dx_transcripts(participants)
    `)
    .eq("status", "open")
    .is("promoted_at", null)
    .order("meeting_date", { ascending: false })
    .limit(200);

  if (error) throw new Error(`promotion candidates query: ${error.message}`);

  type Row = {
    id: string;
    statement: string;
    person: string | null;
    category: string | null;
    meeting_title: string | null;
    meeting_date: string | null;
    due_date: string | null;
    commitment_labels:
      | Array<{ weight: string | null }>
      | { weight: string | null }
      | null;
    dx_transcripts:
      | { participants: unknown }
      | Array<{ participants: unknown }>
      | null;
  };

  const today = Date.now();
  const candidates: RawCandidate[] = [];

  for (const row of (data ?? []) as unknown as Row[]) {
    const label = Array.isArray(row.commitment_labels)
      ? row.commitment_labels[0]
      : row.commitment_labels;
    const weight = (label?.weight ?? null) as RawCandidate["weight"];

    const transcript = Array.isArray(row.dx_transcripts)
      ? row.dx_transcripts[0]
      : row.dx_transcripts;
    const benAttended = participantsIncludeBen(transcript?.participants);

    const isBens = row.person === OWNER;
    const highWeightOthers = weight === "high" && !isBens && benAttended;

    if (!isBens && !highWeightOthers) continue;
    if (weight === "skip") continue;

    const meetDate = row.meeting_date ? new Date(row.meeting_date).getTime() : today;
    const age = Math.floor((today - meetDate) / 86_400_000);

    candidates.push({
      commitment_id: row.id,
      statement: row.statement,
      person: row.person,
      category: row.category,
      meeting_title: row.meeting_title,
      meeting_date: row.meeting_date,
      due_date: row.due_date,
      weight,
      ben_attended: benAttended,
      age_days: age,
    });

    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

// ── Dedup (Haiku batch pass) ───────────────────────

const DEDUP_PROMPT = `You are a dedup pass for Ben Langsfeld's commitment promotion menu.

You will receive a numbered list of meeting commitments. Some may be the same commitment recorded across multiple meetings or phrased slightly differently. Group duplicates together.

Return strict JSON: {"groups": [[0, 3], [1], [2, 4, 5]]}
- Each inner array is one group of indexes (0-based).
- Singletons get their own array.
- Every input index must appear exactly once across all groups.
- Only merge if the commitments are clearly the same intent. When in doubt, keep separate.

Return JSON only. No prose.`;

export async function dedupCandidates(
  candidates: RawCandidate[],
): Promise<RawCandidate[][]> {
  if (candidates.length <= 1) return candidates.map((c) => [c]);

  const numbered = candidates
    .map((c, i) => `${i}. "${c.statement}" — ${c.person ?? "?"} · ${c.meeting_title ?? "?"}`)
    .join("\n");

  try {
    const anthropic = getAnthropicClient(20_000);
    const res = await anthropic.messages.create({
      model: DEDUP_MODEL,
      max_tokens: 500,
      system: DEDUP_PROMPT,
      messages: [{ role: "user", content: numbered }],
    });
    const raw = res.content[0]?.type === "text" ? res.content[0].text : "";
    const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return candidates.map((c) => [c]);
    const parsed = JSON.parse(match[0]) as { groups?: number[][] };
    const groups = parsed.groups ?? [];

    // Validate — every index must appear exactly once.
    const seen = new Set<number>();
    for (const g of groups) for (const i of g) seen.add(i);
    if (seen.size !== candidates.length) {
      return candidates.map((c) => [c]); // fallback: no dedup
    }

    return groups
      .map((g) => g.map((i) => candidates[i]).filter(Boolean))
      .filter((g) => g.length > 0);
  } catch (err) {
    console.warn("dedup pass failed, returning undeduped:", err instanceof Error ? err.message : err);
    return candidates.map((c) => [c]);
  }
}

// ── Category inference (Haiku) ─────────────────────

const COMMITMENT_CATEGORIES: CommitmentCategory[] = [
  "Personal", "Dunbar", "Prospect", "Expenses", "Travel", "Medical",
  "Residence", "BUCK", "Wild", "Giant Ant", "Part+Sum", "VTPro",
  "Its Nice That", "Ok Cool", "CLIP", "Other",
];

function mapCategoryHint(category: string | null): CommitmentCategory | null {
  if (!category) return null;
  const match = COMMITMENT_CATEGORIES.find(
    (c) => c.toLowerCase() === category.toLowerCase(),
  );
  return match ?? null;
}

// ── Menu formatting ────────────────────────────────

function buildMenuItems(groups: RawCandidate[][]): PromotionMenuItem[] {
  return groups.slice(0, MENU_SIZE).map((group, idx) => {
    // Within a dedup group, prefer the most recent commitment as canonical
    // (lowest age_days wins).
    const sorted = [...group].sort((a, b) => a.age_days - b.age_days);
    const canonical = sorted[0];
    return {
      index: idx + 1,
      commitment_ids: group.map((c) => c.commitment_id),
      statement: canonical.statement,
      category_hint: mapCategoryHint(canonical.category),
      meeting_title: canonical.meeting_title,
      meeting_date: canonical.meeting_date,
      due_date: canonical.due_date,
      age_days: canonical.age_days,
    };
  });
}

function formatMenuMessage(items: PromotionMenuItem[]): string {
  if (items.length === 0) {
    return "No new promotion candidates — your kept list is current.";
  }

  const lines: string[] = [];
  lines.push(`*${items.length} to promote?* Reply \`promote 2,5\` or \`promote 2 as: <rewrite>\``);
  lines.push("");

  for (const item of items) {
    const meta: string[] = [];
    if (item.category_hint) meta.push(item.category_hint);
    if (item.meeting_title) meta.push(item.meeting_title);
    if (item.due_date) meta.push(`due ${item.due_date}`);
    meta.push(`${item.age_days}d`);

    lines.push(`*${item.index}.* ${item.statement}`);
    lines.push(`    _${meta.join(" · ")}_`);
  }

  return lines.join("\n");
}

// ── Menu persistence ───────────────────────────────

async function storePendingMenu(
  chat_id: number,
  items: PromotionMenuItem[],
): Promise<string> {
  const supabase = getSupabaseAdmin();

  // Resolve any orphan promote menus for this chat so a new surface
  // doesn't create a second unresolved menu. Latest menu is canonical.
  await supabase
    .from("buddy_pending_menus")
    .update({ resolved_at: new Date().toISOString() })
    .eq("chat_id", chat_id)
    .eq("kind", "promote")
    .is("resolved_at", null);

  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .insert({ chat_id, kind: "promote", items })
    .select("id")
    .single();
  if (error) throw new Error(`pending menu insert: ${error.message}`);
  return data.id as string;
}

async function fetchPendingPromoteMenu(
  chat_id: number,
): Promise<{ id: string; items: PromotionMenuItem[] } | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .select("id, items")
    .eq("chat_id", chat_id)
    .eq("kind", "promote")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`pending menu query: ${error.message}`);
  if (!data) return null;
  return { id: data.id as string, items: data.items as PromotionMenuItem[] };
}

async function markMenuResolved(menu_id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("buddy_pending_menus")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", menu_id);
  if (error) throw new Error(`menu resolve update: ${error.message}`);
}

// ── Surface entrypoint ─────────────────────────────

export async function runBuddyPromoteSurface(
  chat_id: number,
): Promise<PromotionSurfaceResult> {
  const raw = await gatherPromotionCandidates();
  if (raw.length === 0) {
    return {
      menu_id: "",
      items: [],
      message: "No new promotion candidates — your kept list is current.",
    };
  }

  const groups = await dedupCandidates(raw);
  const items = buildMenuItems(groups);
  const message = formatMenuMessage(items);

  const menu_id = items.length > 0 ? await storePendingMenu(chat_id, items) : "";
  return { menu_id, items, message };
}

// ── Reply resolution ───────────────────────────────

interface ParsedReply {
  selections: Array<{ index: number; rewrite: string | null }>;
}

/**
 * Parses: "promote 2,5", "promote 2 as: rewrite", "promote 1,3,4 as: partial",
 * "promote 2 as: foo; 5 as: bar"
 * Returns index/rewrite pairs (1-indexed to match the menu display).
 */
export function parsePromoteReply(text: string): ParsedReply | null {
  const body = text.trim().replace(/^promote\s+/i, "");
  if (!body) return null;

  const selections: Array<{ index: number; rewrite: string | null }> = [];

  // Split on ";" to support "2 as: foo; 5 as: bar"
  const clauses = body.split(/\s*;\s*/).filter(Boolean);

  for (const clause of clauses) {
    // Match "N[,N,N] as: rewrite" or "N[,N,N]"
    const match = clause.match(/^([\d\s,]+?)(?:\s+as:\s*(.+))?$/i);
    if (!match) continue;
    const indexStr = match[1].trim();
    const rewrite = match[2]?.trim() ?? null;

    const indices = indexStr
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n) && n > 0);

    // If rewrite is present, it applies to all indices in this clause
    // (unusual, but let the rewrite ride on the first and use raw for rest).
    for (let i = 0; i < indices.length; i++) {
      selections.push({
        index: indices[i],
        rewrite: i === 0 ? rewrite : null,
      });
    }
  }

  return selections.length > 0 ? { selections } : null;
}

export interface PromoteResolveResult {
  promoted: Array<{
    index: number;
    statement: string;
    notion_url: string;
    category: CommitmentCategory;
  }>;
  errors: Array<{ index: number; reason: string }>;
  skipped: number[]; // indices outside menu range
  message: string;
}

export async function resolvePromotionReply(
  chat_id: number,
  text: string,
): Promise<PromoteResolveResult> {
  const parsed = parsePromoteReply(text);
  if (!parsed) {
    return {
      promoted: [],
      errors: [],
      skipped: [],
      message: "Couldn't parse. Try: `promote 2,5` or `promote 2 as: <rewrite>`",
    };
  }

  const menu = await fetchPendingPromoteMenu(chat_id);
  if (!menu) {
    return {
      promoted: [],
      errors: [],
      skipped: [],
      message: "No recent promote menu to resolve against. Run `buddy promote` first.",
    };
  }

  const supabase = getSupabaseAdmin();
  const promoted: PromoteResolveResult["promoted"] = [];
  const errors: PromoteResolveResult["errors"] = [];
  const skipped: number[] = [];

  for (const sel of parsed.selections) {
    const item = menu.items.find((x) => x.index === sel.index);
    if (!item) {
      skipped.push(sel.index);
      continue;
    }

    const statement = sel.rewrite || item.statement;
    const category = item.category_hint ?? undefined;
    const due_date = item.due_date ?? undefined;

    try {
      const result = await runBuddyAdd({
        statement,
        category,
        due_date,
        source: "Meeting",
      });

      // Stamp all collapsed commitment rows so dupes don't resurface.
      const { error: stampErr } = await supabase
        .from("dx_commitments")
        .update({
          promoted_at: new Date().toISOString(),
          promoted_to_notion_id: result.page_id,
        })
        .in("id", item.commitment_ids);
      if (stampErr) throw new Error(`stamp failed: ${stampErr.message}`);

      promoted.push({
        index: sel.index,
        statement,
        notion_url: result.url,
        category: result.category,
      });
    } catch (err) {
      errors.push({
        index: sel.index,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await markMenuResolved(menu.id);

  const lines: string[] = [];
  if (promoted.length > 0) {
    lines.push(`*Promoted ${promoted.length}:*`);
    for (const p of promoted) {
      lines.push(`  ${p.index}. ${p.statement} _(${p.category})_`);
    }
  }
  if (errors.length > 0) {
    lines.push(`*Failed ${errors.length}:*`);
    for (const e of errors) lines.push(`  ${e.index}: ${e.reason}`);
  }
  if (skipped.length > 0) {
    lines.push(`_Skipped (not in menu): ${skipped.join(", ")}_`);
  }
  if (lines.length === 0) lines.push("Nothing applied.");

  return { promoted, errors, skipped, message: lines.join("\n") };
}
