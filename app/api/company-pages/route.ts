/**
 * POST /api/company-pages — Refresh company pages + optional trajectory generation.
 *
 * Body: { trajectories?: boolean, year?: number, quarter?: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { refreshCompanyPages, generateTrajectories } from "@/lib/company-pages";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    // Refresh company pages
    const pages = await refreshCompanyPages();

    // Optional trajectory generation
    let trajectories = null;
    if (body.trajectories) {
      const now = new Date();
      const year = body.year ?? now.getFullYear();
      const quarter = body.quarter ?? Math.ceil((now.getMonth() + 1) / 3);
      trajectories = await generateTrajectories(year, quarter);
    }

    return NextResponse.json({
      success: true,
      pages: pages.map((p) => ({
        name: p.name,
        atoms: p.atomCount,
        updated: p.updated,
      })),
      trajectories: trajectories?.map((t) => ({
        name: t.name,
        quarter: t.quarter,
        atoms: t.atomCount,
        generated: !!t.path,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
