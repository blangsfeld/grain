/**
 * GET /api/google/auth/callback — Exchange OAuth code for tokens.
 */

import { NextRequest, NextResponse } from "next/server";
import { writeFileSync } from "fs";
import { join } from "path";
import { getSupabaseAdmin } from "@/lib/supabase";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "No code provided" }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Google credentials not configured" }, { status: 500 });
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3003"}/api/google/auth/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: `Token exchange failed: ${err}` }, { status: 500 });
  }

  const data = await res.json();
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };

  // Persist tokens (local file + Supabase)
  const tokenPath = join(process.cwd(), ".google-tokens.json");
  try { writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf-8"); } catch {}

  try {
    const db = getSupabaseAdmin();
    await db.from("dx_config").upsert({ key: "google_tokens", value: tokens }, { onConflict: "key" });
  } catch {}

  const scopes = (data.scope as string).split(" ");
  const hasSend = scopes.some((s: string) => s.includes("gmail.send"));

  return new NextResponse(
    `<html><body style="background:#0a0a0a;color:#e4e4e7;font-family:system-ui;padding:48px;text-align:center;">
      <h1 style="color:#6ee7b7;">Connected</h1>
      <p>Scopes: ${scopes.length} granted${hasSend ? " (including gmail.send)" : ""}</p>
      <p style="color:#52525b;margin-top:24px;">You can close this tab.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
