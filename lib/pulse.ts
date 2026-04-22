/**
 * Vault Pulse — the curator's loop.
 *
 * Twice-weekly (Tue + Fri 16:00 UTC) digest that surfaces the meta-layer
 * your agents are quietly producing. Five items, no more. Fate grammar
 * (promote/park/dismiss) is v2; v1 surfaces the items and lets Ben
 * respond with "add: …" via the existing Buddy flow.
 *
 * Pulse composition:
 *   1. Bruh what-if  — freshest unacted pitch
 *   2. Clark voice   — top quote from latest report
 *   3. Milli wiki    — most recent page triaged in
 *   4. Cross-signal  — Buddy's patterns field, Guy × Dood × Buddy crossings
 *   5. Resurfacing   — atom 30-90d old matching current active-priorities
 */

import { getSupabaseAdmin } from "@/lib/supabase";

interface AgentOutputRow {
  id: string;
  agent_id: string;
  run_at: string;
  markdown: string;
  findings: Record<string, unknown> | null;
}

async function latestOutput(agentId: string): Promise<AgentOutputRow | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("agent_outputs")
    .select("id, agent_id, run_at, markdown, findings")
    .eq("agent_id", agentId)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as unknown as AgentOutputRow) ?? null;
}

function firstBulletBlock(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) =>
    l.trim().match(new RegExp(`^#{1,3}\\s+${heading}`, "i")),
  );
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim() || null;
}

function firstBullet(block: string | null): string | null {
  if (!block) return null;
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) return bullet[1].trim();
    const numbered = line.match(/^\d+\.\s+(.+)/);
    if (numbered) return numbered[1].trim();
  }
  return null;
}

function firstNonEmptyParagraph(block: string | null): string | null {
  if (!block) return null;
  const parts = block.split(/\n\s*\n/);
  for (const p of parts) {
    const cleaned = p.trim();
    if (!cleaned) continue;
    if (cleaned.startsWith("#")) continue;
    return cleaned.replace(/\s+/g, " ");
  }
  return null;
}

function firstSubHeadingBlock(md: string, subheadingPrefix: string): { title: string; body: string } | null {
  // For Bruh — headings like `## 1. Title` where the title IS the pitch.
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${subheadingPrefix}\\.?\\s*(.+)`).test(l));
  if (idx < 0) return null;
  const headingMatch = lines[idx].match(new RegExp(`^#{2,3}\\s+${subheadingPrefix}\\.?\\s*(.+)`));
  const title = headingMatch ? headingMatch[1].trim() : "";
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return { title, body: out.join("\n").trim() };
}

// ── Pulse items ────────────────────────────────────

export interface PulseItem {
  source: "bruh" | "clark" | "milli" | "buddy" | "resurface";
  title: string;
  body: string;
  ref?: string;
}

async function bruhItem(): Promise<PulseItem | null> {
  const out = await latestOutput("what-if");
  if (!out) return null;
  const ageHours = (Date.now() - new Date(out.run_at).getTime()) / 3_600_000;
  if (ageHours > 14 * 24) return null;

  // Bruh writes `## 1. Title` / `## 2. Title` — the first pitch is
  // the title of "## 1." plus the first paragraph after it.
  const pitch = firstSubHeadingBlock(out.markdown, "1");
  if (!pitch) return null;
  const summary = firstNonEmptyParagraph(pitch.body);
  const body = summary
    ? `${pitch.title} — ${summary.slice(0, 300)}`
    : pitch.title;
  if (!body) return null;

  return {
    source: "bruh",
    title: "Bruh · what-if",
    body: body.slice(0, 400),
    ref: out.id,
  };
}

async function clarkItem(): Promise<PulseItem | null> {
  const out = await latestOutput("columnist");
  if (!out) return null;
  const ageHours = (Date.now() - new Date(out.run_at).getTime()) / 3_600_000;
  if (ageHours > 21 * 24) return null;

  const leaderboard = firstBulletBlock(out.markdown, "Voice Leaderboard");
  const firstVoice = firstBullet(leaderboard);
  if (firstVoice) {
    return {
      source: "clark",
      title: "Clark · voice anchor",
      body: firstVoice.slice(0, 400),
      ref: out.id,
    };
  }

  // Fallback: first writing pitch title (### 1. …) if no voice moment.
  const pitch = firstSubHeadingBlock(out.markdown, "1");
  if (pitch) {
    return {
      source: "clark",
      title: "Clark · writing pitch",
      body: pitch.title.slice(0, 400),
      ref: out.id,
    };
  }
  return null;
}

