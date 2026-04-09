/**
 * POST /api/ingest/url — Ingest a URL into the Grain pipeline.
 * Fetches content, classifies, extracts atoms, resolves entities.
 */

import { NextRequest, NextResponse } from "next/server";
import { ingestFromUrl } from "@/lib/url-ingest";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { url } = body;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    const result = await ingestFromUrl(url);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
