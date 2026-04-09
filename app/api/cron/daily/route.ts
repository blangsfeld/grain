/**
 * GET /api/cron/daily — Vercel cron trigger
 * Weekday mornings: generate daily briefing + vault highlights.
 */

import { NextRequest, NextResponse } from "next/server";
import { exportDailyHighlightsToVault } from "@/lib/vault-export";

export const maxDuration = 180;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    // Generate vault daily highlights for yesterday (yesterday's meetings are now fully ingested)
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const vaultPath = await exportDailyHighlightsToVault(yesterday).catch(() => null);

    // TODO: Daily briefing (calendar + email + atoms) — carry forward from Source v2 when ready

    return NextResponse.json({
      success: true,
      date: today,
      vault_highlights: vaultPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
