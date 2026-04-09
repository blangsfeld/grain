/**
 * Briefing Context Assembly
 *
 * Two modes: Monday exec prep + Tue-Fri daily.
 * Powered by atom corpus instead of static portraits.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { listCalendarEvents, listGmailThreads } from "@/lib/google";
import { loadRegistries, matchContact, matchDomain } from "@/lib/resolve";
import { queryAtoms } from "@/lib/atom-db";
import { gatherBuildIntel } from "@/lib/build-intel";
import { gatherIndustryEdge } from "@/lib/industry-edge";
import type { DxAtom, AtomType } from "@/types/atoms";
import type { GoogleCalendarEvent, GmailThread } from "@/types/google";
import type { DxContact, DxDomain } from "@/types/entities";

// ─── Types ──────────────────────────────────────

export type BriefingMode = "monday" | "daily";

export interface MeetingIntel {
  event: GoogleCalendarEvent;
  matchedContacts: DxContact[];
  matchedDomain: DxDomain | null;
  recentAtoms: DxAtom[];          // Last 30 days for this domain
  activeTensions: DxAtom[];       // Tensions for this domain
  openCommitments: DxAtom[];      // Commitments involving matched contacts
  voiceAtoms: DxAtom[];           // Relevant voice atoms
}

export interface CommitmentAudit {
  overdue: DxAtom[];              // Past due_date
  dueSoon: DxAtom[];              // Due within 7 days
  blocked: DxAtom[];              // Ben's commitments needing exec input
  crossCompany: DxAtom[];         // Involve multiple domains
}

export interface ExecAnticipation {
  exec: string;
  role: string;
  relevantAtoms: DxAtom[];        // Atoms matching what this exec cares about
}

export interface BriefingContext {
  mode: BriefingMode;
  date: string;
  dayOfWeek: string;
  events: MeetingIntel[];
  emailThreads: GmailThread[];
  buildIntel: string | null;
  industryEdge: string | null;

  // Monday-only
  weekInReview?: Record<string, DxAtom[]>;   // Atoms by domain, past 7 days
  commitmentAudit?: CommitmentAudit;
  execAnticipation?: ExecAnticipation[];
  weeklyDigestThemes?: string | null;        // Latest weekly digest content
}

// ─── Main Assembly ──────────────────────────────

export async function assembleBriefingContext(mode?: BriefingMode): Promise<BriefingContext> {
  const now = new Date();
  const isMonday = mode === "monday" || (!mode && now.getDay() === 1);
  const briefingMode: BriefingMode = isMonday ? "monday" : "daily";

  const today = now.toISOString().split("T")[0];
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });

  // Time window for today's calendar
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);

  // Parallel fetches
  const [
    { contacts, domains },
    events,
    emailThreads,
    buildIntel,
    industryEdge,
  ] = await Promise.all([
    loadRegistries(),
    listCalendarEvents("primary", dayStart.toISOString(), dayEnd.toISOString()).catch(() => []),
    listGmailThreads("in:inbox newer_than:1d", 10).catch(() => []),
    gatherBuildIntel(isMonday ? 7 : 1).catch(() => null),
    gatherIndustryEdge().catch(() => null),
  ]);

  // Filter to non-all-day events
  const timedEvents = events.filter((e) => !e.all_day);

  // Build meeting intel
  const meetingIntels = await Promise.all(
    timedEvents.map((event) => buildMeetingIntel(event, contacts, domains, today))
  );

  const context: BriefingContext = {
    mode: briefingMode,
    date: today,
    dayOfWeek,
    events: meetingIntels,
    emailThreads,
    buildIntel,
    industryEdge,
  };

  // Monday-only: additional context
  if (isMonday) {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000).toISOString().split("T")[0];

    const [weekAtoms, recentCommitments, weeklyDigest] = await Promise.all([
      queryAtoms({ since: sevenDaysAgo, archived: false, limit: 500 }),
      queryAtoms({ type: "commitment", since: fourteenDaysAgo, archived: false, limit: 200 }),
      fetchLatestWeeklyDigest(),
    ]);

    // Group week atoms by domain
    const weekByDomain: Record<string, DxAtom[]> = {};
    for (const atom of weekAtoms) {
      const key = atom.domain ?? "Other";
      if (!weekByDomain[key]) weekByDomain[key] = [];
      weekByDomain[key].push(atom);
    }
    context.weekInReview = weekByDomain;

    // Commitment audit
    context.commitmentAudit = auditCommitments(recentCommitments, today);

    // Exec anticipation
    context.execAnticipation = buildExecAnticipation(weekAtoms);

    // Weekly digest themes
    context.weeklyDigestThemes = weeklyDigest;
  }

  return context;
}

// ─── Meeting Intel ──────────────────────────────

async function buildMeetingIntel(
  event: GoogleCalendarEvent,
  contacts: DxContact[],
  domains: DxDomain[],
  today: string,
): Promise<MeetingIntel> {
  const matchedContacts: DxContact[] = [];
  let matchedDomain: DxDomain | null = null;

  // Match attendees
  for (const attendee of event.attendees) {
    if (attendee.self) continue;

    // Try by name
    const name = attendee.name ?? attendee.email.split("@")[0];
    const contact = matchContact(name, contacts);
    if (contact) {
      matchedContacts.push(contact);
      if (contact.domain_id && !matchedDomain) {
        matchedDomain = domains.find((d) => d.id === contact.domain_id) ?? null;
      }
      continue;
    }

    // Try by email domain
    const emailDomain = attendee.email.split("@")[1];
    if (emailDomain) {
      const domainName = emailDomain.split(".")[0]; // "buck" from "buck.tv"
      const domain = matchDomain(domainName, domains) ?? matchDomain(emailDomain, domains);
      if (domain && !matchedDomain) {
        matchedDomain = domain;
      }
    }
  }

  // Fetch atom intelligence for this meeting's domain
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const domainId = matchedDomain?.id;

  const [recentAtoms, activeTensions, openCommitments, voiceAtoms] = domainId
    ? await Promise.all([
        queryAtoms({ domain_id: domainId, since: thirtyDaysAgo, limit: 15 }),
        queryAtoms({ domain_id: domainId, type: "tension", since: thirtyDaysAgo, limit: 5 }),
        queryAtoms({ domain_id: domainId, type: "commitment", since: thirtyDaysAgo, limit: 10 }),
        queryAtoms({ domain_id: domainId, type: "voice", since: thirtyDaysAgo, limit: 5 }),
      ])
    : [[], [], [], []];

  return {
    event,
    matchedContacts,
    matchedDomain,
    recentAtoms,
    activeTensions,
    openCommitments,
    voiceAtoms,
  };
}

// ─── Commitment Audit ───────────────────────────

function auditCommitments(commitments: DxAtom[], today: string): CommitmentAudit {
  const overdue: DxAtom[] = [];
  const dueSoon: DxAtom[] = [];
  const blocked: DxAtom[] = [];
  const crossCompany: DxAtom[] = [];

  const sevenDaysOut = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

  for (const atom of commitments) {
    const c = atom.content as unknown as Record<string, unknown>;
    const dueDate = c.due_date as string | null;
    const person = c.person as string | null;
    const conviction = c.conviction as string | null;

    // Overdue
    if (dueDate && dueDate < today) {
      overdue.push(atom);
    }

    // Due soon
    if (dueDate && dueDate >= today && dueDate <= sevenDaysOut) {
      dueSoon.push(atom);
    }

    // Ben's commitments that might need exec input (soft/aspirational conviction)
    if (person && (person.toLowerCase().includes("ben") || person.toLowerCase() === "you") &&
        (conviction === "soft" || conviction === "aspirational")) {
      blocked.push(atom);
    }

    // Cross-company (has domain but also references other entities)
    if (atom.entities.length > 1 && atom.domain) {
      crossCompany.push(atom);
    }
  }

  return { overdue, dueSoon, blocked, crossCompany };
}

// ─── Exec Anticipation ──────────────────────────

const EXEC_FOCUS: Array<{ name: string; role: string; types: AtomType[]; keywords: string[] }> = [
  { name: "Ryan Honey", role: "CEO", types: ["belief", "tension"], keywords: ["network", "collaboration", "strategy", "positioning", "growth"] },
  { name: "Wade Milne", role: "CFO", types: ["commitment", "tension"], keywords: ["budget", "resource", "revenue", "margin", "capacity", "cost"] },
  { name: "Madison Wharton", role: "COO", types: ["commitment", "tension"], keywords: ["operations", "process", "team", "hiring", "workflow", "bottleneck"] },
  { name: "Orion Tait", role: "Creative Chair", types: ["belief", "quote", "voice"], keywords: ["creative", "craft", "design", "brand", "vision", "quality"] },
];

function buildExecAnticipation(weekAtoms: DxAtom[]): ExecAnticipation[] {
  return EXEC_FOCUS.map((exec) => {
    const relevant = weekAtoms.filter((atom) => {
      // Match by type
      if (!exec.types.includes(atom.type)) return false;

      // Match by keywords in content
      const contentStr = JSON.stringify(atom.content).toLowerCase();
      return exec.keywords.some((kw) => contentStr.includes(kw));
    });

    return {
      exec: exec.name,
      role: exec.role,
      relevantAtoms: relevant.slice(0, 8),
    };
  });
}

// ─── Weekly Digest Fetch ────────────────────────

async function fetchLatestWeeklyDigest(): Promise<string | null> {
  try {
    const { readFileSync, existsSync, readdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const weeklyDir = join(homedir(), "Documents/Obsidian/Studio/40-patterns/weekly");
    if (!existsSync(weeklyDir)) return null;

    const files = readdirSync(weeklyDir).filter((f) => f.endsWith(".md")).sort().reverse();
    if (files.length === 0) return null;

    return readFileSync(join(weeklyDir, files[0]), "utf-8");
  } catch {
    return null;
  }
}

// ─── Format for Prompt ──────────────────────────

export function formatBriefingContext(ctx: BriefingContext): string {
  const lines: string[] = [];

  lines.push(`DATE: ${ctx.dayOfWeek}, ${ctx.date}`);
  lines.push(`MODE: ${ctx.mode === "monday" ? "Monday Exec Prep" : "Daily Brief"}`);
  lines.push("");

  // Schedule
  lines.push("## SCHEDULE");
  for (const m of ctx.events) {
    const time = m.event.start.includes("T")
      ? new Date(m.event.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "All day";
    const attendeeNames = m.matchedContacts.map((c) => c.canonical_name).join(", ");
    const domain = m.matchedDomain?.canonical_name;
    const meta = [attendeeNames, domain].filter(Boolean).join(" / ");
    lines.push(`${time} — ${m.event.title}${meta ? ` (${meta})` : ""}`);
  }
  lines.push("");

  // Per-meeting intelligence
  const meetingsWithIntel = ctx.events.filter(
    (m) => m.recentAtoms.length > 0 || m.activeTensions.length > 0
  );
  if (meetingsWithIntel.length > 0) {
    lines.push("## INTELLIGENCE PER MEETING");
    for (const m of meetingsWithIntel) {
      lines.push(`### ${m.event.title}`);
      if (m.matchedDomain) lines.push(`Domain: ${m.matchedDomain.canonical_name}`);

      if (m.activeTensions.length > 0) {
        lines.push("Active tensions:");
        for (const t of m.activeTensions) {
          const c = t.content as unknown as Record<string, unknown>;
          lines.push(`  - Says "${c.stated}" / Acts "${c.actual}" (${t.source_date})`);
        }
      }

      if (m.openCommitments.length > 0) {
        lines.push("Open commitments:");
        for (const a of m.openCommitments) {
          const c = a.content as unknown as Record<string, unknown>;
          const due = c.due_date ? ` — by ${c.due_date}` : "";
          lines.push(`  - ${c.person ?? "Someone"}: ${c.statement}${due} (${c.conviction})`);
        }
      }

      if (m.voiceAtoms.length > 0) {
        lines.push("Your language that's worked:");
        for (const v of m.voiceAtoms.slice(0, 3)) {
          const c = v.content as unknown as Record<string, unknown>;
          lines.push(`  - "${c.quote}" — ${c.why_it_works}`);
        }
      }

      // Recent beliefs for context
      const beliefs = m.recentAtoms.filter((a) => a.type === "belief").slice(0, 3);
      if (beliefs.length > 0) {
        lines.push("Active beliefs:");
        for (const b of beliefs) {
          const c = b.content as unknown as Record<string, unknown>;
          lines.push(`  - "${c.statement}" (${c.class}, ${c.confidence})`);
        }
      }

      lines.push("");
    }
  }

  // Email
  if (ctx.emailThreads.length > 0) {
    lines.push("## RECENT EMAIL");
    for (const t of ctx.emailThreads) {
      lines.push(`- ${t.subject} (from: ${t.from})`);
      lines.push(`  ${t.snippet.slice(0, 120)}`);
    }
    lines.push("");
  }

  // Build intel
  if (ctx.buildIntel) {
    lines.push("## BUILD INTEL");
    lines.push(ctx.buildIntel);
    lines.push("");
  }

  // Industry edge
  if (ctx.industryEdge) {
    lines.push("## INDUSTRY EDGE");
    lines.push(ctx.industryEdge);
    lines.push("");
  }

  // Monday-only sections
  if (ctx.mode === "monday") {
    // Week in review
    if (ctx.weekInReview) {
      lines.push("## WEEK IN REVIEW (by domain)");
      const sorted = Object.entries(ctx.weekInReview)
        .sort(([, a], [, b]) => b.length - a.length)
        .slice(0, 8);
      for (const [domain, atoms] of sorted) {
        const typeCounts: Record<string, number> = {};
        for (const a of atoms) typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;
        const counts = Object.entries(typeCounts).map(([t, n]) => `${n} ${t}`).join(", ");
        lines.push(`**${domain}** (${atoms.length} atoms: ${counts})`);

        // Surface top tensions and beliefs for this domain
        const tensions = atoms.filter((a) => a.type === "tension").slice(0, 2);
        for (const t of tensions) {
          const c = t.content as unknown as Record<string, unknown>;
          lines.push(`  Tension: "${c.stated}" vs "${c.actual}"`);
        }
        const reads = atoms.filter((a) => a.type === "read").slice(0, 1);
        for (const r of reads) {
          const c = r.content as unknown as Record<string, unknown>;
          lines.push(`  Read: ${(c.the_read as string)?.slice(0, 200)}`);
        }
      }
      lines.push("");
    }

    // Commitment audit
    if (ctx.commitmentAudit) {
      const ca = ctx.commitmentAudit;
      if (ca.overdue.length > 0 || ca.dueSoon.length > 0 || ca.blocked.length > 0) {
        lines.push("## COMMITMENT AUDIT");

        if (ca.overdue.length > 0) {
          lines.push(`Overdue (${ca.overdue.length}):`);
          for (const a of ca.overdue.slice(0, 5)) {
            const c = a.content as unknown as Record<string, unknown>;
            lines.push(`  - ${c.person ?? "Someone"}: ${c.statement} (due ${c.due_date}, from ${a.source_title})`);
          }
        }

        if (ca.dueSoon.length > 0) {
          lines.push(`Due this week (${ca.dueSoon.length}):`);
          for (const a of ca.dueSoon.slice(0, 5)) {
            const c = a.content as unknown as Record<string, unknown>;
            lines.push(`  - ${c.person ?? "Someone"}: ${c.statement} (due ${c.due_date})`);
          }
        }

        if (ca.blocked.length > 0) {
          lines.push(`Your soft/aspirational commitments (may need exec input):`);
          for (const a of ca.blocked.slice(0, 5)) {
            const c = a.content as unknown as Record<string, unknown>;
            lines.push(`  - ${c.statement} (${c.conviction}, from ${a.source_title})`);
          }
        }

        if (ca.crossCompany.length > 0) {
          lines.push(`Cross-company commitments (${ca.crossCompany.length}):`);
          for (const a of ca.crossCompany.slice(0, 3)) {
            const c = a.content as unknown as Record<string, unknown>;
            lines.push(`  - ${c.statement} (${a.domain}, involves ${a.entities.join(", ")})`);
          }
        }
        lines.push("");
      }
    }

    // Exec anticipation
    if (ctx.execAnticipation) {
      const withContent = ctx.execAnticipation.filter((e) => e.relevantAtoms.length > 0);
      if (withContent.length > 0) {
        lines.push("## EXEC ANTICIPATION");
        for (const exec of withContent) {
          lines.push(`**${exec.exec}** (${exec.role}) — ${exec.relevantAtoms.length} relevant atoms this week`);
          for (const a of exec.relevantAtoms.slice(0, 3)) {
            const c = a.content as unknown as Record<string, unknown>;
            const summary = (c.statement ?? c.gap ?? c.text ?? c.the_read ?? JSON.stringify(c)) as string;
            lines.push(`  - [${a.type}] ${typeof summary === "string" ? summary.slice(0, 150) : summary}`);
          }
        }
        lines.push("");
      }
    }

    // Weekly digest themes
    if (ctx.weeklyDigestThemes) {
      lines.push("## WEEKLY DIGEST THEMES (carry forward)");
      // Extract just the themes and tensions sections from the digest
      const themeMatch = ctx.weeklyDigestThemes.match(/## Themes\n([\s\S]*?)(?=\n## |$)/);
      if (themeMatch) lines.push(themeMatch[1].trim());
      const tensionMatch = ctx.weeklyDigestThemes.match(/## Tensions in Play\n([\s\S]*?)(?=\n## |$)/);
      if (tensionMatch) lines.push(tensionMatch[1].trim());
      lines.push("");
    }
  }

  return lines.join("\n");
}
