/**
 * GET /api/cron/ea — Buddy's daily triage (agent version).
 *
 * Classifies commitments, reads siblings (Guy, Dood), reasons about
 * what's rising, writes to agent_outputs.
 */

import { NextRequest, NextResponse } from "next/server";
import { runAndWriteEa } from "@/lib/agents/ea";

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
    const { output_id, report } = await runAndWriteEa();
    return NextResponse.json({
      ok: true,
      output_id,
      severity: report.severity,
      facts: report.facts,
      siblings: report.had_siblings,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
