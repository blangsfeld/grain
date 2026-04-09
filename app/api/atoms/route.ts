/**
 * GET /api/atoms — Query atoms
 * POST /api/atoms — Not used (atoms are created by the pipeline)
 * PATCH /api/atoms — Update atom (save/archive)
 *
 * Query params: type, domain_id, contact, since, until, saved, limit
 */

import { NextRequest, NextResponse } from "next/server";
import { queryAtoms, updateAtom } from "@/lib/atom-db";
import type { AtomType } from "@/types/atoms";

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;

    const typeParam = params.get("type");
    const type = typeParam
      ? (typeParam.includes(",") ? typeParam.split(",") as AtomType[] : typeParam as AtomType)
      : undefined;

    const atoms = await queryAtoms({
      type,
      domain_id: params.get("domain_id") ?? undefined,
      contact_name: params.get("contact") ?? undefined,
      search: params.get("search") ?? undefined,
      since: params.get("since") ?? undefined,
      until: params.get("until") ?? undefined,
      saved: params.get("saved") === "true" ? true : undefined,
      archived: false,
      limit: params.get("limit") ? parseInt(params.get("limit")!) : 100,
    });

    return NextResponse.json({ atoms, count: atoms.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, saved, archived } = body;

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const updates: Record<string, boolean> = {};
    if (saved !== undefined) updates.saved = saved;
    if (archived !== undefined) updates.archived = archived;

    await updateAtom(id, updates);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
