/**
 * Resend email client — replaces Gmail API for sending.
 * Gmail API still used for reading calendar + email context.
 */

import { Resend } from "resend";

let _client: Resend | null = null;

function getResendClient(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  _client = new Resend(key);
  return _client;
}

const FROM = "Grain <onboarding@resend.dev>";

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}): Promise<{ id: string }> {
  const resend = getResendClient();
  if (!opts.html && !opts.text) throw new Error("Email must have html or text body");

  const { data, error } = opts.html
    ? await resend.emails.send({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.text ? { text: opts.text } : {}),
      })
    : await resend.emails.send({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        text: opts.text!,
      });

  if (error) throw new Error(`Resend error: ${error.message}`);
  return { id: data!.id };
}
