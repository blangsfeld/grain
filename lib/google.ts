/**
 * Google OAuth + Calendar + Gmail client
 * Copied from Source v2, adapted for Grain.
 *
 * Token lifecycle:
 * 1. Shared .google-tokens.json with Source v2 (same Google account)
 * 2. On 401: refresh via refresh_token, persist new tokens, retry
 * 3. On refresh failure: surface "expired" status
 *
 * Scopes: calendar.readonly, gmail.readonly, gmail.send
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { getSupabaseAdmin } from "@/lib/supabase";
import type {
  GoogleTokens,
  GoogleConnectionStatus,
  GoogleCalendar,
  GoogleCalendarEvent,
  GoogleAttendee,
  GmailThread,
} from "@/types/google";

// ─── Constants ──────────────────────────────────

const TOKEN_PERSIST_PATH = join(process.cwd(), ".google-tokens.json");
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const GMAIL_BASE = "https://www.googleapis.com/gmail/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DB_TOKEN_KEY = "google_tokens";

// ─── Token Management ───────────────────────────
// Reads from local file first (fast), falls back to Supabase (Vercel).
// Writes to both local file and Supabase for durability.

export function getPersistedTokens(): GoogleTokens | null {
  try {
    if (!existsSync(TOKEN_PERSIST_PATH)) return null;
    const raw = readFileSync(TOKEN_PERSIST_PATH, "utf-8");
    return JSON.parse(raw) as GoogleTokens;
  } catch {
    return null;
  }
}

/** Try local file, then Supabase. */
export async function getTokens(): Promise<GoogleTokens | null> {
  const local = getPersistedTokens();
  if (local) return local;

  // Fall back to Supabase (for Vercel)
  try {
    const db = getSupabaseAdmin();
    const { data } = await db
      .from("dx_config")
      .select("value")
      .eq("key", DB_TOKEN_KEY)
      .single();
    if (data?.value) return data.value as GoogleTokens;
  } catch {}

  return null;
}

async function persistTokens(tokens: GoogleTokens): Promise<void> {
  // Local file (dev)
  try {
    const tmpPath = TOKEN_PERSIST_PATH + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), "utf-8");
    renameSync(tmpPath, TOKEN_PERSIST_PATH);
  } catch {}

  // Supabase (Vercel durability)
  try {
    const db = getSupabaseAdmin();
    await db
      .from("dx_config")
      .upsert({ key: DB_TOKEN_KEY, value: tokens }, { onConflict: "key" });
  } catch {}
}

async function refreshAccessToken(tokens: GoogleTokens): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID/SECRET missing");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error("GOOGLE_REFRESH_FAILED");

  const data = await res.json();
  const refreshed: GoogleTokens = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? tokens.scope,
  };
  await persistTokens(refreshed);
  return refreshed;
}

async function getValidTokens(): Promise<GoogleTokens> {
  const tokens = await getTokens();
  if (!tokens) throw new Error("GOOGLE_NO_TOKEN");

  if (Date.now() >= tokens.expires_at - 5 * 60 * 1000) {
    return refreshAccessToken(tokens);
  }
  return tokens;
}

// ─── HTTP Helpers ───────────────────────────────

async function googleFetch(url: string, tokens: GoogleTokens, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${tokens.access_token}`, ...init?.headers },
  });
}

async function authedGet(url: string): Promise<unknown> {
  let tokens = await getValidTokens();
  let res = await googleFetch(url, tokens);

  if (res.status === 401) {
    tokens = await refreshAccessToken(tokens);
    res = await googleFetch(url, tokens);
  }

  if (!res.ok) throw new Error(`Google API error ${res.status}: ${url}`);
  return res.json();
}

async function authedPost(url: string, body: string, contentType: string): Promise<unknown> {
  let tokens = await getValidTokens();
  let res = await googleFetch(url, tokens, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });

  if (res.status === 401) {
    tokens = await refreshAccessToken(tokens);
    res = await googleFetch(url, tokens, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
  }

  if (!res.ok) throw new Error(`Google API error ${res.status}: ${url}`);
  return res.json();
}

// ─── Connection Status ──────────────────────────

export async function checkConnection(): Promise<GoogleConnectionStatus> {
  const tokens = await getTokens();
  if (!tokens) return "no_token";

  try {
    const validTokens = await getValidTokens();
    const res = await googleFetch(`${CALENDAR_BASE}/users/me/calendarList?maxResults=1`, validTokens);
    if (res.ok) return "connected";
    if (res.status === 401) return "expired";
    return "invalid_token";
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "GOOGLE_NO_TOKEN") return "no_token";
    if (msg === "GOOGLE_REFRESH_FAILED") return "expired";
    return "invalid_token";
  }
}

// ─── Calendar API ───────────────────────────────

export async function listCalendars(): Promise<GoogleCalendar[]> {
  const data = await authedGet(`${CALENDAR_BASE}/users/me/calendarList`) as {
    items?: Array<{ id: string; summary: string; primary?: boolean }>;
  };
  return (data.items ?? []).map((c) => ({
    id: c.id,
    name: c.summary,
    primary: c.primary ?? false,
  }));
}

export async function listCalendarEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<GoogleCalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin, timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });

  const data = await authedGet(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  ) as {
    items?: Array<{
      id: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      attendees?: Array<{ email: string; displayName?: string; self?: boolean; responseStatus?: string }>;
      description?: string;
      location?: string;
    }>;
    summary?: string;
  };

  const calendarName = (data as { summary?: string }).summary ?? calendarId;

  return (data.items ?? []).map((e) => {
    const startRaw = e.start?.dateTime ?? e.start?.date ?? "";
    const endRaw = e.end?.dateTime ?? e.end?.date ?? "";
    const allDay = !e.start?.dateTime;

    const attendees: GoogleAttendee[] = (e.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.displayName,
      self: a.self,
      response: a.responseStatus as GoogleAttendee["response"],
    }));

    return {
      id: e.id,
      title: e.summary ?? "Untitled Event",
      start: startRaw,
      end: endRaw,
      all_day: allDay,
      attendees,
      description: e.description,
      location: e.location,
      calendar_id: calendarId,
      calendar_name: calendarName,
    };
  });
}

// ─── Gmail API ──────────────────────────────────

export async function listGmailThreads(
  query: string = "in:inbox",
  maxResults = 10,
): Promise<GmailThread[]> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });

  const data = await authedGet(
    `${GMAIL_BASE}/users/me/threads?${params}`
  ) as { threads?: Array<{ id: string; snippet: string }> };

  const threads = data.threads ?? [];
  if (threads.length === 0) return [];

  const batch = threads.slice(0, 10);
  const details = await Promise.all(
    batch.map((t) => getGmailThreadMeta(t.id))
  );

  return details.filter((t): t is GmailThread => t !== null);
}

async function getGmailThreadMeta(threadId: string): Promise<GmailThread | null> {
  try {
    const data = await authedGet(
      `${GMAIL_BASE}/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    ) as {
      id: string;
      messages?: Array<{
        id: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
        snippet?: string;
      }>;
    };

    const messages = data.messages ?? [];
    if (messages.length === 0) return null;

    const first = messages[0];
    const headers = first.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      id: threadId,
      subject: getHeader("Subject") || "(no subject)",
      from: getHeader("From"),
      date: getHeader("Date"),
      snippet: first.snippet ?? "",
      message_count: messages.length,
    };
  } catch {
    return null;
  }
}

// Gmail send removed — email delivery now handled by Resend (lib/resend.ts)
