/**
 * POST /api/telegram/webhook — Keys's front door.
 *
 * Telegram sends Updates here. Keys classifies, stores, replies.
 *
 * Security:
 *   - Verify Telegram secret token (X-Telegram-Bot-Api-Secret-Token header)
 *   - Only Ben's user ID is authorized (TELEGRAM_ALLOWED_USER_ID)
 *
 * Returns 200 quickly regardless; Telegram retries on non-2xx.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate, type TelegramUpdate } from "@/lib/agents/telegram-desk";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // Telegram secret token check (set when registering the webhook)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  // Acknowledge fast; errors here shouldn't cause Telegram to retry indefinitely
  try {
    const result = await handleTelegramUpdate(update);
    return NextResponse.json(result);
  } catch (err) {
    console.error("telegram webhook error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    // Still return 200 so Telegram doesn't retry a failing message loop
    return NextResponse.json({ ok: false, error: msg });
  }
}

// Simple GET for manual health check (not part of Telegram flow)
export async function GET() {
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasSecret = !!process.env.TELEGRAM_WEBHOOK_SECRET;
  const hasUser = !!process.env.TELEGRAM_ALLOWED_USER_ID;
  return NextResponse.json({
    service: "Keys (Telegram desk)",
    env: {
      TELEGRAM_BOT_TOKEN: hasToken,
      TELEGRAM_WEBHOOK_SECRET: hasSecret,
      TELEGRAM_ALLOWED_USER_ID: hasUser,
    },
    ready: hasToken && hasUser,
  });
}
