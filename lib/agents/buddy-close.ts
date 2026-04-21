/**
 * Buddy — close loop.
 *
 * Surfaces stale items from Ben's Notion Personal Commitments DB (kept list)
 * so they either close, recur, or get explicitly kept. "Stale" = Status in
 * {Open, In Progress}, not edited in 14+ days, and not on a live deadline.
 * Recurring items are exempt.
 *
 * Reply grammar: `done 1,4 recur 2 keep 3 archive 5,6`
 *  - done / archive  → Status = Done (disappears from Active / By Category,
 *    still queryable via the Archive view)
 *  - recur           → Status = Recurring (exempt from future close sweeps)
 *  - keep            → touch last_edited so it drops off the stale window
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  queryDatabase,
  updatePage,
  getPage,
  getTitle,
  getSelect,
  getDate,
  getRichText,
  selectProp,
  richTextProp,
} from "@/lib/notion";
import type { NotionPage } from "@/lib/notion";
import type { PersonalCommitmentStatus } from "@/types/atoms";

// Status values that should NOT surface in the stale sweep. Recurring items
// are exempt by design; Evolved / Dormant / Not a thing are Ben's explicit
// "park it, don't nag me" outcomes — carrying them back into close menus
// would undo the signal the semantic reply flow just recorded.
const STALE_SWEEP_EXEMPT: PersonalCommitmentStatus[] = [
  "Recurring",
  "Evolved",
  "Dormant",
  "Not a thing",
];

const STALENESS_DAYS = 14;
const MENU_SIZE = 12;

function personalDbId(): string {
  const id = process.env.NOTION_PERSONAL_COMMITMENTS_DB_ID;
  if (!id) throw new Error("NOTION_PERSONAL_COMMITMENTS_DB_ID missing");
  return id;
}

// ── Types ──────────────────────────────────────────

export interface CloseMenuItem {
  index: number;
  page_id: string;
  statement: string;
  category: string | null;
  status: string | null;
  due_date: string | null;
  last_edited: string;
  days_since_edit: number;
  overdue_days: number | null;
}

export interface CloseSurfaceResult {
  menu_id: string;
  items: CloseMenuItem[];
  message: string;
}

// ── Gathering ──────────────────────────────────────

export async function gatherStaleItems(): Promise<CloseMenuItem[]> {
  const cutoff = new Date(Date.now() - STALENESS_DAYS * 86_400_000).toISOString();

  // Pull non-Done items; exempt statuses (Recurring + soft-close states) are
  // filtered in code after the fetch so a filter referencing an unknown
  // option name can't reject the whole query.
  const pages = await queryDatabase(personalDbId(), {
    filter: { property: "Status", select: { does_not_equal: "Done" } },
    sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
  });

  const today = Date.now();
  const items: CloseMenuItem[] = [];

  for (const p of pages as NotionPage[]) {
    const status = getSelect(p, "Status");
    if (status && STALE_SWEEP_EXEMPT.includes(status as PersonalCommitmentStatus)) continue;

    const lastEdited = p.last_edited_time;
    if (!lastEdited || lastEdited > cutoff) continue;

    const dueDate = getDate(p, "Due Date");
    // Skip items with a future deadline — they're on the clock, not stale.
    if (dueDate) {
      const dueTime = new Date(dueDate).getTime();
      if (!isNaN(dueTime) && dueTime > today) continue;
    }

    const daysSinceEdit = Math.floor(
      (today - new Date(lastEdited).getTime()) / 86_400_000,
    );
    const overdueDays = dueDate
      ? Math.floor((today - new Date(dueDate).getTime()) / 86_400_000)
      : null;

    items.push({
      index: items.length + 1,
      page_id: p.id,
      statement: getTitle(p, "Name") || "(untitled)",
      category: getSelect(p, "Category"),
      status: getSelect(p, "Status"),
      due_date: dueDate,
      last_edited: lastEdited,
      days_since_edit: daysSinceEdit,
      overdue_days: overdueDays,
    });

    if (items.length >= MENU_SIZE) break;
  }

  return items;
}

// ── Formatting ─────────────────────────────────────

function formatCloseMessage(items: CloseMenuItem[]): string {
  if (items.length === 0) {
    return "Kept list is clean — nothing stale past 14 days.";
  }

  const lines: string[] = [];
  lines.push(`*${items.length} stale on your list* (14d+, no motion).`);
  lines.push("Reply `done 1,4 recur 2 keep 3 archive 5,6`");
  lines.push("");

  for (const item of items) {
    const meta: string[] = [];
    if (item.category) meta.push(item.category);
    meta.push(`${item.days_since_edit}d quiet`);
    if (item.overdue_days !== null && item.overdue_days > 0) {
      meta.push(`${item.overdue_days}d overdue`);
    } else if (!item.due_date) {
      meta.push("no deadline");
    }

    lines.push(`*${item.index}.* ${item.statement}`);
    lines.push(`    _${meta.join(" · ")}_`);
  }

  return lines.join("\n");
}

// ── Menu persistence ───────────────────────────────

async function storePendingMenu(
  chat_id: number,
  items: CloseMenuItem[],
): Promise<string> {
  const supabase = getSupabaseAdmin();

  // Resolve any orphan close menus for this chat before creating a new one.
  await supabase
    .from("buddy_pending_menus")
    .update({ resolved_at: new Date().toISOString() })
    .eq("chat_id", chat_id)
    .eq("kind", "close")
    .is("resolved_at", null);

  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .insert({ chat_id, kind: "close", items })
    .select("id")
    .single();
  if (error) throw new Error(`pending menu insert: ${error.message}`);
  return data.id as string;
}

async function fetchPendingCloseMenu(
  chat_id: number,
): Promise<{ id: string; items: CloseMenuItem[] } | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("buddy_pending_menus")
    .select("id, items")
    .eq("chat_id", chat_id)
    .eq("kind", "close")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`pending menu query: ${error.message}`);
  if (!data) return null;
  return { id: data.id as string, items: data.items as CloseMenuItem[] };
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

export async function runBuddyCloseSurface(
  chat_id: number,
): Promise<CloseSurfaceResult> {
  const items = await gatherStaleItems();
  const message = formatCloseMessage(items);
  const menu_id = items.length > 0 ? await storePendingMenu(chat_id, items) : "";
  return { menu_id, items, message };
}

// ── Reply parsing ──────────────────────────────────

export type CloseAction = "done" | "recur" | "keep" | "archive";

const ACTION_WORDS: Record<string, CloseAction> = {
  done: "done",
  close: "done",
  closed: "done",
  complete: "done",
  completed: "done",
  archive: "archive",
  archived: "archive",
  recur: "recur",
  recurring: "recur",
  keep: "keep",
  live: "keep",
  active: "keep",
};

interface ParsedCloseReply {
  actions: Array<{ action: CloseAction; indices: number[] }>;
}

/**
 * Parses messages like:
 *   "done 1,4 recur 2 keep 3 archive 5,6"
 *   "done 1 2 3 recur 4"
 *   "close 1,2"
 * Returns action groups with 1-indexed selection numbers.
 */
