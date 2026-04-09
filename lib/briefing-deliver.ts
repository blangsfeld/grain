/**
 * Briefing Delivery — email + vault archive.
 *
 * Email: sent via Gmail API with "Grain" as sender name.
 * Vault: markdown file in Obsidian vault for archival.
 */

import { sendEmail } from "@/lib/google";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { BriefingMode } from "@/lib/briefing-context";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const BRIEFINGS_DIR = join(VAULT_ROOT, "30-decisions/briefings");
const DELIVERY_EMAIL = "ben@residence.co";

// ─── Email Delivery ─────────────────────────────

export async function deliverBriefingEmail(opts: {
  content: string;
  date: string;
  mode: BriefingMode;
}): Promise<void> {
  const subject = opts.mode === "monday"
    ? `Grain - Monday Exec Prep - ${formatDate(opts.date)}`
    : `Grain - Daily Brief - ${formatDate(opts.date)}`;

  await sendEmail({
    to: DELIVERY_EMAIL,
    subject,
    htmlBody: opts.content,
    plainBody: opts.content,
  });
}

// ─── Vault Archive ──────────────────────────────

export function archiveBriefingToVault(opts: {
  content: string;
  date: string;
  mode: BriefingMode;
  tokens: number;
  eventCount: number;
}): string | null {
  if (!existsSync(VAULT_ROOT)) return null;

  if (!existsSync(BRIEFINGS_DIR)) {
    mkdirSync(BRIEFINGS_DIR, { recursive: true });
  }

  const filename = opts.mode === "monday"
    ? `${opts.date}-monday.md`
    : `${opts.date}.md`;

  const filePath = join(BRIEFINGS_DIR, filename);

  const lines: string[] = [
    "---",
    "type: briefing",
    `mode: ${opts.mode}`,
    `date: ${opts.date}`,
    `tokens: ${opts.tokens}`,
    `events: ${opts.eventCount}`,
    "---",
    "",
    opts.content,
  ];

  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ─── HTML Formatting ────────────────────────────

function briefingToHtml(markdown: string, mode: BriefingMode): string {
  // Convert markdown to minimal HTML email
  let html = markdown
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Headers become styled divs
    .replace(/^### (.+)$/gm, '<h3 style="color:#a1a1aa;font-size:13px;font-weight:600;margin:16px 0 4px;text-transform:uppercase;letter-spacing:0.05em;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#a1a1aa;font-size:13px;font-weight:600;margin:24px 0 8px;text-transform:uppercase;letter-spacing:0.05em;">$1</h2>')
    // Newlines to breaks
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  const accentColor = mode === "monday" ? "#a78bfa" : "#6ee7b7"; // violet for Monday, emerald for daily

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="border-left:2px solid ${accentColor};padding-left:16px;margin-bottom:24px;">
      <span style="color:${accentColor};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;">
        ${mode === "monday" ? "Monday Exec Prep" : "Daily Brief"}
      </span>
    </div>
    <div style="color:#e4e4e7;font-size:14px;line-height:1.7;">
      <p>${html}</p>
    </div>
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #27272a;color:#52525b;font-size:11px;">
      Grain — granular synthesis for conversations
    </div>
  </div>
</body>
</html>`.trim();
}

// ─── Helpers ────────────────────────────────────

function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
