/**
 * GET /api/cron/daily — Vercel cron trigger
 * Weekday mornings: generate daily briefing + vault highlights.
 * Monday: exec prep mode. Tue-Fri: daily mode.
 */

import { NextRequest, NextResponse } from "next/server";
import { exportDailyHighlightsToVault } from "@/lib/vault-export";
import { assembleBriefingContext } from "@/lib/briefing-context";
import { buildBriefingPrompt } from "@/lib/briefing-prompts";
import { deliverBriefingEmail, archiveBriefingToVault } from "@/lib/briefing-deliver";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseAdmin } from "@/lib/supabase";
import { beat } from "@/lib/heartbeat";

export const maxDuration = 300;

const MODEL = "claude-sonnet-4-20250514";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    // 1. Generate vault daily highlights for yesterday
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const vaultPath = await exportDailyHighlightsToVault(yesterday).catch(() => null);

    // 2. Generate and deliver briefing
    let briefingResult = null;
    try {
      const ctx = await assembleBriefingContext();
      const { system, user } = buildBriefingPrompt(ctx);

      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: ctx.mode === "monday" ? 3000 : 2000,
        temperature: 0.4,
        system,
        messages: [{ role: "user", content: user }],
      });

      const content = response.content[0]?.type === "text" ? response.content[0].text : "";
      const tokens = response.usage.input_tokens + response.usage.output_tokens;

      // Store
      const db = getSupabaseAdmin();
      await db.from("dx_briefings").insert({
        type: ctx.mode === "monday" ? "monday_exec" : "daily",
        status: "complete",
        title: `${ctx.mode === "monday" ? "Monday Exec Prep" : "Daily Brief"} — ${ctx.date}`,
        content,
        token_count: tokens,
        time_range_start: `${ctx.date}T00:00:00.000Z`,
        time_range_end: `${ctx.date}T23:59:59.999Z`,
        metadata: {
          mode: ctx.mode,
          event_count: ctx.events.length,
          email_thread_count: ctx.emailThreads.length,
        },
      });

      // Email
      let emailResult: { id: string } | { error: string } | null = null;
      try {
        emailResult = await deliverBriefingEmail({ content, date: ctx.date, mode: ctx.mode });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Email delivery failed:", msg);
        emailResult = { error: msg };
      }

      // Vault archive (non-fatal on Vercel — no filesystem)
      archiveBriefingToVault({ content, date: ctx.date, mode: ctx.mode, tokens, eventCount: ctx.events.length });

      briefingResult = { mode: ctx.mode, tokens, events: ctx.events.length, email: emailResult };
    } catch (briefingErr) {
      console.error("Briefing generation failed:", briefingErr instanceof Error ? briefingErr.message : briefingErr);
      briefingResult = { error: briefingErr instanceof Error ? briefingErr.message : "Unknown" };
    }

    // Pulse — mode-aware cadence (monday_exec is weekly, daily is Tue-Fri).
    const isMonday = new Date().getDay() === 1;
    const br = briefingResult as unknown as { error?: string; mode?: string; events?: number } | null;
    const briefingErrored = !!br && "error" in br && !!br.error;
    await beat({
      source: isMonday ? "cron.monday-exec-briefing" : "cron.daily-briefing",
      status: briefingErrored ? "failure" : "ok",
      summary: briefingErrored
        ? String(br!.error).slice(0, 200)
        : `mode=${br?.mode ?? "?"} events=${br?.events ?? 0}`,
      cadenceHours: isMonday ? 175 : 30,
      metadata: br as unknown as Record<string, unknown>,
    });

    return NextResponse.json({
      success: true,
      date: today,
      vault_highlights: vaultPath,
      briefing: briefingResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await beat({
      source: "cron.daily-briefing",
      status: "failure",
      summary: message.slice(0, 200),
      cadenceHours: 30,
    });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
