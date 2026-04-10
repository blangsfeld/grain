/**
 * Granola client — token management, API calls, notes parsing, transcript formatting
 *
 * Token lifecycle:
 * 1. Seed from Granola's local file (~/.../Granola/supabase.json)
 * 2. Persist to .granola-tokens.json (project root, gitignored)
 * 3. On 401: refresh via WorkOS, persist new pair BEFORE using
 * 4. On refresh failure: surface "expired" status, user clicks Reconnect
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  GranolaTokens,
  GranolaDocument,
  GranolaUtterance,
  GranolaFolder,
  GranolaNotesMetadata,
  GranolaConnectionStatus,
} from "@/types/granola";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const GRANOLA_BASE_URL = "https://api.granola.ai";
const GRANOLA_LOCAL_PATH = join(
  homedir(),
  "Library/Application Support/Granola/supabase.json"
);
const TOKEN_PERSIST_PATH = join(process.cwd(), ".granola-tokens.json");
const WORKOS_AUTH_URL =
  "https://api.workos.com/user_management/authenticate";

const GRANOLA_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Granola/5.354.0",
  "X-Client-Version": "5.354.0",
};

// ─────────────────────────────────────────────
// Token Management
// ─────────────────────────────────────────────

/** Read seed tokens from Granola's local file. Returns null if not installed. */
export function readLocalToken(): GranolaTokens | null {
  try {
    if (!existsSync(GRANOLA_LOCAL_PATH)) return null;
    const raw = readFileSync(GRANOLA_LOCAL_PATH, "utf-8");
    const data = JSON.parse(raw);
    const tokens = JSON.parse(data.workos_tokens);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };
  } catch {
    return null;
  }
}

/** Check if running in serverless/deployed mode (no local filesystem). */
function isDeployed(): boolean {
  return !!process.env.VERCEL || !!process.env.GRAIN_DEPLOYED;
}

/** Read persisted tokens — local file or Supabase depending on environment. */
export async function getPersistedTokensAsync(): Promise<GranolaTokens | null> {
  if (isDeployed()) {
    return getTokensFromSupabase();
  }
  return getPersistedTokensLocal();
}

function getPersistedTokensLocal(): GranolaTokens | null {
  try {
    if (!existsSync(TOKEN_PERSIST_PATH)) return null;
    const raw = readFileSync(TOKEN_PERSIST_PATH, "utf-8");
    return JSON.parse(raw) as GranolaTokens;
  } catch {
    return null;
  }
}

/** Kept for backward compat — synchronous local-only version. */
export function getPersistedTokens(): GranolaTokens | null {
  return getPersistedTokensLocal();
}

/** Persist tokens — local file and/or Supabase. */
export async function persistTokensAsync(tokens: GranolaTokens): Promise<void> {
  // Always try Supabase (for deployed mode)
  await persistTokensToSupabase(tokens).catch(() => {});

  // Also write locally if we can
  if (!isDeployed()) {
    persistTokensLocal(tokens);
  }
}

function persistTokensLocal(tokens: GranolaTokens): void {
  const tmpPath = TOKEN_PERSIST_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), "utf-8");
  renameSync(tmpPath, TOKEN_PERSIST_PATH);
}

/** Kept for backward compat — synchronous local-only version. */
export function persistTokens(tokens: GranolaTokens): void {
  persistTokensLocal(tokens);
  // Fire-and-forget Supabase persist
  persistTokensToSupabase(tokens).catch(() => {});
}

// ─── Supabase token storage ──────────────────────

async function getTokensFromSupabase(): Promise<GranolaTokens | null> {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;

    const db = createClient(url, key);
    const { data } = await db
      .from("dx_config")
      .select("value")
      .eq("key", "granola_tokens")
      .single();

    if (!data?.value) return null;
    return data.value as GranolaTokens;
  } catch {
    return null;
  }
}

async function persistTokensToSupabase(tokens: GranolaTokens): Promise<void> {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const db = createClient(url, key);
    await db
      .from("dx_config")
      .upsert({
        key: "granola_tokens",
        value: tokens,
        updated_at: new Date().toISOString(),
      });
  } catch {
    // Non-fatal
  }
}