async function milliItem(): Promise<PulseItem | null> {
  const out = await latestOutput("wiki-librarian");
  if (!out) return null;
  const ageHours = (Date.now() - new Date(out.run_at).getTime()) / 3_600_000;
  if (ageHours > 7 * 24) return null;

  // Prefer structured findings (recently promoted paths) when available.
  const findings = (out.findings ?? {}) as { promoted?: unknown };
  const promoted = Array.isArray(findings.promoted) ? (findings.promoted as string[]) : [];
  if (promoted.length > 0) {
    return {
      source: "milli",
      title: "Milli · new patterns shelved",
      body: promoted.slice(0, 3).join(" · "),
      ref: out.id,
    };
  }

  // Fallback: Milli writes Recommendation or Cross-signal sections — pull
  // the first prose paragraph, not frontmatter.
  const rec =
    firstNonEmptyParagraph(firstBulletBlock(out.markdown, "Recommendation")) ??
    firstNonEmptyParagraph(firstBulletBlock(out.markdown, "Cross-signal")) ??
    firstNonEmptyParagraph(firstBulletBlock(out.markdown, "Current state"));
  if (!rec) return null;

  return {
    source: "milli",
    title: "Milli · wiki state",
    body: rec.slice(0, 300),
    ref: out.id,
  };
}

async function buddyPatternItem(): Promise<PulseItem | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("agent_outputs")
    .select("id, agent_id, run_at, markdown, findings")
    .eq("agent_id", "ea")
    .order("run_at", { ascending: false })
    .limit(3);
  if (!data || data.length === 0) return null;

  // Buddy's synthesis output carries a "Patterns" field in findings.
  for (const row of data as unknown as AgentOutputRow[]) {
    const f = (row.findings ?? {}) as { patterns?: unknown };
    const patterns = Array.isArray(f.patterns) ? (f.patterns as unknown[]) : [];
    if (patterns.length > 0) {
      const p = patterns[0];
      const body =
        typeof p === "string"
          ? p
          : typeof p === "object" && p && "statement" in p
          ? String((p as { statement?: unknown }).statement ?? "")
          : "";
      if (body) {
        return {
          source: "buddy",
          title: "Buddy · cross-agent pattern",
          body: body.slice(0, 400),
          ref: row.id,
        };
      }
    }
  }
  return null;
}

async function resurfaceItem(): Promise<PulseItem | null> {
  const sb = getSupabaseAdmin();
  const now = Date.now();
  const windowStart = new Date(now - 90 * 86_400_000).toISOString();
  const windowEnd = new Date(now - 30 * 86_400_000).toISOString();

  // Random-ish pick from voice or belief atoms in the 30-90d window.
  // Ordering by id gives pseudo-random rotation without needing RANDOM().
  const { data } = await sb
    .from("dx_atoms")
    .select("id, type, content, source_title, source_date")
    .in("type", ["voice", "belief"])
    .gte("created_at", windowStart)
    .lte("created_at", windowEnd)
    .order("id", { ascending: false })
    .limit(20);
  if (!data || data.length === 0) return null;

  // Rotate by day-of-year so each pulse picks a different one.
  const dayIdx = Math.floor(now / 86_400_000) % data.length;
  const pick = data[dayIdx] as {
    id: string;
    type: string;
    content: { quote?: string; statement?: string } | null;
    source_title: string | null;
    source_date: string | null;
  };
  const body =
    pick.content?.quote ??
    pick.content?.statement ??
    "(no body)";
  return {
    source: "resurface",
    title: `Resurfacing · ${pick.type} · ${pick.source_date ?? "?"}`,
    body: String(body).slice(0, 400),
    ref: pick.id,
  };
}

// ── Assemble + format ──────────────────────────────

export async function assemblePulse(): Promise<PulseItem[]> {
  const candidates = await Promise.all([
    bruhItem(),
    clarkItem(),
    milliItem(),
    buddyPatternItem(),
    resurfaceItem(),
  ]);
  return candidates.filter((x): x is PulseItem => x !== null);
}

export function formatPulseMessage(items: PulseItem[]): string {
  if (items.length === 0) {
    return "*Vault Pulse*\n\nNothing fresh this cycle. Agents quiet.";
  }
  const lines: string[] = [];
  lines.push("*Vault Pulse* — what your crew has been noticing");
  lines.push("");
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    lines.push(`*${i + 1}. ${it.title}*`);
    lines.push(it.body);
    lines.push("");
  }
  lines.push("_Reply `add: <text>` to promote any of these into your kept list._");
  return lines.join("\n");
}

export interface PulseRunResult {
  sent: boolean;
  items: PulseItem[];
  message: string;
  error?: string;
}

/**
 * Generate + deliver one pulse. Returns what was built and whether
 * Telegram delivery succeeded. Archive to the vault is caller's choice.
 */
export async function runPulse(
  chatId: number,
  sendTelegramReply: (chatId: number, message: string) => Promise<unknown>,
): Promise<PulseRunResult> {
  const items = await assemblePulse();
  const message = formatPulseMessage(items);
  try {
    await sendTelegramReply(chatId, message);
    return { sent: true, items, message };
  } catch (err) {
    return {
      sent: false,
      items,
      message,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
