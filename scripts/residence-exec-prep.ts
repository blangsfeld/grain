/**
 * Residence Exec Prep — Monday morning brief of what Ben should drop into
 * the Residence Exec canvas before that evening's meeting.
 *
 * Fills the gap that Buddy/Euclid don't: looking forward at what BEN
 * specifically should bring to a 5-person executive room, filtered to
 * cross-company OR network-strategic OR coordination-required.
 *
 * Pulls from:
 *   - grain DB: open commitments, recent decision atoms, voice atoms, tensions
 *   - Granola meetings (last 7 days, titles + attendees)
 *   - Slack DMs/mentions to Ben (last 7 days)
 *   - Buddy's latest synthesis output (last week's read)
 *   - Historical Ben canvas sections (embedded for voice calibration)
 *
 * Output: email draft to BRIEFING_EMAIL (default blangsfeld@gmail.com),
 * Monday 6:30am ET via launchd. Ready to edit + paste into the canvas
 * before that evening's exec meeting.
 *
 * Run manually:  npx tsx scripts/residence-exec-prep.ts
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { sendEmail } from "@/lib/resend";
import { listNotes } from "@/lib/granola";

const MODEL = "claude-sonnet-4-6";
const DELIVERY_EMAIL = process.env.BRIEFING_EMAIL ?? "blangsfeld@gmail.com";

// ───────────────────────────────────────────────────────────────────
// Source fetchers

async function fetchOpenCommitments(): Promise<string> {
  const supa = getSupabaseAdmin();
  const since = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const { data } = await supa
    .from("dx_commitments")
    .select("statement, person, category, meeting_date, commitment_labels(weight)")
    .eq("status", "open")
    .gte("meeting_date", since)
    .order("meeting_date", { ascending: false })
    .limit(40);
  if (!data?.length) return "(no open commitments)";
  type Row = { statement: string; person: string | null; category: string | null; meeting_date: string | null; commitment_labels: Array<{ weight: string }> | { weight: string } | null };
  return (data as unknown as Row[])
    .filter((r) => {
      const label = Array.isArray(r.commitment_labels) ? r.commitment_labels[0] : r.commitment_labels;
      return label?.weight !== "skip";
    })
    .map((r) => `- ${r.meeting_date} · ${r.person ?? "?"}: ${r.statement}`)
    .join("\n");
}

async function fetchRecentAtoms(type: "decision" | "tension" | "voice"): Promise<string> {
  const supa = getSupabaseAdmin();
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await supa
    .from("dx_atoms")
    .select("content, source_title, source_date")
    .eq("type", type)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(15);
  if (!data?.length) return `(no recent ${type} atoms)`;
  type Row = { content: Record<string, string>; source_title: string | null; source_date: string | null };
  return (data as unknown as Row[])
    .map((r) => {
      const c = r.content;
      const text = c.statement || c.decision || c.title || c.pair || c.quote || JSON.stringify(c).slice(0, 120);
      return `- [${r.source_date}] ${text} (${r.source_title ?? "?"})`;
    })
    .join("\n");
}

async function fetchMeetings(): Promise<string> {
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const notes = await listNotes(since);
    if (!notes.length) return "(no Granola meetings in last 7 days)";
    return notes
      .slice(0, 30)
      .map((n) => `- ${n.created_at.split("T")[0]} · ${n.title || "(untitled)"}`)
      .join("\n");
  } catch (err) {
    console.error("[meetings] failed:", err);
    return "(Granola unavailable)";
  }
}

async function fetchSlack(): Promise<string> {
  const token = process.env.SLACK_USER_TOKEN;
  const me = process.env.MY_SLACK_USER_ID;
  if (!token || !me) return "(Slack not configured)";
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const params = new URLSearchParams({ query: `to:<@${me}> after:${since}`, count: "40", sort: "timestamp" });
    const res = await fetch(`https://slack.com/api/search.messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return `(slack ${res.status})`;
    const data = (await res.json()) as { ok: boolean; messages?: { matches?: Array<{ text: string; username?: string; channel?: { name?: string } }> } };
    if (!data.ok) return "(slack not-ok)";
    const matches = data.messages?.matches ?? [];
    if (!matches.length) return "(no Slack DMs/mentions in last 7d)";
    return matches
      .slice(0, 30)
      .map((m) => `- ${m.channel?.name ? `#${m.channel.name}` : "DM"} from ${m.username ?? "?"}: ${m.text.replace(/\s+/g, " ").slice(0, 220)}`)
      .join("\n");
  } catch (err) {
    console.error("[slack] failed:", err);
    return "(slack failed)";
  }
}

async function fetchLatestBuddy(): Promise<string> {
  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from("dx_briefings")
    .select("body, briefing_date")
    .order("briefing_date", { ascending: false })
    .limit(1);
  if (!data?.length) return "(no recent Buddy briefing)";
  return (data[0].body as string).slice(0, 4000);
}

// ───────────────────────────────────────────────────────────────────
// Voice calibration — historical Ben sections from the canvas.
// Pinned in the system prompt so the model learns format + voice.

const HISTORICAL_BEN_SECTIONS = `Week of Jan 27, 2025
* JPMorgan Data Lake
* EP Dashboard Prototype > Residence
* Comms Pod

Week of Feb 16, 2025
* SF Trip
* CRM/JPMorgan Lake

Week of Feb 23, 2025
* JPMorgan Chase Sprint
* Case Study Update
* Comms Listening tour

Week of Mar 2, 2025
* Comms Update
* Events Update
* March LA Plans

Week of Mar 16, 2025
* BUCK x Residence Retainer
* SXSW Update
* Chase Update
* Client Service Needs (Oscar)

Week of Apr 21, 2025
* Jolyon LinkedIn Update`;

// ───────────────────────────────────────────────────────────────────
// Synthesis prompt

const SYSTEM_PROMPT = `You are drafting Ben Langsfeld's section of the weekly Residence Exec canvas. Ben is Chief Creative Officer of the Residence Network (8 creative companies: BUCK, Wild, VTPro, Part+Sum, It's Nice That/INT, Giant Ant, OK Cool, CLIP/IYC). The exec meeting is Monday evening with: Wade (CFO), Jan (CHRO), Ryan (CGO), Madison (COO), Orion (Creative Chair).

Your job: from Ben's last 7 days of signal, pick 3-5 items HE specifically should bring to that exec room, drafted in the canvas's terse bullet voice.

What goes in Ben's section:
- Cross-company moves (BUCK + Wild, multi-studio coordination)
- Big client relationships at the network level (JPMorgan, Chase, Microsoft, Samsung, etc.)
- Network-strategic initiatives requiring exec alignment (positioning, AI capability, brand)
- Strategic events (SXSW, Cannes, AGM, board meetings, conferences)
- Decisions that need 2+ exec input
- Updates on things the room should know is in motion

What does NOT go in Ben's section:
- Single-company tactical issues (those go to that company's section)
- Personnel issues (Jan covers)
- Financial detail (Wade covers)
- M&A specifics (Ryan covers)
- His personal calendar / day-to-day meetings
- Items already covered in other execs' sections this week (be parsimonious)

Format rules — match the historical canvas voice exactly:
- Each item is a SHORT noun phrase (3-8 words). Not a sentence.
- Optionally followed by a single sub-bullet of context if the item itself isn't self-explanatory
- No headings, no decorations, no "Update:" or "Decision:" prefixes
- People names appear without titles
- Heavy initialism use is fine (GS = Goldman, P&S = Part+Sum, INT = It's Nice That, JPM = JPMorgan)
- The room shares context — you can be cryptic if the item compresses something everyone knows about
- Aim for 3-5 items total. Less is better than more. Empty is allowed if there's nothing exec-worthy.

Here are recent historical Ben sections from the canvas — match this voice and density exactly:

${HISTORICAL_BEN_SECTIONS}

Return STRICT JSON only:
{
  "items": [
    { "title": "short noun phrase", "context": "optional single sentence — leave empty string if title is self-explanatory" }
  ],
  "rationale": "3-4 sentences explaining what you included, what you excluded, and why. This is for Ben to evaluate before posting."
}`;

interface ExecSection {
  items: Array<{ title: string; context: string }>;
  rationale: string;
}

async function synthesize(input: {
  commitments: string;
  decisions: string;
  tensions: string;
  voice: string;
  meetings: string;
  slack: string;
  buddy: string;
}): Promise<ExecSection> {
  const anthropic = getAnthropicClient(60_000);
  const dataBlock = [
    `# Last 7 days of Ben's signal — ${new Date().toISOString().split("T")[0]}`,
    "",
    `## Open commitments (Ben's plate)`,
    input.commitments,
    "",
    `## Recent decisions (atoms)`,
    input.decisions,
    "",
    `## Recent tensions`,
    input.tensions,
    "",
    `## Recent voice atoms (Ben's framing)`,
    input.voice,
    "",
    `## Granola meetings (last 7d)`,
    input.meetings,
    "",
    `## Slack DMs / mentions to Ben (last 7d)`,
    input.slack,
    "",
    `## Latest Buddy briefing (chief-of-staff context)`,
    input.buddy,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: dataBlock }],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`exec-prep: no JSON in response — ${raw.slice(0, 200)}`);
  return JSON.parse(match[0]) as ExecSection;
}

// ───────────────────────────────────────────────────────────────────
// Render + email

function weekOf(date: Date): string {
  // Find the Monday of this week (or next Monday if today is past Tuesday)
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const offsetToMon = day === 0 ? 1 : 1 - day;
  d.setDate(d.getDate() + offsetToMon);
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

function renderHTML(section: ExecSection, weekLabel: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const items = section.items
    .map((it) => {
      const ctx = it.context.trim() ? `<div class="ctx">${esc(it.context)}</div>` : "";
      return `<li><strong>${esc(it.title)}</strong>${ctx}</li>`;
    })
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Residence Exec Prep — Week of ${esc(weekLabel)}</title>
<style>
  body { font: 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width: 640px; margin: 32px auto; padding: 0 20px; color: #1a1815; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #6b6760; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8a3a1e; margin: 28px 0 12px; }
  ul { padding-left: 18px; margin: 0; }
  li { margin-bottom: 14px; }
  .ctx { color: #4b4842; font-size: 14px; margin-top: 2px; }
  .rationale { color: #4b4842; font-size: 13px; padding: 16px; background: #f5f1e8; border-radius: 6px; margin-top: 24px; line-height: 1.6; }
  .copy-block { font: 13.5px/1.55 ui-monospace,SFMono-Regular,monospace; color: #1a1815; padding: 16px; background: #f5f1e8; border-radius: 6px; margin-top: 12px; white-space: pre-wrap; }
</style></head>
<body>
  <h1>Residence Exec Prep — Week of ${esc(weekLabel)}</h1>
  <div class="sub">Drafted for tonight's meeting · edit and paste into the canvas</div>

  <h2>Proposed for your section</h2>
  <ul>${items}</ul>

  <h2>Copy-paste version (for the canvas)</h2>
  <div class="copy-block">${esc(renderCanvasMarkdown(section))}</div>

  <h2>Why these (rationale)</h2>
  <div class="rationale">${esc(section.rationale)}</div>
</body></html>`;
}

function renderCanvasMarkdown(section: ExecSection): string {
  return section.items
    .map((it) => {
      if (it.context.trim()) return `* ${it.title}\n  * ${it.context}`;
      return `* ${it.title}`;
    })
    .join("\n");
}

// ───────────────────────────────────────────────────────────────────
// Main

async function main() {
  console.log("[exec-prep] start");

  const [commitments, decisions, tensions, voice, meetings, slack, buddy] = await Promise.all([
    fetchOpenCommitments(),
    fetchRecentAtoms("decision"),
    fetchRecentAtoms("tension"),
    fetchRecentAtoms("voice"),
    fetchMeetings(),
    fetchSlack(),
    fetchLatestBuddy(),
  ]);

  console.log("[exec-prep] sources fetched, synthesizing");

  const section = await synthesize({ commitments, decisions, tensions, voice, meetings, slack, buddy });

  const weekLabel = weekOf(new Date());
  const html = renderHTML(section, weekLabel);
  const text = `Residence Exec Prep — Week of ${weekLabel}\n\n${renderCanvasMarkdown(section)}\n\n---\n\nRationale:\n${section.rationale}`;

  console.log(`[exec-prep] ${section.items.length} items drafted`);
  console.log(text);

  if (process.argv.includes("--dry-run")) {
    console.log("[exec-prep] --dry-run, skipping email");
    return;
  }

  await sendEmail({
    to: DELIVERY_EMAIL,
    subject: `Residence Exec Prep — Week of ${weekLabel}`,
    html,
    text,
  });
  console.log(`[exec-prep] sent to ${DELIVERY_EMAIL}`);
}

main().catch((err) => {
  console.error("[exec-prep] fatal:", err);
  process.exit(1);
});
