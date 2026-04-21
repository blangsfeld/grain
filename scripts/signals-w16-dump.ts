/**
 * One-shot dump for W16 (2026-04-13 – 2026-04-19) signals hand-craft.
 *
 * Pulls atoms + transcripts for the target week, plus an 8-week baseline
 * for self-variance comparison. Writes a single JSON blob to stdout for
 * review.
 */

import { config as loadDotenv } from "dotenv";
import { join } from "path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { getSupabaseAdmin } from "@/lib/supabase";
import type { RelationshipsPayload } from "@/types/atoms";

const WEEK_START = "2026-04-13";
const WEEK_END = "2026-04-19";
const BASELINE_START = "2026-02-16"; // 8 weeks prior to week start

async function main() {
  const db = getSupabaseAdmin();

  // Transcripts for the week — participants, titles, meta_relationships
  const { data: weekTx } = await db
    .from("dx_transcripts")
    .select("id, source_title, source_date, participants, meta_relationships")
    .gte("source_date", WEEK_START)
    .lte("source_date", WEEK_END)
    .order("source_date");

  // Atoms for the week — all types
  const { data: weekAtoms } = await db
    .from("dx_atoms")
    .select("id, type, content, source_date, source_title, transcript_id, entities, domain")
    .gte("source_date", WEEK_START)
    .lte("source_date", WEEK_END)
    .eq("archived", false)
    .order("source_date");

  // Baseline transcripts — just tension_slugs + dates, to compute self-variance
  const { data: baselineTx } = await db
    .from("dx_transcripts")
    .select("source_date, meta_relationships")
    .gte("source_date", BASELINE_START)
    .lt("source_date", WEEK_START)
    .not("meta_relationships", "is", null);

  // Baseline atoms — types and source_dates only for now
  const { data: baselineAtomsRaw } = await db
    .from("dx_atoms")
    .select("type, source_date, source_title, entities, domain")
    .gte("source_date", BASELINE_START)
    .lt("source_date", WEEK_START)
    .eq("archived", false)
    .limit(10000);

  // Aggregate baseline tensions
  const baselineTensions = new Map<string, { count: number; weeks: Set<string>; last_date: string }>();
  for (const tx of baselineTx ?? []) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.tension_slugs?.length) continue;
    const weekKey = isoWeek(tx.source_date);
    for (const slug of rel.tension_slugs) {
      const existing = baselineTensions.get(slug);
      if (existing) {
        existing.count++;
        existing.weeks.add(weekKey);
        if (tx.source_date > existing.last_date) existing.last_date = tx.source_date;
      } else {
        baselineTensions.set(slug, {
          count: 1,
          weeks: new Set([weekKey]),
          last_date: tx.source_date,
        });
      }
    }
  }

  // Baseline atom counts by type
  const baselineAtomCounts = new Map<string, number>();
  for (const a of baselineAtomsRaw ?? []) {
    baselineAtomCounts.set(a.type, (baselineAtomCounts.get(a.type) ?? 0) + 1);
  }

  // Week tensions
  const weekTensions = new Map<string, { count: number; meetings: string[]; people: Set<string> }>();
  for (const tx of weekTx ?? []) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.tension_slugs?.length) continue;
    const people = (tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null)
      ?.filter((p) => !p.is_owner && !p.email?.includes("@resource.calendar.google.com"))
      .map((p) => p.name) ?? [];
    for (const slug of rel.tension_slugs) {
      const existing = weekTensions.get(slug);
      if (existing) {
        existing.count++;
        existing.meetings.push(tx.source_title ?? "untitled");
        for (const p of people) existing.people.add(p);
      } else {
        weekTensions.set(slug, {
          count: 1,
          meetings: [tx.source_title ?? "untitled"],
          people: new Set(people),
        });
      }
    }
  }

  // Week atom types summary
  const weekAtomCounts = new Map<string, number>();
  for (const a of weekAtoms ?? []) {
    weekAtomCounts.set(a.type, (weekAtomCounts.get(a.type) ?? 0) + 1);
  }

  // Week loops
  const weekLoops: Array<{ statement: string; owner: string; deadline: string | null; meeting: string; date: string }> = [];
  for (const tx of weekTx ?? []) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.loops_opened?.length) continue;
    for (const loop of rel.loops_opened) {
      weekLoops.push({
        statement: loop.statement,
        owner: loop.owner,
        deadline: loop.deadline,
        meeting: tx.source_title ?? "untitled",
        date: tx.source_date,
      });
    }
  }

  // Week people
  const weekPeople = new Map<string, { count: number; last_date: string; meetings: string[] }>();
  for (const tx of weekTx ?? []) {
    const people = tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null;
    if (!people) continue;
    for (const p of people) {
      if (p.is_owner) continue;
      if (p.email?.includes("@resource.calendar.google.com")) continue;
      const existing = weekPeople.get(p.name);
      if (existing) {
        existing.count++;
        if (tx.source_date > existing.last_date) existing.last_date = tx.source_date;
        existing.meetings.push(tx.source_title ?? "untitled");
      } else {
        weekPeople.set(p.name, {
          count: 1,
          last_date: tx.source_date,
          meetings: [tx.source_title ?? "untitled"],
        });
      }
    }
  }

  // Output
  const output = {
    week: `${WEEK_START} to ${WEEK_END}`,
    meetings: weekTx?.length ?? 0,
    atoms: weekAtoms?.length ?? 0,
    atom_types: Object.fromEntries(weekAtomCounts),
    baseline_atom_types: Object.fromEntries(baselineAtomCounts),
    meeting_list: (weekTx ?? []).map((tx) => ({
      date: tx.source_date,
      title: tx.source_title,
      people: (tx.participants as Array<{ name: string; is_owner: boolean }> | null)
        ?.filter((p) => !p.is_owner)
        .map((p) => p.name) ?? [],
    })),
    tensions_this_week: [...weekTensions.entries()]
      .sort(([, a], [, b]) => b.count - a.count)
      .map(([slug, data]) => {
        const baseline = baselineTensions.get(slug);
        return {
          slug,
          count: data.count,
          people: [...data.people],
          meetings: data.meetings,
          baseline_total: baseline?.count ?? 0,
          baseline_weeks_active: baseline?.weeks.size ?? 0,
          baseline_last_date: baseline?.last_date ?? null,
          status: !baseline
            ? "new"
            : baseline.weeks.size >= 6
              ? "recurring"
              : baseline.weeks.size >= 3
                ? "returning"
                : "sparse",
        };
      }),
    tensions_dormant: [...baselineTensions.entries()]
      .filter(([slug, data]) => !weekTensions.has(slug) && data.weeks.size >= 4)
      .map(([slug, data]) => ({
        slug,
        baseline_weeks_active: data.weeks.size,
        baseline_total: data.count,
        last_date: data.last_date,
        weeks_silent: weeksBetween(data.last_date, WEEK_START),
      }))
      .sort((a, b) => b.baseline_weeks_active - a.baseline_weeks_active)
      .slice(0, 15),
    loops_opened: weekLoops,
    people: [...weekPeople.entries()]
      .map(([name, data]) => ({ name, ...data, meetings: [...new Set(data.meetings)] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    atoms_full: (weekAtoms ?? []).map((a) => ({
      id: a.id,
      type: a.type,
      source_date: a.source_date,
      source_title: a.source_title,
      entities: a.entities,
      domain: a.domain,
      content: a.content,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

function isoWeek(date: string): string {
  const d = new Date(date);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function weeksBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / (7 * 86400000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