export function parseCloseReply(text: string): ParsedCloseReply | null {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const actions: ParsedCloseReply["actions"] = [];
  let current: { action: CloseAction; indices: number[] } | null = null;

  for (const tok of tokens) {
    const cleaned = tok.replace(/[,;:]+$/, "");
    const verb = ACTION_WORDS[cleaned];
    if (verb) {
      if (current) actions.push(current);
      current = { action: verb, indices: [] };
      continue;
    }

    // Number list — may be "1,4" or "1" or "2,3,4"
    if (current) {
      const nums = cleaned
        .split(/[,;]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n > 0);
      current.indices.push(...nums);
    }
  }
  if (current) actions.push(current);

  // Drop empty groups
  const filtered = actions.filter((a) => a.indices.length > 0);
  return filtered.length > 0 ? { actions: filtered } : null;
}

// ── Action application ─────────────────────────────

async function applyAction(
  page_id: string,
  action: CloseAction,
): Promise<void> {
  switch (action) {
    case "done":
    case "archive":
      await updatePage(page_id, { Status: selectProp("Done") });
      return;
    case "recur":
      await updatePage(page_id, { Status: selectProp("Recurring") });
      return;
    case "keep": {
      // Append a "Kept YYYY-MM-DD" stamp to Notes (preserves existing notes)
      // and bumps Notion's last_edited_time so the item drops off the stale
      // window for another cycle.
      const page = await getPage(page_id);
      const existing = getRichText(page, "Notes");
      const stamp = `Kept ${new Date().toISOString().slice(0, 10)}`;
      const merged = existing ? `${existing}\n${stamp}` : stamp;
      await updatePage(page_id, { Notes: richTextProp(merged) });
      return;
    }
  }
}

export interface CloseResolveResult {
  applied: Array<{ index: number; action: CloseAction; statement: string }>;
  errors: Array<{ index: number; action: CloseAction; reason: string }>;
  skipped: Array<{ index: number; action: CloseAction }>;
  message: string;
}

export async function resolveCloseReply(
  chat_id: number,
  text: string,
): Promise<CloseResolveResult> {
  const parsed = parseCloseReply(text);
  if (!parsed) {
    return {
      applied: [],
      errors: [],
      skipped: [],
      message: "Couldn't parse. Try: `done 1,4 recur 2 keep 3 archive 5,6`",
    };
  }

  const menu = await fetchPendingCloseMenu(chat_id);
  if (!menu) {
    return {
      applied: [],
      errors: [],
      skipped: [],
      message: "No recent close menu to resolve against. Run `buddy cleanup` first.",
    };
  }

  const applied: CloseResolveResult["applied"] = [];
  const errors: CloseResolveResult["errors"] = [];
  const skipped: CloseResolveResult["skipped"] = [];

  for (const group of parsed.actions) {
    for (const idx of group.indices) {
      const item = menu.items.find((x) => x.index === idx);
      if (!item) {
        skipped.push({ index: idx, action: group.action });
        continue;
      }
      try {
        await applyAction(item.page_id, group.action);
        applied.push({
          index: idx,
          action: group.action,
          statement: item.statement,
        });
      } catch (err) {
        errors.push({
          index: idx,
          action: group.action,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await markMenuResolved(menu.id);

  // Summary
  const counts: Record<CloseAction, number> = { done: 0, recur: 0, keep: 0, archive: 0 };
  for (const a of applied) counts[a.action]++;

  const lines: string[] = [];
  const summary: string[] = [];
  if (counts.done + counts.archive > 0) summary.push(`${counts.done + counts.archive} done`);
  if (counts.recur > 0) summary.push(`${counts.recur} recurring`);
  if (counts.keep > 0) summary.push(`${counts.keep} kept`);
  if (summary.length > 0) lines.push(`*Applied:* ${summary.join(" · ")}`);

  if (errors.length > 0) {
    lines.push(`*Failed ${errors.length}:*`);
    for (const e of errors) lines.push(`  ${e.index} (${e.action}): ${e.reason}`);
  }
  if (skipped.length > 0) {
    lines.push(`_Skipped (not in menu): ${skipped.map((s) => s.index).join(", ")}_`);
  }
  if (lines.length === 0) lines.push("Nothing applied.");

  return { applied, errors, skipped, message: lines.join("\n") };
}
