/**
 * URL Ingest — fetch content from URLs, run through the extraction pipeline.
 * Handles Claude.ai shared chats and general web articles.
 */

import { createHash } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { classifyTranscript, getExtractionPlan } from "@/lib/classify";
import { extractAtoms } from "@/lib/atom-extract";
import { insertAtoms } from "@/lib/atom-db";
import { loadRegistries, resolveAtoms } from "@/lib/resolve";
import { accrueSignals } from "@/lib/signal-engine/accrue";
import { fetchYouTubeTranscript } from "@/lib/fetch-youtube-transcript";

// ─── URL type detection ─────────────────────────

export type UrlType = "claude_chat" | "video" | "article";

export function detectUrlType(url: string): UrlType {
  if (url.includes("claude.ai/share")) return "claude_chat";
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith("youtube.com") || host === "youtu.be" || host.endsWith("vimeo.com")) {
      return "video";
    }
  } catch {
    // fall through to article
  }
  return "article";
}

// ─── Content fetchers ───────────────────────────

export async function fetchClaudeChat(url: string): Promise<{ title: string; text: string }> {
  // Claude.ai shared chats render as HTML with the conversation embedded
  const res = await fetch(url, {
    headers: { "User-Agent": "Grain/1.0" },
  });
  if (!res.ok) throw new Error(`Failed to fetch Claude chat: ${res.status}`);

  const html = await res.text();

  // Extract title from <title> tag
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.replace(" - Claude", "").trim() || "Claude Chat";

  // Extract conversation content — strip HTML tags, keep text
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? html;

  // Remove script and style blocks
  const cleaned = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 50) {
    throw new Error("Could not extract meaningful content from Claude chat URL");
  }

  return { title, text: cleaned };
}

export async function fetchArticle(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Grain/1.0" },
  });
  if (!res.ok) throw new Error(`Failed to fetch article: ${res.status}`);

  const html = await res.text();

  // Extract title
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ??
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() || new URL(url).hostname;

  // Extract body text
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? html;

  // Try to find article/main content first
  const articleMatch =
    bodyHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    bodyHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentHtml = articleMatch?.[1] ?? bodyHtml;

  const text = contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 50) {
    throw new Error("Could not extract meaningful content from URL");
  }

  return { title, text };
}

// ─── Main ingest ────────────────────────────────

export type TranscriptSourceType = "claude_chat" | "article" | "youtube";

export interface UrlIngestResult {
  title: string;
  url: string;
  url_type: UrlType;
  atoms: number;
  tokens: number;
  pass_results: Record<string, number>;
  status: "extracted" | "dismissed" | "duplicate" | "no_content";
}

function sourceTypeToUrlType(st: TranscriptSourceType): UrlType {
  if (st === "claude_chat") return "claude_chat";
  if (st === "youtube") return "video";
  return "article";
}

/**
 * Core Grain pipeline for pre-fetched text: dedup → dx_transcripts →
 * classify → extract atoms → resolve entities → signal accrual. Callable
 * by URL ingest, Milli's wiki triage, or any other upstream fetcher.
 */
export async function ingestTranscript(params: {
  title: string;
  url: string;
  text: string;
  sourceType: TranscriptSourceType;
}): Promise<UrlIngestResult> {
  const { title, url, text, sourceType } = params;
  const db = getSupabaseAdmin();
  const urlType = sourceTypeToUrlType(sourceType);

  const hash = createHash("sha256").update(text.trim()).digest("hex");
  const { data: existing } = await db
    .from("dx_transcripts")
    .select("id")
    .eq("transcript_hash", hash)
    .single();

  if (existing) {
    return { title, url, url_type: urlType, atoms: 0, tokens: 0, pass_results: {}, status: "duplicate" };
  }

  const today = new Date().toISOString().split("T")[0];
  const { data: txRecord, error: txError } = await db
    .from("dx_transcripts")
    .insert({
      source_title: title,
      source_date: today,
      source_type: sourceType,
      source_url: url,
      transcript: text.slice(0, 100_000),
      transcript_hash: hash,
      word_count: text.split(/\s+/).length,
      inbox_status: "approved",
    })
    .select("id")
    .single();
  if (txError) throw new Error(`Transcript insert failed: ${txError.message}`);

  const classification = await classifyTranscript(text, title);
  const plan = getExtractionPlan(classification);

  if (plan.dismiss) {
    return { title, url, url_type: urlType, atoms: 0, tokens: 0, pass_results: {}, status: "dismissed" };
  }

  const extraction = await extractAtoms(text, title, plan.passes);

  for (const atom of extraction.atoms) {
    atom.transcript_id = txRecord.id;
    atom.source_title = title;
    atom.source_date = today;
  }

  const { contacts, domains } = await loadRegistries();
  resolveAtoms(extraction.atoms, contacts, domains);

  const inserted = await insertAtoms(extraction.atoms);

  try {
    await accrueSignals({
      atoms: inserted,
      meta: null,
      transcript_id: txRecord.id,
      source_date: today,
      source_title: title,
      people: [],
    });
  } catch (err) {
    console.error(
      `signal accrual failed for URL "${title}":`,
      err instanceof Error ? err.message : err,
    );
  }

  return {
    title,
    url,
    url_type: urlType,
    atoms: extraction.atoms.length,
    tokens: extraction.tokens,
    pass_results: extraction.pass_results,
    status: "extracted",
  };
}

async function fetchYouTubeTitle(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Grain/1.0" } });
    if (!res.ok) return "YouTube video";
    const html = await res.text();
    const m =
      html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ??
      html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!m) return "YouTube video";
    return m[1]
      .replace(/\s*-\s*YouTube\s*$/i, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  } catch {
    return "YouTube video";
  }
}

export async function ingestFromUrl(url: string): Promise<UrlIngestResult> {
  const urlType = detectUrlType(url);

  if (urlType === "video") {
    const transcript = await fetchYouTubeTranscript(url);
    if (!transcript || transcript.text.length < 200) {
      return { title: url, url, url_type: "video", atoms: 0, tokens: 0, pass_results: {}, status: "no_content" };
    }
    const title = await fetchYouTubeTitle(url);
    return ingestTranscript({ title, url, text: transcript.text, sourceType: "youtube" });
  }

  const { title, text } = urlType === "claude_chat"
    ? await fetchClaudeChat(url)
    : await fetchArticle(url);

  const sourceType: TranscriptSourceType = urlType === "claude_chat" ? "claude_chat" : "article";
  return ingestTranscript({ title, url, text, sourceType });
}
