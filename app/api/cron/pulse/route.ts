/**
 * GET /api/cron/pulse — Vault Pulse delivery.
 *
 * Tue + Fri 16:00 UTC. Surfaces a 5-item curator digest to Telegram:
 * Bruh what-ifs, Clark voice anchors, Milli wiki, Buddy patterns,
 * and a resurfaced atom from 30-90d ago.
 *
 * Hobby plan caps crons at once-per-day-per-expression; `0 16 * * 2,5`
 * runs once each on Tuesday + Friday, so max one execution per day.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPulse } from "@/lib/pulse";
import { sendTelegramReply } from "@/lib/telegram-send";
import { beat } from "@/lib/heartbeat";

export const maxDuration = 60;

function getChatId(): number {
  const raw =
    process.env.TELEGRAM_BEN_CHAT_ID ?? process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!raw) throw new Error("TELEGRAM_BEN_CHAT_ID or TELEGRAM_ALLOWED_USER_ID missing");
  const id = parseInt(raw, 10);
  if (isNaN(id)) throw new Error("chat id not numeric");
  return id;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const chatId = getChatId();
    const result = await runPulse(chatId, sendTelegramReply);
    const summary = result.sent
      ? `${result.items.length} items delivered (${result.items.map((i) => i.source).join(" ")})`
      : `build ok but send failed: ${result.error ?? "unknown"}`;
    await beat({
      source: "cron.pulse",
      status: result.sent ? "ok" : "attention",
      summary,
      cadenceHours: 96, // 4-day slack (Tue→Fri is 3d, Fri→Tue is 4d)
      metadata: {
        item_count: result.items.length,
        sources: result.items.map((i) => i.source),
      },
    });
    return NextResponse.json({
      ok: result.sent,
      items: result.items.length,
      sources: result.items.map((i) => i.source),
      message_preview: result.message.slice(0, 200),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await beat({
      source: "cron.pulse",
      status: "failure",
      summary: msg.slice(0, 180),
      cadenceHours: 96,
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
