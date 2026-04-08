/**
 * POST /api/ingest/granola
 *
 * Auto-ingest from Granola. Polls for new meetings, classifies,
 * extracts atoms, resolves entities, stores.
 *
 * Body: { since?: string, backfill?: boolean }
 * - since: ISO date to start from (overrides sync state)
 * - backfill: skip vault export, just extract
 */

import { NextRequest, NextResponse } from "next/server";
import { ingestFromGranola } from "@/lib/granola-ingest";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const since = body.since as string | undefined;
    const backfill = body.backfill as boolean | undefined;
    const force = body.force as boolean | undefined;

    const result = await ingestFromGranola({ since, backfill, force });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Granola ingest error:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
