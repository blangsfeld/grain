/**
 * GET /api/cron/what-if — Bruh's weekly pitch run.
 *
 * Runs weekly. Reads grain's corpus over last 30 days, asks Claude to pitch
 * three novel moves using existing resources, writes to agent_outputs.
 */

import { NextRequest, NextResponse } from "next/server";
import { runAndWriteWhatIf } from "@/lib/agents/what-if";

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
    const { output_id, report } = await runAndWriteWhatIf();
    return NextResponse.json({
      ok: true,
      output_id,
      pitches: report.pitches.length,
      titles: report.pitches.map((p) => p.title),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
