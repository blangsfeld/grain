/**
 * Notion → Supabase closure sync.
 *
 * Pulls the kept list (Notion Personal Commitments) and mirrors terminal
 * Status changes back to `dx_commitments.status` so Buddy's "what's still
 * open" count tracks reality. Without this, every commitment is forever
 * "open" on the heard side and stale sweeps fire on items Ben already
 * closed in Notion.
 *
 * Status mapping:
 *   Done          → done
 *   Recurring     → recurring   (exempt from stale sweeps — Ben's explicit park)
 *   Dormant       → dismissed
 *   Not a thing   → dismissed
 *   Evolved       → dismissed   (Evolved To relation carries the successor)
 *   Open/InProg/Waiting → open  (idempotent — re-opens if Ben flipped back)
 *
 * Idempotent: runs the full kept list each call, only writes when status
 * differs. Safe to call from Vercel cron + local orchestrator.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { queryDatabase, getSelect } from "@/lib/notion";
import type { NotionPage } from "@/lib/notion";

type DxStatus = "open" | "done" | "dismissed" | "recurring";

const STATUS_MAP: Record<string, DxStatus> = {
  Open: "open",
  "In Progress": "open",
  Waiting: "open",
  Done: "done",
  Recurring: "recurring",
  Dormant: "dismissed",
  "Not a thing": "dismissed",
  Evolved: "dismissed",
};

function personalDbId(): string {
  const id = process.env.NOTION_PERSONAL_COMMITMENTS_DB_ID;
  if (!id) throw new Error("NOTION_PERSONAL_COMMITMENTS_DB_ID missing");
  return id;
}

export interface ClosureSyncResult {
  checked: number;
  updated: number;
  byStatus: Record<DxStatus, number>;
  unmatched: number;
}

export async function runClosureSync(): Promise<ClosureSyncResult> {
  const sb = getSupabaseAdmin();
  const pages = (await queryDatabase(personalDbId(), {})) as NotionPage[];

  const byNotionId = new Map<string, { notionStatus: string | null; dxStatus: DxStatus }>();
  for (const p of pages) {
    const notionStatus = getSelect(p, "Status");
    const dxStatus = notionStatus
      ? STATUS_MAP[notionStatus] ?? "open"
      : "open";
    byNotionId.set(p.id, { notionStatus, dxStatus });
  }

  // Pull every dx_commitments row that points at a Notion page — compare and
  // update only where the mirror has drifted.
  const { data: rows, error } = await sb
    .from("dx_commitments")
    .select("id, status, promoted_to_notion_id")
    .not("promoted_to_notion_id", "is", null)
    .limit(5000);
  if (error) throw new Error(`dx_commitments fetch: ${error.message}`);

  const result: ClosureSyncResult = {
    checked: rows?.length ?? 0,
    updated: 0,
    byStatus: { open: 0, done: 0, dismissed: 0, recurring: 0 },
    unmatched: 0,
  };

  for (const row of rows ?? []) {
    const notionId = row.promoted_to_notion_id as string;
    const match = byNotionId.get(notionId);
    if (!match) {
      result.unmatched++;
      continue;
    }
    if (row.status === match.dxStatus) continue;

    const { error: upErr } = await sb
      .from("dx_commitments")
      .update({ status: match.dxStatus })
      .eq("id", row.id);
    if (upErr) {
      console.warn(`closure-sync: update ${row.id} failed: ${upErr.message}`);
      continue;
    }
    result.updated++;
    result.byStatus[match.dxStatus]++;
  }

  return result;
}
