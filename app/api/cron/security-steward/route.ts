/**
 * GET /api/cron/security-steward — Dood's daily security sweep (agent version).
 */

import { NextRequest, NextResponse } from "next/server";
import { runAndWriteSecuritySteward } from "@/lib/agents/security-steward";

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
    const { output_id, report } = await runAndWriteSecuritySteward();
    return NextResponse.json({
      ok: true,
      output_id,
      severity: report.severity,
      totals: report.totals,
      siblings: report.had_siblings,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
