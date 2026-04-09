/**
 * POST /api/briefings/daily — Generate and deliver daily briefing.
 *
 * Body: { mode?: "monday" | "daily" }
 * Auto-detects Monday if mode not specified.
 *
 * Assembles atom-powered context → generates via Claude Sonnet → emails + vault archives.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseAdmin } from "@/lib/supabase";
import { assembleBriefingContext } from "@/lib/briefing-context";
import { buildBriefingPrompt } from "@/lib/briefing-prompts";
import { deliverBriefingEmail, archiveBriefingToVault } from "@/lib/briefing-deliver";
import type { BriefingMode } from "@/lib/briefing-context";

export const maxDuration = 300;

const MODEL = "claude-sonnet-4-20250514";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const mode = (body.mode as BriefingMode) ?? undefined;

    // 1. Assemble context
    const ctx = await assembleBriefingContext(mode);

    // 2. Build prompt
    const { system, user } = buildBriefingPrompt(ctx);

    // 3. Generate briefing
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

    // 4. Store in database
    const db = getSupabaseAdmin();
    const { data: briefingRecord } = await db
      .from("dx_briefings")
      .insert({
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
          matched_contacts: ctx.events.flatMap((m) => m.matchedContacts.map((c) => c.canonical_name)),
          has_build_intel: !!ctx.buildIntel,
        },
      })
      .select("id")
      .single();

    // 5. Deliver via email (non-fatal)
    try {
      await deliverBriefingEmail({ content, date: ctx.date, mode: ctx.mode });
    } catch (emailErr) {
      console.error("Briefing email delivery failed:", emailErr instanceof Error ? emailErr.message : emailErr);
    }

    // 6. Archive to vault (non-fatal)
    const vaultPath = archiveBriefingToVault({
      content,
      date: ctx.date,
      mode: ctx.mode,
      tokens,
      eventCount: ctx.events.length,
    });

    return NextResponse.json({
      success: true,
      briefing_id: briefingRecord?.id,
      mode: ctx.mode,
      content,
      tokens,
      event_count: ctx.events.length,
      vault_path: vaultPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Briefing generation failed:", message);

    if (message === "GOOGLE_NO_TOKEN") {
      return NextResponse.json({
        error: "Google not connected. Run the OAuth flow first.",
      }, { status: 401 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
