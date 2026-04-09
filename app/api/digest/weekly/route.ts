/**
 * POST /api/digest/weekly
 *
 * Generate weekly digest(s). Two modes:
 * - Single week: { week_start: "2026-04-07", week_end: "2026-04-13" }
 * - Batch range: { since: "2026-01-01", until: "2026-04-08" }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyDigest, generateWeeklyDigestsBatch } from "@/lib/weekly-digest";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    // Batch mode
    if (body.since && body.until) {
      const results = await generateWeeklyDigestsBatch(body.since, body.until);
      const summary = results.map((r) => ({
        vault_path: r.vault_path,
        atoms: r.atom_count,
        meetings: r.meeting_count,
        tokens: r.tokens,
      }));

      return NextResponse.json({
        success: true,
        weeks: summary.length,
        total_atoms: results.reduce((s, r) => s + r.atom_count, 0),
        total_tokens: results.reduce((s, r) => s + r.tokens, 0),
        results: summary,
      });
    }

    // Single week mode
    const weekStart = body.week_start as string;
    const weekEnd = body.week_end as string;
    if (!weekStart || !weekEnd) {
      return NextResponse.json(
        { error: "Provide week_start + week_end, or since + until for batch" },
        { status: 400 },
      );
    }

    const result = await generateWeeklyDigest(weekStart, weekEnd);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Weekly digest error:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
