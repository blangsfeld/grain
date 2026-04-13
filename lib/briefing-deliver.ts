/**
 * Briefing Delivery — email via Resend + vault archive.
 *
 * Email: plain text via Resend. The briefing prompt already produces
 * formatted plain text (CAPS headers, dashes for lists) — no HTML needed.
 * Vault: markdown file in Obsidian vault for archival.
 */

import { sendEmail } from "@/lib/resend";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { BriefingMode } from "@/lib/briefing-context";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const BRIEFINGS_DIR = join(VAULT_ROOT, "30-decisions/briefings");
const DELIVERY_EMAIL = process.env.BRIEFING_EMAIL ?? "blangsfeld@gmail.com";

// ─── Email Delivery ─────────────────────────────

export async function deliverBriefingEmail(opts: {
  content: string;
  date: string;
  mode: BriefingMode;
}): Promise<{ id: string }> {
  const subject = opts.mode === "monday"
    ? `Grain - Monday Exec Prep - ${formatDate(opts.date)}`
    : `Grain - Daily Brief - ${formatDate(opts.date)}`;

  return sendEmail({
    to: DELIVERY_EMAIL,
    subject,
    text: opts.content,
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

// ─── Helpers ────────────────────────────────────

function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
