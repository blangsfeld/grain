/**
 * POST /api/ingest/granola — Manual ingest trigger
 * GET  /api/ingest/granola — Vercel cron trigger
 *
 * Single responsibility: pull new meetings from Granola, extract atoms,
 * then export yesterday's daily highlights to the vault.
 *
 * Briefings and weekly/company pages are owned by the dedicated crons
 * (/api/cron/daily, /api/cron/weekly) — do NOT duplicate that work here.
 * Having two routes email the briefing on weekdays caused duplicate sends.
 *
 * Body (POST only): { since?, backfill?, force? }
 */

import { NextRequest, NextResponse } from "next/server";
import { ingestFromGranola } from "@/lib/granola-ingest";
import { exportDailyHighlightsToVault } from "@/lib/vault-export";
import { beat } from "@/lib/heartbeat";

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
    const result = await ingestFromGranola();

    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const vaultPath = await exportDailyHighlightsToVault(yesterday).catch((e) => {
      console.error("[ingest/granola] vault highlights failed:", e instanceof Error ? e.message : e);
      return null;
    });

    const summary = `${(result as unknown as { new_meetings?: number }).new_meetings ?? "?"} new meetings`;
    await beat({
      source: "cron.granola-ingest",
      status: "ok",
      summary,
      cadenceHours: 26, // daily with slack
      metadata: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json({
      success: true,
      ...result,
      vault_highlights: vaultPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[ingest/granola] GET failed:", message);
    await beat({
      source: "cron.granola-ingest",
      status: "failure",
      summary: message.slice(0, 200),
      cadenceHours: 26,
    });
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
    console.error("[ingest/granola] POST failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
