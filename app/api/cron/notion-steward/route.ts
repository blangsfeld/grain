/**
 * GET /api/cron/notion-steward — Timi's weekly graph sweep.
 *
 * Reads People Intelligence + LinkedIn Prospects from Notion, triages with
 * Guy + Buddy as siblings, writes to agent_outputs.
 */

import { NextRequest, NextResponse } from "next/server";
import { runAndWriteTimi } from "@/lib/agents/notion-steward";

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
    const { output_id, report } = await runAndWriteTimi();
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
