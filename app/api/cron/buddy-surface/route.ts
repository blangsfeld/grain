/**
 * GET /api/cron/buddy-surface — weekly kept/heard loop.
 *
 * Runs Monday morning. Close surface first (clean up stale kept items),
 * then promote surface (new candidates from heard list). Two separate
 * Telegram messages to Ben's DM so the replies can target either menu.
 */

import { NextRequest, NextResponse } from "next/server";
import { runBuddyCloseSurface } from "@/lib/agents/buddy-close";
import { runBuddyPromoteSurface } from "@/lib/agents/buddy-promote";
import { sendTelegramReply } from "@/lib/agents/telegram-desk";

export const maxDuration = 120;

// NB: for Telegram 1:1 DMs, user_id == chat_id, so reusing the allow-listed
// user ID as the chat target is correct for the current single-user setup.
// If Buddy ever surfaces to a group, add a dedicated TELEGRAM_BEN_CHAT_ID.
function getChatId(): number {
  const raw = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!raw) throw new Error("TELEGRAM_ALLOWED_USER_ID missing");
  const id = parseInt(raw, 10);
  if (isNaN(id)) throw new Error("TELEGRAM_ALLOWED_USER_ID not numeric");
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

  const chatId = getChatId();
  const report: {
    close: { sent: boolean; count: number; error?: string };
    promote: { sent: boolean; count: number; error?: string };
  } = {
    close: { sent: false, count: 0 },
    promote: { sent: false, count: 0 },
  };

  // Close first — Ben cleans up before seeing new candidates.
  try {
    const close = await runBuddyCloseSurface(chatId);
    if (close.items.length > 0) {
      await sendTelegramReply(chatId, close.message);
      report.close = { sent: true, count: close.items.length };
    } else {
      report.close = { sent: false, count: 0 };
    }
  } catch (err) {
    report.close = {
      sent: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Promote second — surface new items.
  try {
    const promote = await runBuddyPromoteSurface(chatId);
    if (promote.items.length > 0) {
      await sendTelegramReply(chatId, promote.message);
      report.promote = { sent: true, count: promote.items.length };
    } else {
      report.promote = { sent: false, count: 0 };
    }
  } catch (err) {
    report.promote = {
      sent: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const ok = !report.close.error && !report.promote.error;
  return NextResponse.json(
    { ok, ...report },
    { status: ok ? 200 : 500 },
  );
}
