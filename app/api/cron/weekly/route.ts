/**
 * GET /api/cron/weekly — Vercel cron trigger
 * Sunday night: generate weekly digest, email delivery, vault export.
 */

import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyDigest } from "@/lib/weekly-digest";
import { refreshCompanyPages } from "@/lib/company-pages";
import { sendEmail } from "@/lib/google";

export const maxDuration = 300;

const DELIVERY_EMAIL = "ben@residence.co";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    // Calculate this week's Monday and Sunday
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekStart = monday.toISOString().split("T")[0];
    const weekEnd = sunday.toISOString().split("T")[0];

    const result = await generateWeeklyDigest(weekStart, weekEnd);

    // Email delivery (non-fatal)
    let emailSent = false;
    if (result.narrative && result.intel.meeting_count > 0) {
      try {
        await sendEmail({
          to: DELIVERY_EMAIL,
          subject: `Grain — ${result.intel.week_label}`,
          plainBody: result.narrative,
          htmlBody: result.narrative,
        });
        emailSent = true;
      } catch (emailErr) {
        console.error("Weekly digest email failed:", emailErr instanceof Error ? emailErr.message : emailErr);
      }
    }

    // Refresh company pages after digest (non-fatal)
    let companyPages = null;
    try {
      companyPages = await refreshCompanyPages();
    } catch (cpErr) {
      console.error("Company page refresh failed:", cpErr instanceof Error ? cpErr.message : cpErr);
    }

    return NextResponse.json({
      success: true,
      week_start: weekStart,
      week_end: weekEnd,
      meeting_count: result.intel.meeting_count,
      atom_count: result.intel.atom_count,
      decision_count: result.intel.decision_count,
      tensions: result.intel.tensions.length,
      vault_path: result.vault_path,
      email_sent: emailSent,
      tokens: result.tokens,
      company_pages: companyPages?.map((p) => ({
        name: p.name,
        updated: p.updated,
        atoms: p.atomCount,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
