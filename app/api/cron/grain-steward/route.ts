/**
 * GET /api/cron/grain-steward — Guy's hourly health check.
 *
 * Runs the Grain Guardian pipeline, writes output to agent_outputs table.
 * /boot materializes the latest row into 70-agents/grain-steward.md in the vault.
 *
 * Vercel cron: hourly, `0 * * * *` (see vercel.json).
 *
 * Auth: shared CRON_SECRET bearer, consistent with other grain cron routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { runAndWriteGrainSteward } from "@/lib/agents/grain-steward";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const { output_id, report } = await runAndWriteGrainSteward();
    return NextResponse.json({
      ok: true,
      output_id,
      severity: report.overall,
      siblings: report.had_siblings,
      briefing_hours_ago: report.facts.briefing.hours_ago,
      open_commitments: report.facts.commitments.open,
      transcripts_24h: report.facts.extraction.transcripts_24h,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
