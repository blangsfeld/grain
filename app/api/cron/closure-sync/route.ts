/**
 * GET /api/cron/closure-sync — mirror Notion kept-list Status back to
 * dx_commitments.status so the heard side knows when things are done.
 *
 * Cron cadence: daily at 12:45 UTC (see vercel.json). The local orchestrator
 * also runs this phase twice a day, so intra-day closures still propagate
 * even though Vercel only touches it once.
 */

import { NextRequest, NextResponse } from "next/server";
import { runClosureSync } from "@/lib/closure-sync";
import { beat } from "@/lib/heartbeat";

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
    const result = await runClosureSync();
    const parts = Object.entries(result.byStatus)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`);
    const summary =
      result.updated === 0
        ? `checked=${result.checked} no drift`
        : `checked=${result.checked} updated=${result.updated} (${parts.join(" ")})`;
    await beat({
      source: "cron.closure-sync",
      status: "ok",
      summary,
      cadenceHours: 24,
      metadata: result as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await beat({
      source: "cron.closure-sync",
      status: "failure",
      summary: msg.slice(0, 180),
      cadenceHours: 24,
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
