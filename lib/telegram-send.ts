/**
 * Outbound-only Telegram sender.
 *
 * grain no longer receives Telegram updates — that surface moved to cos
 * (~/Documents/Apps/cos). What remains here is the send half: cron jobs and
 * orchestrator phases that still push messages to Ben's chat.
 *
 * Whether those outbound paths SHOULD keep pushing to Telegram is a separate
 * decision (cos is outbound-only, briefings on Telegram are wrong surface).
 * For now we keep the function so the existing crons don't break.
 */

const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramReply(
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