/** Exchange refresh token for new token pair via WorkOS. */
async function refreshAccessToken(
  refreshToken: string,
  clientId: string
): Promise<GranolaTokens> {
  const res = await fetch(WORKOS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WorkOS refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  };
}

/** Extract WorkOS client_id from a JWT's iss claim. */
function extractClientIdFromJwt(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    // Base64url decode the payload
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(normalized, "base64").toString("utf-8"));
    // iss looks like: https://auth.granola.ai/user_management/client_01...
    const iss = payload.iss as string | undefined;
    if (!iss) return null;
    const match = iss.match(/client_[A-Z0-9]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/** Read WorkOS client_id — from Granola's file or by extracting from current JWT. */
function readClientIdLocal(): string | null {
  try {
    if (!existsSync(GRANOLA_LOCAL_PATH)) return null;
    const raw = readFileSync(GRANOLA_LOCAL_PATH, "utf-8");
    const data = JSON.parse(raw);
    // Try direct field first
    const direct = data.client_id ?? data.workos_client_id;
    if (direct) return direct;
    // Extract from JWT payload
    try {
      const tokens = typeof data.workos_tokens === "string"
        ? JSON.parse(data.workos_tokens)
        : data.workos_tokens;
      if (tokens?.access_token) {
        return extractClientIdFromJwt(tokens.access_token);
      }
    } catch {}
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the WorkOS client_id needed for token refresh.
 * Resolution order:
 * 1. Supabase dx_config (durable, works on Vercel)
 * 2. Granola local file (dev only)
 * 3. Extract from current access token's JWT (works anywhere)
 * Persists whatever it finds back to Supabase for next time.
 */
async function getClientId(currentAccessToken?: string): Promise<string | null> {
  const saveToSupabase = async (clientId: string): Promise<void> => {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return;
      const db = createClient(url, key);
      await db.from("dx_config").upsert(
        { key: "granola_client_id", value: clientId },
        { onConflict: "key" }
      );
    } catch {}
  };

  // 1. Try Supabase
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const db = createClient(url, key);
      const { data } = await db
        .from("dx_config")
        .select("value")
        .eq("key", "granola_client_id")
        .single();
      if (data?.value) {
        const stored = typeof data.value === "string" ? data.value : (data.value as { client_id?: string }).client_id;
        if (stored) return stored;
      }
    }
  } catch {}

  // 2. Local file
  const local = readClientIdLocal();
  if (local) {
    await saveToSupabase(local);
    return local;
  }

  // 3. Extract from current JWT
  if (currentAccessToken) {
    const extracted = extractClientIdFromJwt(currentAccessToken);
    if (extracted) {
      await saveToSupabase(extracted);
      return extracted;
    }
  }

  return null;
}

/**
 * Get a valid access token. Orchestrates the full lifecycle:
 * persisted → seed from local → refresh on 401 → persist.
 *
 * Throws if unable to obtain a valid token.
 */
export async function getValidAccessToken(): Promise<string> {
  // 1. Try persisted tokens (Supabase in deployed, local file otherwise)
  let tokens = await getPersistedTokensAsync();

  // 2. If none, seed from Granola's local file (only works locally)
  if (!tokens) {
    const local = readLocalToken();
    if (!local) {
      throw new Error("GRANOLA_UNAVAILABLE");
    }
    await persistTokensAsync(local);
    tokens = local;
  }

  // 3. Test the access token with a lightweight call
  const testRes = await fetch(`${GRANOLA_BASE_URL}/v2/get-documents`, {
    method: "POST",
    headers: {
      ...GRANOLA_HEADERS,
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ limit: 1, offset: 0 }),
  });

  if (testRes.ok) {
    return tokens.access_token;
  }

  // 4. Access token expired — try refresh
  if (testRes.status === 401) {
    const clientId = await getClientId(tokens.access_token);
    if (!clientId) {
      // Try re-reading local file (Granola may have refreshed it)
      const local = readLocalToken();
      if (local) {
        persistTokens(local);
        return local.access_token;
      }
      throw new Error("GRANOLA_EXPIRED");
    }

    try {
      const newTokens = await refreshAccessToken(
        tokens.refresh_token,
        clientId
      );
      // CRITICAL: persist BEFORE using
      persistTokens(newTokens);
      return newTokens.access_token;
    } catch {
      // Refresh failed — try re-reading local file as last resort
      const local = readLocalToken();
      if (local && local.access_token !== tokens.access_token) {
        persistTokens(local);
        return local.access_token;
      }
      throw new Error("GRANOLA_EXPIRED");
    }
  }

  throw new Error(`Granola API error: ${testRes.status}`);
}

