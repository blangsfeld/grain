/**
 * POST /api/digest/daily
 *
 * Generate daily highlight files for the vault.
 * Batch mode: { since: "2026-01-01", until: "2026-04-08" }
 * No Claude call — just reads atoms and writes markdown.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { exportDailyHighlightsToVault } from "@/lib/vault-export";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const since = body.since as string;
    const until = body.until as string;

    if (!since || !until) {
      return NextResponse.json({ error: "Provide since and until dates" }, { status: 400 });
    }

    // Get all unique dates with atoms — use index-only scan via distinct workaround
    const db = getSupabaseAdmin();

    // Paginate to get all source_dates (Supabase default limit is 1000)
    const allDates = new Set<string>();
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data: rows, error: qErr } = await db
        .from("dx_atoms")
        .select("source_date")
        .gte("source_date", since)
        .lte("source_date", until)
        .eq("archived", false)
        .not("source_date", "is", null)
        .order("source_date")
        .range(offset, offset + pageSize - 1);

      if (qErr) throw new Error(qErr.message);
      if (!rows || rows.length === 0) break;

      for (const r of rows) {
        allDates.add((r as { source_date: string }).source_date);
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    const dates = [...allDates].sort();

    const results: Array<{ date: string; path: string | null }> = [];
    for (const date of dates) {
      const path = await exportDailyHighlightsToVault(date);
      results.push({ date, path });
    }

    return NextResponse.json({
      success: true,
      days: results.length,
      files_written: results.filter((r) => r.path).length,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
