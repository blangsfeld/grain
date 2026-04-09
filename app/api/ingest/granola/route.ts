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
    const result = await ingestFromGranola();
    return NextResponse.json({ success: true, ...result });
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
