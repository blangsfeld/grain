/**
 * Heartbeat — the instrument panel for autonomous components.
 *
 * Every cron, orchestrator phase, and agent run calls beat() at its exit
 * point. The materializer reads the full ledger and writes a vault page
 * (70-agents/heartbeat.md) so "is the system alive?" is a glance, not a
 * query.
 *
 * Rules:
 * - beat() never throws up the call chain. Heartbeat failure must not
 *   break the real job.
 * - Each source upserts exactly one row. Absence of a fresh row = that
 *   component didn't run.
 * - Sources are namespaced with prefixes the materializer groups by:
 *     cron.*            — Vercel cron routes
 *     orchestrator.*    — Local orchestrator phases
 *     agent.*           — Agent output writers
 *     telegram.*        — Telegram interfaces
 */

import { getSupabaseAdmin } from "@/lib/supabase";

export type HeartbeatStatus = "ok" | "attention" | "failure";

export interface BeatParams {
  source: string;
  status?: HeartbeatStatus;
  summary: string;
  cadenceHours?: number;
  metadata?: Record<string, unknown>;
}

export interface Pulse {
  source: string;
  last_run_at: string;
  status: HeartbeatStatus;
  summary: string | null;
  expected_cadence_hours: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Write a single pulse. Never throws — worst case logs and continues.
 */
export async function beat(params: BeatParams): Promise<void> {
  try {
    const db = getSupabaseAdmin();
    const now = new Date().toISOString();
    const { error } = await db
      .from("grain_heartbeat")
      .upsert(
        {
          source: params.source,
          last_run_at: now,
          status: params.status ?? "ok",
          summary: params.summary,
          expected_cadence_hours: params.cadenceHours ?? null,
          metadata: params.metadata ?? null,
          updated_at: now,
        },
        { onConflict: "source" },
      );
    if (error) {
      console.warn(`[heartbeat] upsert ${params.source} failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[heartbeat] beat ${params.source} threw: ${msg}`);
  }
}

/**
 * Read all pulses. Returns empty array on error (non-throwing).
 */
export async function readAllPulses(): Promise<Pulse[]> {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("grain_heartbeat")
      .select("source, last_run_at, status, summary, expected_cadence_hours, metadata")
      .order("source", { ascending: true });
    if (error) {
      console.warn(`[heartbeat] readAllPulses: ${error.message}`);
      return [];
    }
    return (data ?? []) as Pulse[];
  } catch (err) {
    console.warn(`[heartbeat] readAllPulses threw: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Classify freshness against expected cadence.
 * - "fresh" = within cadence window
 * - "stale" = past cadence window
 * - "unknown" = no cadence declared
 */
export type Freshness = "fresh" | "stale" | "unknown";

export function freshness(pulse: Pulse, now: Date = new Date()): Freshness {
  if (pulse.expected_cadence_hours == null) return "unknown";
  const ageHours = (now.getTime() - new Date(pulse.last_run_at).getTime()) / 3_600_000;
  return ageHours <= pulse.expected_cadence_hours ? "fresh" : "stale";
}

/**
 * Derive the glance-icon from status + freshness.
 * - ✓ fresh ok
 * - ⚠ stale or status=attention
 * - ✗ status=failure
 */
export function glanceIcon(pulse: Pulse, now: Date = new Date()): "✓" | "⚠" | "✗" {
  if (pulse.status === "failure") return "✗";
  if (pulse.status === "attention") return "⚠";
  if (freshness(pulse, now) === "stale") return "⚠";
  return "✓";
}

/**
 * Format age since last run in short human form ("2h ago", "6d ago").
 */
export function ageString(pulse: Pulse, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(pulse.last_run_at).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
