/**
 * GET /api/cron/columnist — Clark's weekly voice report + leaderboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { runAndWriteColumnist } from "@/lib/agents/columnist";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const { output_id, report } = await runAndWriteColumnist();
    return NextResponse.json({
      ok: true,
      output_id,
      leaderboard_entries: report.leaderboard_ids.length,
      pitches: report.pitches_count,
      stats: report.stats,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