/**
 * Re-seed tokens from Granola's local file.
 * Called when user clicks "Reconnect".
 */
export async function reconnect(): Promise<GranolaConnectionStatus> {
  const local = readLocalToken();
  if (!local) return "unavailable";

  persistTokens(local);

  // Verify the new token works
  try {
    await getValidAccessToken();
    return "connected";
  } catch {
    return "expired";
  }
}

/** Check connection status without throwing. */
export async function checkConnection(): Promise<GranolaConnectionStatus> {
  try {
    await getValidAccessToken();
    return "connected";
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "GRANOLA_UNAVAILABLE") return "unavailable";
    if (msg === "GRANOLA_EXPIRED") return "expired";
    return "error";
  }
}

// ─────────────────────────────────────────────
// API Methods
// ─────────────────────────────────────────────

async function granolarFetch(
  endpoint: string,
  body: Record<string, unknown>
): Promise<Response> {
  const token = await getValidAccessToken();
  return fetch(`${GRANOLA_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      ...GRANOLA_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** List meetings (documents). Returns newest first. */
export async function listMeetings(
  limit = 100,
  offset = 0
): Promise<GranolaDocument[]> {
  const res = await granolarFetch("/v2/get-documents", {
    limit,
    offset,
    include_last_viewed_panel: false,
  });

  if (!res.ok) {
    throw new Error(`listMeetings failed: ${res.status}`);
  }

  const data = await res.json();
  return (data.docs ?? []) as GranolaDocument[];
}

/** Get transcript utterances for a meeting. Returns empty array if no transcript. */
export async function getTranscript(
  documentId: string
): Promise<GranolaUtterance[]> {
  const res = await granolarFetch("/v1/get-document-transcript", {
    document_id: documentId,
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`getTranscript failed: ${res.status}`);
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : []) as GranolaUtterance[];
}

/** Get Granola folders (document lists). Normalizes v1/v2 differences. */
export async function getFolders(): Promise<GranolaFolder[]> {
  // Try v2 first
  const res = await granolarFetch("/v2/get-document-lists", {});

  if (!res.ok) {
    throw new Error(`getFolders failed: ${res.status}`);
  }

  const data = await res.json();
  const lists = Array.isArray(data) ? data : [];

  // Normalize: v2 has documents[].id, v1 has document_ids; v2 has title, v1 has name
  return lists.map(
    (list: Record<string, unknown>): GranolaFolder => ({
      id: list.id as string,
      title: (list.title ?? list.name ?? "Untitled") as string,
      created_at: list.created_at as string,
      workspace_id: (list.workspace_id ?? "") as string,
      document_ids: Array.isArray(list.documents)
        ? list.documents.map((d: Record<string, unknown>) => d.id as string)
        : Array.isArray(list.document_ids)
          ? (list.document_ids as string[])
          : [],
      is_favourite: (list.is_favourite ?? false) as boolean,
    })
  );
}

/** Batch fetch documents by ID. For resolving folder → meeting details. */
export async function getMeetingsByIds(
  ids: string[]
): Promise<GranolaDocument[]> {
  if (ids.length === 0) return [];

  // Batch in chunks of 100
  const docs: GranolaDocument[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await granolarFetch("/v1/get-documents-batch", {
      document_ids: chunk,
      include_last_viewed_panel: false,
    });

    if (!res.ok) {
      throw new Error(`getMeetingsByIds failed: ${res.status}`);
    }

    const data = await res.json();
    // Response field may be "documents" or "docs"
    const batch = (data.documents ?? data.docs ?? []) as GranolaDocument[];
    docs.push(...batch);
  }

  return docs;
}

/** Fetch a single document with notes (last_viewed_panel). */
export async function getMeetingWithNotes(
  id: string
): Promise<GranolaDocument | null> {
  const res = await granolarFetch("/v1/get-documents-batch", {
    document_ids: [id],
    include_last_viewed_panel: true,
  });

  if (!res.ok) return null;

  const data = await res.json();
  const docs = (data.documents ?? data.docs ?? []) as GranolaDocument[];
  return docs[0] ?? null;
}

// ─────────────────────────────────────────────
// Notes Parsing
// ─────────────────────────────────────────────

/**
 * Parse ProseMirror notes content for factual metadata only.
 * Extracts participant names and topic — NOT interpretations, action items, or summaries.
 */
export function parseNotesMetadata(
  content: Record<string, unknown> | undefined
): GranolaNotesMetadata {
  const result: GranolaNotesMetadata = { participants: [] };
  if (!content) return result;

  // Extract all text from ProseMirror JSON
  const allText = extractProseMirrorText(content);
  if (!allText) return result;

  // Look for participant-like patterns in the text
  // Common patterns: "Attendees: Alice, Bob", "Participants: ...", names at the top
  const participantPatterns = [
    /(?:participants?|attendees?|present|people)[:：]\s*(.+)/i,
    /(?:with|between)\s+(.+?)(?:\.|$)/i,
  ];

  for (const pattern of participantPatterns) {
    const match = allText.match(pattern);
    if (match) {
      const names = match[1]
        .split(/[,&]|\band\b/)
        .map((n) => n.trim())
        .filter((n) => n.length > 1 && n.length < 40 && /^[A-Z]/.test(n));
      if (names.length > 0) {
        result.participants = names;
        break;
      }
    }
  }

  // Extract topic from first heading or first paragraph
  const topicText = extractFirstHeadingOrParagraph(content);
  if (topicText && topicText.length < 120) {
    result.topic = topicText;
  }

  return result;
}

/** Recursively extract all text from ProseMirror JSON. */
function extractProseMirrorText(node: Record<string, unknown>): string {
  if (typeof node.text === "string") return node.text;

  const parts: string[] = [];
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      parts.push(extractProseMirrorText(child as Record<string, unknown>));
    }
  }
  return parts.join(" ");
}

/** Get text from first heading or paragraph in ProseMirror JSON. */
function extractFirstHeadingOrParagraph(
  node: Record<string, unknown>
): string | null {
  if (Array.isArray(node.content)) {
    for (const child of node.content as Record<string, unknown>[]) {
      if (child.type === "heading" || child.type === "paragraph") {
        const text = extractProseMirrorText(child).trim();
        if (text) return text;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Transcript Formatting
// ─────────────────────────────────────────────

/**
 * Format Granola utterances into a transcript string for the extraction pipeline.
 *
 * Speaker attribution:
 * - microphone → "You:"
 * - system → participant name (if single participant) or "Them:"
 *
 * Context header includes title, date, and participants (if available)
 * so the extraction prompt knows who's in the room.
 */
export function formatTranscript(
  utterances: GranolaUtterance[],
  title: string,
  date: string,
  participants?: string[]
): string {
  const lines: string[] = [];

  // Context header — facts only
  lines.push(title);
  lines.push(`Date: ${date}`);
  if (participants && participants.length > 0) {
    lines.push(`Participants: ${participants.join(", ")}`);
  }
  lines.push("");

  // Speaker label for system audio
  const systemLabel =
    participants && participants.length === 1
      ? `${participants[0]}:`
      : "Them:";

  for (const u of utterances) {
    const speaker = u.source === "microphone" ? "You:" : systemLabel;
    lines.push(`${speaker} ${u.text}`);
  }

  return lines.join("\n");
}

/** Derive meeting duration in minutes from utterance timestamps. */
export function deriveDuration(
  utterances: GranolaUtterance[]
): number | undefined {
  if (utterances.length === 0) return undefined;

  try {
    const first = new Date(utterances[0].start_timestamp).getTime();
    const last = new Date(
      utterances[utterances.length - 1].end_timestamp
    ).getTime();
    const minutes = Math.round((last - first) / 60_000);
    return minutes > 0 ? minutes : undefined;
  } catch {
    return undefined;
  }
}

/** Derive meeting date from first utterance or document created_at. */
export function deriveMeetingDate(
  utterances: GranolaUtterance[],
  documentCreatedAt: string
): string {
  if (utterances.length > 0) {
    try {
      return utterances[0].start_timestamp.split("T")[0];
    } catch {
      // fall through
    }
  }
  return documentCreatedAt.split("T")[0];
}
