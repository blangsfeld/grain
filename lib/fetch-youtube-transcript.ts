/**
 * YouTube transcript fetch — Phase B1 for Milli wiki triage.
 *
 * Wraps the `youtube-transcript` package so callers get a single typed
 * result and never have to reason about the package's internal error
 * hierarchy. Returns null when captions aren't available (disabled,
 * private video, no caption track) — that's a non-fatal condition and
 * Milli falls back to metadata-only.
 *
 * Why the npm dep: YouTube's 2024 "proof-of-origin token" gate makes
 * direct timedtext fetches return empty bodies without an InnerTube
 * handshake. The package handles the Android-client InnerTube flow,
 * which is the only path that currently works without auth.
 */
import { YoutubeTranscript } from "youtube-transcript";

export interface TranscriptFetchResult {
  text: string;
  language: string | null;
  segment_count: number;
  duration_seconds: number;
}

/**
 * Fetch a YouTube transcript. Prefers English when available, falls back
 * to the video's default caption track. Returns null if no caption track
 * exists for the video or the fetch is blocked.
 */
export async function fetchYouTubeTranscript(url: string): Promise<TranscriptFetchResult | null> {
  const attempts: Array<{ lang?: string }> = [{ lang: "en" }, {}];
  let lastError: unknown = null;

  for (const cfg of attempts) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(url, cfg);
      if (!segments || segments.length === 0) continue;
      const text = segments
        .map((s) => s.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      // Segments returned but empty text = anomalous caption track. Don't
      // silently fall back to a different language — that would mislabel
      // transcript_language in the written page. Bail cleanly.
      if (!text) return null;
      const last = segments[segments.length - 1];
      const duration = Math.round(((last.offset ?? 0) + (last.duration ?? 0)) / 1000);
      return {
        text,
        language: segments[0]?.lang ?? cfg.lang ?? null,
        segment_count: segments.length,
        duration_seconds: duration,
      };
    } catch (err) {
      lastError = err;
      const name = err instanceof Error ? err.constructor.name : "";
      // Permanent: no transcript track exists for this video → stop trying.
      if (
        name === "YoutubeTranscriptDisabledError" ||
        name === "YoutubeTranscriptVideoUnavailableError" ||
        name === "YoutubeTranscriptNotAvailableError"
      ) {
        return null;
      }
      // YoutubeTranscriptNotAvailableLanguageError (requested lang missing)
      // and network errors fall through to the no-lang attempt.
    }
  }

  if (lastError) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    console.warn(`[youtube-transcript] all attempts failed: ${msg}`);
  }
  return null;
}
