/**
 * GET /api/cron/weekly — Vercel cron trigger
 * Sunday night: generate weekly digest + vault export.
 */

import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyDigest } from "@/lib/weekly-digest";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    // Calculate this week's Monday and Sunday
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekStart = monday.toISOString().split("T")[0];
    const weekEnd = sunday.toISOString().split("T")[0];

    const result = await generateWeeklyDigest(weekStart, weekEnd);

    return NextResponse.json({
      success: true,
      week_start: weekStart,
      week_end: weekEnd,
      atom_count: result.atom_count,
      meeting_count: result.meeting_count,
      vault_path: result.vault_path,
      tokens: result.tokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
