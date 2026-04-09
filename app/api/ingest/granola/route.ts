/**
 * POST /api/ingest/granola — Manual ingest trigger
 * GET  /api/ingest/granola — Vercel cron trigger (hourly)
 *
 * Body (POST only): { since?, backfill?, force? }
 */

import { NextRequest, NextResponse } from "next/server";
import { ingestFromGranola } from "@/lib/granola-ingest";

export const maxDuration = 300;

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // No secret = dev mode, allow
  return authHeader === `Bearer ${cronSecret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. Ingest new meetings
    const result = await ingestFromGranola();

    // 2. Generate yesterday's daily highlights
    const { exportDailyHighlightsToVault } = await import("@/lib/vault-export");
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const vaultPath = await exportDailyHighlightsToVault(yesterday).catch(() => null);

    // 3. On Mondays, generate last week's digest
    let weeklyDigest = null;
    const today = new Date();
    if (today.getDay() === 1) {
      const { generateWeeklyDigest } = await import("@/lib/weekly-digest");
      const lastMonday = new Date(today);
      lastMonday.setDate(today.getDate() - 7);
      const lastSunday = new Date(today);
      lastSunday.setDate(today.getDate() - 1);
      weeklyDigest = await generateWeeklyDigest(
        lastMonday.toISOString().split("T")[0],
        lastSunday.toISOString().split("T")[0],
      ).catch(() => null);
    }

    return NextResponse.json({
      success: true,
      ...result,
      vault_highlights: vaultPath,
      weekly_digest: weeklyDigest ? { atoms: weeklyDigest.atom_count, path: weeklyDigest.vault_path } : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const since = body.since as string | undefined;
    const backfill = body.backfill as boolean | undefined;
    const force = body.force as boolean | undefined;

    const result = await ingestFromGranola({ since, backfill, force });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
