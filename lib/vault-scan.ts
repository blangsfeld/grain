/**
 * Boot context generator.
 *
 * Queries the DB for recent tensions, decisions, loops, and people,
 * then writes a pre-computed summary to 70-agents/boot-context.md.
 *
 * Called at the end of every ingest. Claude reads this file at /boot
 * so every session starts context-aware without runtime scanning.
 *
 * Identity comes from participants (calendar roster), not from model
 * extraction. No slug reconciliation, no entity files, no ambiguity.
 */

import { writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { DecisionContent, RelationshipsPayload } from "@/types/atoms";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const AGENTS_DIR = join(VAULT_ROOT, "70-agents");
const BOOT_CONTEXT_PATH = join(AGENTS_DIR, "boot-context.md");
const BOOT_CONTEXT_TMP = join(AGENTS_DIR, ".boot-context.md.tmp");

function vaultAvailable(): boolean {
  return existsSync(VAULT_ROOT);
}

// ─── Inner circle (loop relevance filter) ─────────
// Loops owned by these people surface in the boot context.
// Everyone else's loops are in the DB but not in the briefing.
const INNER_CIRCLE = [
  "ryan",      // Ryan Honey — CEO
  "madison",   // Madison Wharton — COO
  "wade",      // Wade Milne — CFO
  "orion",     // Orion Tait — Creative Chair
  "jan",       // Jan Jensen
  "daniell",   // Daniell Phillips
  "cole",      // Cole Hammack
  "nick",      // Nick Carmen
  "jose",      // Jose
  "emily",     // Emily Rickard
  "julian",    // Julian McBride
];

// ─── Main ─────────────────────────────────────────

export async function buildBootContext(): Promise<void> {
  if (!vaultAvailable()) return;
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });

  const db = getSupabaseAdmin();
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

  const [tensions, decisions, people, loops] = await Promise.all([
    getTopTensions(db, fourteenDaysAgo),
    getRecentDecisions(db, fourteenDaysAgo),
    getActivePeople(db, sevenDaysAgo),
    getOpenLoops(db, fourteenDaysAgo),
  ]);

  const lines: string[] = [];

  lines.push("---");
  lines.push("grain_managed: true");
  lines.push("type: boot-context");
  lines.push(`generated_at: ${now.toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  lines.push("---");
  lines.push("");

  // Tensions — sourced from meta_relationships.tension_slugs (tuned prompt)
  lines.push("## Active Tensions");
  if (tensions.length === 0) {
    lines.push("_none_");
  } else {
    for (const t of tensions) {
      // Convert kebab-slug to readable: "centralization-vs-autonomy" → "Centralization vs Autonomy"
      const readable = t.slug.replace(/-/g, " ").replace(/\bvs\b/g, "vs.").replace(/\b\w/g, (c) => c.toUpperCase());
      const peopleNote = t.people.length ? ` — present: ${t.people.slice(0, 5).join(", ")}${t.people.length > 5 ? ` +${t.people.length - 5}` : ""}` : "";
      lines.push(`- **${readable}** — ${t.count}× in 14 days, last: ${t.last_date}${peopleNote}`);
    }
  }
  lines.push("");

  // Decisions
  lines.push("## Recent Decisions");
  if (decisions.length === 0) {
    lines.push("_none_");
  } else {
    for (const d of decisions) {
      const who = d.made_by || "unattributed";
      const attendees = d.attendees.length ? ` — attendees: ${d.attendees.join(", ")}` : "";
      lines.push(`- **${d.statement}** (${d.date}, ${who})${attendees}`);
    }
  }
  lines.push("");

  // People
  lines.push("## People in Motion");
  if (people.length === 0) {
    lines.push("_none_");
  } else {
    for (const p of people) {
      lines.push(`- **${p.name}** <${p.email}> — ${p.meeting_count} meetings in 7 days, last: ${p.last_seen}`);
    }
  }
  lines.push("");

  // Loops
  lines.push("## Open Commitments");
  if (loops.length === 0) {
    lines.push("_none_");
  } else {
    for (const l of loops) {
      const deadline = l.deadline ? `, deadline: ${l.deadline}` : "";
      lines.push(`- **${l.statement}** — owner: ${l.owner}${deadline} (opened: ${l.date})`);
    }
  }
  lines.push("");

  // Atomic write
  const content = lines.join("\n");
  writeFileSync(BOOT_CONTEXT_TMP, content, "utf-8");
  renameSync(BOOT_CONTEXT_TMP, BOOT_CONTEXT_PATH);
}

// ─── Queries ──────────────────────────────────────

interface TensionSummary {
  slug: string;
  count: number;
  last_date: string;
  people: string[];
}

async function getTopTensions(
  db: ReturnType<typeof getSupabaseAdmin>,
  since: string,
): Promise<TensionSummary[]> {
  // Source: meta_relationships.tension_slugs — already extracted with the
  // tuned relationships prompt, not the legacy tension atom pass.
  // These are kebab-case slugs aggregated by mention count across meetings.
  const { data: txRows } = await db
    .from("dx_transcripts")
    .select("source_date, meta_relationships, participants")
    .gte("source_date", since)
    .not("meta_relationships", "is", null)
    .order("source_date", { ascending: false });

  if (!txRows?.length) return [];

  const bySlug = new Map<string, TensionSummary>();

  for (const tx of txRows) {
    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.tension_slugs?.length) continue;

    const people = (tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null)
      ?.filter((p) => !p.is_owner && !p.email?.includes("@resource.calendar.google.com"))
      .map((p) => p.name) ?? [];

    for (const slug of rel.tension_slugs) {
      const existing = bySlug.get(slug);
      if (existing) {
        existing.count++;
        if (tx.source_date > existing.last_date) existing.last_date = tx.source_date;
        for (const p of people) {
          if (!existing.people.includes(p)) existing.people.push(p);
        }
      } else {
        bySlug.set(slug, {
          slug,
          count: 1,
          last_date: tx.source_date,
          people: [...people],
        });
      }
    }
  }

  return [...bySlug.values()]
    .sort((a, b) => b.count - a.count || (a.last_date < b.last_date ? 1 : -1))
    .slice(0, 7);
}

interface DecisionSummary {
  statement: string;
  date: string;
  made_by: string | null;
  attendees: string[];
}

async function getRecentDecisions(
  db: ReturnType<typeof getSupabaseAdmin>,
  since: string,
): Promise<DecisionSummary[]> {
  const { data: atoms } = await db
    .from("dx_atoms")
    .select("content, source_date, transcript_id")
    .eq("type", "decision")
    .gte("source_date", since)
    .eq("archived", false)
    .order("source_date", { ascending: false })
    .limit(10);

  if (!atoms?.length) return [];

  const txIds = [...new Set(atoms.map((a) => a.transcript_id).filter(Boolean))];
  const { data: txRows } = await db
    .from("dx_transcripts")
    .select("id, participants")
    .in("id", txIds);

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
      date: a.source_date,
      made_by: c.made_by,
      attendees: a.transcript_id ? participantsByTx.get(a.transcript_id) ?? [] : [],
    };
  });
}

interface PersonSummary {
  name: string;
  email: string;
  meeting_count: number;
  last_seen: string;
}

async function getActivePeople(
  db: ReturnType<typeof getSupabaseAdmin>,
  since: string,
): Promise<PersonSummary[]> {
  // Query transcripts with participants in the last 7 days
  const { data: txRows } = await db
    .from("dx_transcripts")
    .select("source_date, participants")
    .gte("source_date", since)
    .not("participants", "is", null);

  if (!txRows?.length) return [];

  // Count meetings per person (by email)
  const byEmail = new Map<string, PersonSummary>();
  for (const tx of txRows) {
    const people = tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null;
    if (!people) continue;
    for (const p of people) {
      if (p.is_owner) continue; // skip self
      const existing = byEmail.get(p.email);
      if (existing) {
        existing.meeting_count++;
        if (tx.source_date > existing.last_seen) existing.last_seen = tx.source_date;
      } else {
        byEmail.set(p.email, {
          name: p.name,
          email: p.email,
          meeting_count: 1,
          last_seen: tx.source_date,
        });
      }
    }
  }

  return [...byEmail.values()]
    .filter((p) => p.meeting_count >= 2) // only people in 2+ meetings
    .sort((a, b) => b.meeting_count - a.meeting_count || (a.last_seen < b.last_seen ? 1 : -1))
    .slice(0, 15);
}

interface LoopSummary {
  statement: string;
  owner: string;
  deadline: string | null;
  date: string;
}

async function getOpenLoops(
  db: ReturnType<typeof getSupabaseAdmin>,
  since: string,
): Promise<LoopSummary[]> {
  // Loops come from meta_relationships.loops_opened.
  // Only include loops from meetings where the observer was present
  // (has is_owner: true in participants). This filters out workshop
  // scheduling, other people's internal tasks, etc.
  const { data: txRows } = await db
    .from("dx_transcripts")
    .select("source_date, meta_relationships, participants")
    .gte("source_date", since)
    .not("meta_relationships", "is", null)
    .not("participants", "is", null)
    .order("source_date", { ascending: false });

  if (!txRows?.length) return [];

  const loops: LoopSummary[] = [];
  const seen = new Set<string>();

  for (const tx of txRows) {
    // Only include loops from meetings the observer attended
    const participants = tx.participants as Array<{ name: string; email: string; is_owner: boolean }> | null;
    const observerPresent = participants?.some((p) => p.is_owner);
    if (!observerPresent) continue;

    const rel = tx.meta_relationships as RelationshipsPayload | null;
    if (!rel?.loops_opened) continue;
    for (const loop of rel.loops_opened) {
      // Relevance filter: only surface loops the observer would track.
      //   - Owner is the observer (Ben) → always relevant
      //   - Loop has a deadline → someone committed to a date, track it
      //   - Owner is in the observer's inner circle → relevant
      // Everything else (workshop scheduling, other people's internal
      // tasks, aspirational "we should" statements) → skip.
      const ownerLower = loop.owner.toLowerCase();
      const isSelf = ownerLower === "ben" || ownerLower.includes("ben ");
      const hasDeadline = !!loop.deadline;
      const isInnerCircle = INNER_CIRCLE.some((name) => ownerLower.includes(name));

      if (!isSelf && !hasDeadline && !isInnerCircle) continue;

      // Dedup by first 50 chars of statement
      const key = loop.statement.slice(0, 50).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      loops.push({
        statement: loop.statement,
        owner: loop.owner,
        deadline: loop.deadline,
        date: tx.source_date,
      });
    }
  }

  return loops.slice(0, 15);
}
