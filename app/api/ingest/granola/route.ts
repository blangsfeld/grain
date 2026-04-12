/**
 * POST /api/ingest/granola — Manual ingest trigger
 * GET  /api/ingest/granola — Vercel cron trigger (daily)
 *
 * Single cron does everything (Vercel Hobby limit = 1 cron):
 * 1. Ingest new meetings from Granola
 * 2. Generate yesterday's vault highlights
 * 3. Generate and email daily briefing (weekdays)
 * 4. On Mondays: weekly digest + company page refresh
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
    // 1. Ingest new meetings
    const result = await ingestFromGranola();

    // 2. Generate yesterday's daily highlights
    const { exportDailyHighlightsToVault } = await import("@/lib/vault-export");
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const vaultPath = await exportDailyHighlightsToVault(yesterday).catch(() => null);

    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isMonday = dayOfWeek === 1;

    // 3. Generate daily briefing (weekdays only)
    let briefingResult = null;
    if (isWeekday) {
      try {
        const { assembleBriefingContext } = await import("@/lib/briefing-context");
        const { buildBriefingPrompt } = await import("@/lib/briefing-prompts");
        const { deliverBriefingEmail, archiveBriefingToVault } = await import("@/lib/briefing-deliver");
        const { getAnthropicClient } = await import("@/lib/anthropic");
        const { getSupabaseAdmin } = await import("@/lib/supabase");

        const ctx = await assembleBriefingContext();
        const { system, user } = buildBriefingPrompt(ctx);

        const client = getAnthropicClient();
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
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

        // Email (non-fatal)
        await deliverBriefingEmail({ content, date: ctx.date, mode: ctx.mode }).catch((e) =>
          console.error("Briefing email failed:", e instanceof Error ? e.message : e)
        );

        // Vault archive (non-fatal)
        archiveBriefingToVault({ content, date: ctx.date, mode: ctx.mode, tokens, eventCount: ctx.events.length });

        briefingResult = { mode: ctx.mode, tokens, events: ctx.events.length };
      } catch (briefingErr) {
        console.error("Briefing failed:", briefingErr instanceof Error ? briefingErr.message : briefingErr);
        briefingResult = { error: briefingErr instanceof Error ? briefingErr.message : "Unknown" };
      }
    }

    // 4. On Mondays: weekly digest + company page refresh
    let weeklyDigest = null;
    let companyPages = null;
    if (isMonday) {
      // Weekly digest for last week
      try {
        const { generateWeeklyDigest } = await import("@/lib/weekly-digest");
        const lastMonday = new Date(today);
        lastMonday.setDate(today.getDate() - 7);
        const lastSunday = new Date(today);
        lastSunday.setDate(today.getDate() - 1);
        weeklyDigest = await generateWeeklyDigest(
          lastMonday.toISOString().split("T")[0],
          lastSunday.toISOString().split("T")[0],
        );
      } catch (e) {
        console.error("Weekly digest failed:", e instanceof Error ? e.message : e);
      }

      // Company page refresh
      try {
        const { refreshCompanyPages } = await import("@/lib/company-pages");
        const pages = await refreshCompanyPages();
        companyPages = pages.map((p) => ({
          name: p.name,
          updated: p.updated,
          atoms: p.atomCount,
        }));
      } catch (e) {
        console.error("Company pages failed:", e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({
      success: true,
      ...result,
      vault_highlights: vaultPath,
      briefing: briefingResult,
      weekly_digest: weeklyDigest ? { atoms: weeklyDigest.intel.atom_count, path: weeklyDigest.vault_path } : null,
      company_pages: companyPages,
    });
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
