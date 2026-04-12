/**
 * GET /api/debug/granola-raw?id=<document_id>
 *
 * One-off probe to see the full raw Granola API response for a single
 * document, so we can discover what participant/attendee fields are
 * actually returned (the typed GranolaDocument interface is minimal
 * and drops everything else).
 */

import { NextRequest, NextResponse } from "next/server";
import { getRawDocument } from "@/lib/granola";

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing ?id=<document_id>" }, { status: 400 });
  }

  const doc = await getRawDocument(id);
  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json({
    keys: Object.keys(doc),
    doc,
  });
}
