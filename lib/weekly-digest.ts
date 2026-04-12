/**
 * Weekly Intelligence Digest
 *
 * SQL computes the patterns. Claude narrates them.
 * Euclid voice: lead with facts, follow with what they mean for you.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { buildWeeklyDigestPrompt, WEEKLY_DIGEST_MAX_TOKENS } from "@/lib/prompts/weekly-digest";
import type { DecisionContent, RelationshipsPayload } from "@/types/atoms";

// ─── Types ───────────────────────────────────────

export interface TensionTrend {
  slug: string;
  readable: string;
  count_this_week: number;
  count_prev_week: number;
  trend: "rising" | "steady" | "fading" | "new";
  people: string[];
  last_date: string;
}

export interface PersonShift {
  name: string;
  email: string;
  meetings_this_week: number;
  weekly_avg_30d: number;
  shift: "surging" | "steady" | "dropping" | "new";
  last_seen: string;
}

export interface DecisionSummary {
  statement: string;
  made_by: string | null;
  date: string;
  meeting: string;
  attendees: string[];
}

export interface LoopStats {
  opened_this_week: number;
  total_open: number;
  owners_with_most: Array<{ owner: string; count: number }>;
}

export interface WeeklyIntel {
  week_label: string;
  week_start: string;
  week_end: string;
  meeting_count: number;
  meeting_avg_30d: number;
  atom_count: number;
  tensions: TensionTrend[];
  decisions: DecisionSummary[];
  decision_count: number;
  decision_avg_30d: number;
  people: PersonShift[];
  loops: LoopStats;
}

export interface WeeklyDigestResult {
  intel: WeeklyIntel;
  narrative: string;
  tokens: number;
  vault_path: string | null;
}

const MODEL = "claude-sonnet-4-20250514";

// ─── Main ────────────────────────────────────────

export async function generateWeeklyDigest(
  weekStart: string,
  weekEnd: string,
): Promise<WeeklyDigestResult> {
  const intel = await gatherWeeklyIntel(weekStart, weekEnd);

  if (intel.meeting_count === 0) {
    return {
      intel,
      narrative: "No meetings this week.",
      tokens: 0,
      vault_path: null,
    };
  }

  // Claude narrates the pre-computed intel
  const client = getAnthropicClient();
  const prompt = buildWeeklyDigestPrompt(intel);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: WEEKLY_DIGEST_MAX_TOKENS,
    temperature: 0.5,
    messages: [{ role: "user", content: prompt }],
  });

  const narrative = response.content[0]?.type === "text" ? response.content[0].text : "";
  const tokens = response.usage.input_tokens + response.usage.output_tokens;

  // Write to vault (non-fatal)
  const vaultPath = writeDigestToVault(intel, narrative);

  return { intel, narrative, tokens, vault_path: vaultPath };
}

// ─── Gather Intel ────────────────────────────────

async function gatherWeeklyIntel(weekStart: string, weekEnd: string): Promise<WeeklyIntel> {
  const db = getSupabaseAdmin();

  // Baselines: 30 days back from week start
  const baseline30d = new Date(new Date(weekStart).getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const prevWeekStart = new Date(new Date(weekStart).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const prevWeekEnd = new Date(new Date(weekEnd).getTime() - 7 * 86400000).toISOString().slice(0, 10);

  const [
    tensions,
    decisions,
    decisionCounts,
    people,
    loops,
    meetingCounts,
    atomCount,
  ] = await Promise.all([
    computeTensionTrends(db, weekStart, weekEnd, prevWeekStart, prevWeekEnd),
    getTopDecisions(db, weekStart, weekEnd),
    getDecisionVelocity(db, weekStart, weekEnd, baseline30d),
    computePeopleShifts(db, weekStart, weekEnd, baseline30d),
    computeLoopStats(db, weekStart, weekEnd),
    getMeetingCounts(db, weekStart, weekEnd, baseline30d),
    getAtomCount(db, weekStart, weekEnd),
  ]);

  const weekNum = getISOWeek(new Date(weekStart));
  const year = new Date(weekStart).getFullYear();
  const weekLabel = `Week ${weekNum} (${formatDate(weekStart)} – ${formatDate(weekEnd)})`;

  return {
    week_label: weekLabel,
    week_start: weekStart,
    week_end: weekEnd,
    meeting_count: meetingCounts.this_week,
    meeting_avg_30d: meetingCounts.weekly_avg,
    atom_count: atomCount,
    tensions,
    decisions,
    decision_count: decisionCounts.this_week,
    decision_avg_30d: decisionCounts.weekly_avg,
    people,
    loops,
  };
}

// ─── Tension Trends ──────────────────────────────

async function computeTensionTrends(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
  prevWeekStart: string,
  prevWeekEnd: string,
): Promise<TensionTrend[]> {
  // Get this week + previous week transcripts with meta_relationships
  const { data: txRows } = await db
    .from("dx_transcripts")
    .select("source_date, meta_relationships, participants")
    .gte("source_date", prevWeekStart)
    .lte("source_date", weekEnd)
    .not("meta_relationships", "is", null);

  if (!txRows?.length) return [];

  const thisWeek = new Map<string, { count: number; people: string[]; last_date: string }>();
  const prevWeek = new Map<string, number>();

  for (const tx of txRows) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.tension_slugs?.length) continue;

    const isThisWeek = tx.source_date >= weekStart && tx.source_date <= weekEnd;
    const isPrevWeek = tx.source_date >= prevWeekStart && tx.source_date <= prevWeekEnd;

    const people = (tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null)
      ?.filter((p) => !p.is_owner && !p.email?.includes("@resource.calendar.google.com"))
      .map((p) => p.name) ?? [];

    for (const slug of rel.tension_slugs) {
      if (isThisWeek) {
        const existing = thisWeek.get(slug);
        if (existing) {
          existing.count++;
          if (tx.source_date > existing.last_date) existing.last_date = tx.source_date;
          for (const p of people) {
            if (!existing.people.includes(p)) existing.people.push(p);
          }
        } else {
          thisWeek.set(slug, { count: 1, people: [...people], last_date: tx.source_date });
        }
      }
      if (isPrevWeek) {
        prevWeek.set(slug, (prevWeek.get(slug) ?? 0) + 1);
      }
    }
  }

  const results: TensionTrend[] = [];
  for (const [slug, data] of thisWeek) {
    const prevCount = prevWeek.get(slug) ?? 0;
    let trend: TensionTrend["trend"];
    if (prevCount === 0) trend = "new";
    else if (data.count > prevCount) trend = "rising";
    else if (data.count < prevCount) trend = "fading";
    else trend = "steady";

    results.push({
      slug,
      readable: slugToReadable(slug),
      count_this_week: data.count,
      count_prev_week: prevCount,
      trend,
      people: data.people,
      last_date: data.last_date,
    });
  }

  return results
    .sort((a, b) => b.count_this_week - a.count_this_week)
    .slice(0, 10);
}

// ─── Decision Velocity ───────────────────────────

async function getTopDecisions(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
): Promise<DecisionSummary[]> {
  const { data: atoms } = await db
    .from("dx_atoms")
    .select("content, source_date, source_title, transcript_id")
    .eq("type", "decision")
    .gte("source_date", weekStart)
    .lte("source_date", weekEnd)
    .eq("archived", false)
    .order("source_date", { ascending: false })
    .limit(15);

  if (!atoms?.length) return [];

  // Fetch participant lists for attendee context
  const txIds = [...new Set(atoms.map((a) => a.transcript_id).filter(Boolean))];
  const { data: txRows } = txIds.length
    ? await db.from("dx_transcripts").select("id, participants").in("id", txIds)
    : { data: [] };

  const participantsByTx = new Map<string, string[]>();
  for (const tx of txRows ?? []) {
    const names = (tx.participants as Array<{ name: string; is_owner: boolean }> | null)
      ?.filter((p) => !p.is_owner)
      .map((p) => p.name) ?? [];
    participantsByTx.set(tx.id, names);
  }

  return atoms.map((a) => {
    const c = a.content as DecisionContent;
    return {
      statement: c.statement,
      made_by: c.made_by,
      date: a.source_date,
      meeting: a.source_title ?? "Unknown",
      attendees: a.transcript_id ? participantsByTx.get(a.transcript_id) ?? [] : [],
    };
  });
}

async function getDecisionVelocity(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
  baseline30d: string,
): Promise<{ this_week: number; weekly_avg: number }> {
  const { count: thisWeekCount } = await db
    .from("dx_atoms")
    .select("*", { count: "exact", head: true })
    .eq("type", "decision")
    .gte("source_date", weekStart)
    .lte("source_date", weekEnd)
    .eq("archived", false);

  const { count: baselineCount } = await db
    .from("dx_atoms")
    .select("*", { count: "exact", head: true })
    .eq("type", "decision")
    .gte("source_date", baseline30d)
    .lt("source_date", weekStart)
    .eq("archived", false);

  // ~4.3 weeks in 30 days
  const weeks = Math.max(1, Math.round((new Date(weekStart).getTime() - new Date(baseline30d).getTime()) / (7 * 86400000)));
  return {
    this_week: thisWeekCount ?? 0,
    weekly_avg: Math.round((baselineCount ?? 0) / weeks),
  };
}

// ─── People Shifts ───────────────────────────────

async function computePeopleShifts(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
  baseline30d: string,
): Promise<PersonShift[]> {
  const { data: txRows } = await db
    .from("dx_transcripts")
    .select("source_date, participants")
    .gte("source_date", baseline30d)
    .lte("source_date", weekEnd)
    .not("participants", "is", null);

  if (!txRows?.length) return [];

  // Count meetings per person per week bucket
  const thisWeekByEmail = new Map<string, { name: string; email: string; count: number; last_seen: string }>();
  const baselineByEmail = new Map<string, number>();

  for (const tx of txRows) {
    const people = tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null;
    if (!people) continue;

    const isThisWeek = tx.source_date >= weekStart && tx.source_date <= weekEnd;

    for (const p of people) {
      if (p.is_owner) continue;

      if (isThisWeek) {
        const existing = thisWeekByEmail.get(p.email);
        if (existing) {
          existing.count++;
          if (tx.source_date > existing.last_seen) existing.last_seen = tx.source_date;
        } else {
          thisWeekByEmail.set(p.email, { name: p.name, email: p.email, count: 1, last_seen: tx.source_date });
        }
      } else {
        baselineByEmail.set(p.email, (baselineByEmail.get(p.email) ?? 0) + 1);
      }
    }
  }

  const weeks = Math.max(1, Math.round((new Date(weekStart).getTime() - new Date(baseline30d).getTime()) / (7 * 86400000)));

  const results: PersonShift[] = [];
  for (const [email, data] of thisWeekByEmail) {
    const baselineTotal = baselineByEmail.get(email) ?? 0;
    const weeklyAvg = Math.round((baselineTotal / weeks) * 10) / 10;

    let shift: PersonShift["shift"];
    if (baselineTotal === 0) shift = "new";
    else if (data.count >= weeklyAvg * 1.5) shift = "surging";
    else if (data.count <= weeklyAvg * 0.5 && weeklyAvg >= 2) shift = "dropping";
    else shift = "steady";

    results.push({
      name: data.name,
      email: data.email,
      meetings_this_week: data.count,
      weekly_avg_30d: weeklyAvg,
      shift,
      last_seen: data.last_seen,
    });
  }

  return results
    .sort((a, b) => b.meetings_this_week - a.meetings_this_week)
    .slice(0, 15);
}

// ─── Loop Stats ──────────────────────────────────

async function computeLoopStats(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
): Promise<LoopStats> {
  // Loops opened this week
  const { data: thisWeekTx } = await db
    .from("dx_transcripts")
    .select("meta_relationships")
    .gte("source_date", weekStart)
    .lte("source_date", weekEnd)
    .not("meta_relationships", "is", null);

  let openedThisWeek = 0;
  const ownerCounts = new Map<string, number>();

  for (const tx of thisWeekTx ?? []) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.loops_opened) continue;
    openedThisWeek += rel.loops_opened.length;
    for (const loop of rel.loops_opened) {
      const owner = loop.owner.toLowerCase();
      ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    }
  }

  // Total open loops (all time, rough count from recent 30 days)
  const thirtyDaysAgo = new Date(new Date(weekEnd).getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const { data: allRecentTx } = await db
    .from("dx_transcripts")
    .select("meta_relationships")
    .gte("source_date", thirtyDaysAgo)
    .not("meta_relationships", "is", null);

  let totalOpen = 0;
  for (const tx of allRecentTx ?? []) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    totalOpen += rel?.loops_opened?.length ?? 0;
  }

  return {
    opened_this_week: openedThisWeek,
    total_open: totalOpen,
    owners_with_most: [...ownerCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([owner, count]) => ({ owner, count })),
  };
}

// ─── Meeting Counts ──────────────────────────────

async function getMeetingCounts(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
  baseline30d: string,
): Promise<{ this_week: number; weekly_avg: number }> {
  const { count: thisWeekCount } = await db
    .from("dx_transcripts")
    .select("*", { count: "exact", head: true })
    .gte("source_date", weekStart)
    .lte("source_date", weekEnd);

  const { count: baselineCount } = await db
    .from("dx_transcripts")
    .select("*", { count: "exact", head: true })
    .gte("source_date", baseline30d)
    .lt("source_date", weekStart);

  const weeks = Math.max(1, Math.round((new Date(weekStart).getTime() - new Date(baseline30d).getTime()) / (7 * 86400000)));
  return {
    this_week: thisWeekCount ?? 0,
    weekly_avg: Math.round((baselineCount ?? 0) / weeks),
  };
}

async function getAtomCount(
  db: ReturnType<typeof getSupabaseAdmin>,
  weekStart: string,
  weekEnd: string,
): Promise<number> {
  const { count } = await db
    .from("dx_atoms")
    .select("*", { count: "exact", head: true })
    .gte("source_date", weekStart)
    .lte("source_date", weekEnd)
    .eq("archived", false);

  return count ?? 0;
}

// ─── Vault Output ────────────────────────────────

function writeDigestToVault(intel: WeeklyIntel, narrative: string): string | null {
  try {
    const { writeFileSync, existsSync, mkdirSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const { homedir } = require("os") as typeof import("os");

    const vaultRoot = join(homedir(), "Documents/Obsidian/Studio");
    if (!existsSync(vaultRoot)) return null;

    const agentsDir = join(vaultRoot, "70-agents");
    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

    const weekNum = getISOWeek(new Date(intel.week_start));
    const year = new Date(intel.week_start).getFullYear();
    const filename = `weekly-digest-${year}-W${String(weekNum).padStart(2, "0")}.md`;
    const filePath = join(agentsDir, filename);

    const lines: string[] = [
      "---",
      "grain_managed: true",
      "type: weekly-digest",
      `week: ${year}-W${String(weekNum).padStart(2, "0")}`,
      `date_range: ${intel.week_start} to ${intel.week_end}`,
      `meetings: ${intel.meeting_count}`,
      `atoms: ${intel.atom_count}`,
      `decisions: ${intel.decision_count}`,
      `tensions: ${intel.tensions.length}`,
      "---",
      "",
      `# ${intel.week_label}`,
      "",
      narrative,
    ];

    writeFileSync(filePath, lines.join("\n"), "utf-8");
    return filePath;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────

function slugToReadable(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\bvs\b/g, "Vs.")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Batch (for backfill) ────────────────────────

export async function generateWeeklyDigestsBatch(
  since: string,
  until: string,
): Promise<WeeklyDigestResult[]> {
  const weeks = getWeekRanges(since, until);
  const results: WeeklyDigestResult[] = [];

  for (const { start, end } of weeks) {
    try {
      const result = await generateWeeklyDigest(start, end);
      results.push(result);
    } catch (err) {
      console.error(`Weekly digest failed for ${start}:`, err);
    }
  }

  return results;
}

function getWeekRanges(since: string, until: string): Array<{ start: string; end: string }> {
  const ranges: Array<{ start: string; end: string }> = [];
  const sinceDate = new Date(since);
  const untilDate = new Date(until);

  const current = new Date(sinceDate);
  const day = current.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  current.setDate(current.getDate() + diff);

  while (current <= untilDate) {
    const weekStart = current.toISOString().split("T")[0];
    const weekEndDate = new Date(current);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEnd = weekEndDate.toISOString().split("T")[0];
    ranges.push({ start: weekStart, end: weekEnd });
    current.setDate(current.getDate() + 7);
  }

  return ranges;
}
