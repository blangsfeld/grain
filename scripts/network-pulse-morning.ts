/**
 * Network Pulse — Morning brief for Ben across the eight Network companies.
 *
 * Runs weekday mornings at 7am ET via launchd. Pulls live signal from Granola,
 * Google Calendar, Slack, and Gmail; asks Claude to synthesize a chief-of-staff
 * memo; writes HTML (desktop) + markdown (Obsidian vault) outputs; pings
 * Telegram with the topline.
 *
 * Convert from a Cowork SKILL.md → durable launchd script. The SKILL spec
 * lives in the SYSTEM_PROMPT below — it's the prompt, not the infrastructure.
 *
 * Run manually:  npx tsx scripts/network-pulse-morning.ts
 * Run on date:   npx tsx scripts/network-pulse-morning.ts 2026-04-28
 *
 * Outputs:
 *   ~/Vault/80-pulse/YYYY-MM-DD.md
 *   ~/Vault/80-pulse/YYYY-MM-DD.html
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { listNotes } from "@/lib/granola";
import { listCalendarEvents, listGmailThreads, checkConnection as checkGoogle } from "@/lib/google";
import { getAnthropicClient } from "@/lib/anthropic";
import type { GoogleCalendarEvent, GmailThread } from "@/types/google";

// ───────────────────────────────────────────────────────────────────
// Config

const VAULT = `${process.env.HOME}/Vault`;
const PULSE_DIR = join(VAULT, "80-pulse");
const MODEL = "claude-sonnet-4-6";
const COMPANIES = ["BUCK", "Wild", "VTPro", "Part+Sum", "It's Nice That", "Giant Ant", "OK Cool", "CLIP/IYC"] as const;

// ───────────────────────────────────────────────────────────────────
// Source fetchers — each returns a string blurb or null on failure

async function fetchGranola(): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const notes = await listNotes(since);
    if (notes.length === 0) return "(no Granola meetings in last 3 days)";
    const lines = notes.slice(0, 20).map((n) => {
      const date = n.created_at.split("T")[0];
      return `- ${date} · ${n.title || "(untitled)"} · id=${n.id}`;
    });
    return lines.join("\n");
  } catch (err) {
    console.error("[granola] fetch failed:", err);
    return null;
  }
}

async function fetchCalendar(): Promise<string | null> {
  try {
    const status = await checkGoogle();
    if (status !== "connected") return `(Google ${status})`;
    const today = new Date();
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setHours(23, 59, 59, 999);
    const events: GoogleCalendarEvent[] = await listCalendarEvents("primary", start.toISOString(), end.toISOString());
    if (events.length === 0) return "(no calendar events today)";
    return events
      .map((e) => {
        const t = e.start.match(/T(\d{2}:\d{2})/)?.[1] ?? "all-day";
        const who = e.attendees?.filter((a) => !a.self).map((a) => a.name || a.email).slice(0, 5).join(", ");
        return `- ${t} · ${e.title}${who ? ` · with ${who}` : ""}`;
      })
      .join("\n");
  } catch (err) {
    console.error("[calendar] fetch failed:", err);
    return null;
  }
}

async function fetchSlack(): Promise<string | null> {
  const token = process.env.SLACK_USER_TOKEN;
  const me = process.env.MY_SLACK_USER_ID;
  if (!token || !me) return "(SLACK_USER_TOKEN or MY_SLACK_USER_ID missing)";

  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split("T")[0];
    const query = `to:<@${me}> after:${twoDaysAgo}`;
    const params = new URLSearchParams({ query, count: "30", sort: "timestamp" });
    const res = await fetch(`https://slack.com/api/search.messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return `(slack ${res.status})`;
    const data = (await res.json()) as { ok: boolean; messages?: { matches?: Array<{ text: string; username?: string; channel?: { name?: string }; ts: string }> } };
    if (!data.ok) return "(slack API returned not-ok)";
    const matches = data.messages?.matches ?? [];
    if (matches.length === 0) return "(no Slack DMs/mentions in last 48h)";
    return matches
      .slice(0, 25)
      .map((m) => {
        const sender = m.username ?? "?";
        const channel = m.channel?.name ? `#${m.channel.name}` : "DM";
        const text = m.text.replace(/\s+/g, " ").slice(0, 200);
        return `- ${channel} from ${sender}: ${text}`;
      })
      .join("\n");
  } catch (err) {
    console.error("[slack] fetch failed:", err);
    return null;
  }
}

async function fetchGmail(): Promise<string | null> {
  try {
    const status = await checkGoogle();
    if (status !== "connected") return `(Google ${status})`;
    const threads: GmailThread[] = await listGmailThreads(
      "newer_than:2d -in:sent -category:promotions -category:social",
      15,
    );
    if (threads.length === 0) return "(no substantive Gmail threads in last 2 days)";
    return threads
      .map((t) => `- ${t.subject} · from ${t.from.replace(/<.*>/, "").trim()} · ${t.snippet.slice(0, 160)}`)
      .join("\n");
  } catch (err) {
    console.error("[gmail] fetch failed:", err);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// Synthesis prompt — the SKILL.md spec, durable across runtimes

const SYSTEM_PROMPT = `You are generating Ben Langsfeld's daily Network Pulse — a morning brief for a Chief Creative Officer operating across eight creative companies in the Residence Network (BUCK, Wild, VTPro, Part+Sum, It's Nice That / INT, Giant Ant, OK Cool, CLIP/IYC).

You will be handed live signal from four sources: Granola meetings (last 3 days + today), Google Calendar (today), Slack messages directed at Ben (last 48h), and Gmail threads (last 2 days). Synthesize a prose-leaning chief-of-staff memo.

Voice rules (Ben's preferences — non-negotiable):
- Lead with the answer. No preamble, no "today brings a busy schedule" openers.
- Stacked declaratives, variable sentence length. Reporting tone, not instructional.
- Specifics over abstractions — real names, real meeting titles, concrete numbers.
- Compression is a requirement. Cut every word that doesn't earn its keep.
- Never use bullet lists in the prose sections.
- No corporate softening ("might want to consider"). Take positions.
- Psychology-first: when noting what someone needs, name the underlying dynamic (status, identity, control, loss-aversion) if it's clear.
- Banned words: leverage, ecosystem, seamless, robust, unlock, dig into.

Structure: four sections.

1. **topline** (one sentence, conclusion-first) — The single most important frame for today. What is the reader about to walk into? What posture should they take? Declarative with bite. Italicize one phrase if it deserves emphasis (use *word* in markdown, that's the only allowed formatting in topline).

2. **needs_you** (3–6 items) — Where Ben's attention, judgment, or decision is the unblock. Each item: a short noun-phrase title, a provenance tag (Granola | Calendar | Slack | Gmail), and ONE sentence of psychology-aware context (what's the real ask underneath the surface ask). Not a to-do list — a read on where leverage lives today.

3. **network_signal** (2–4 items) — Cross-cutting patterns detected organically in the data. Each: short title, provenance, 1–3 sentences of explanation.

4. **background** (one short line per company, all 8) — BUCK, Wild, VTPro, Part+Sum, It's Nice That, Giant Ant, OK Cool, CLIP/IYC. Summarize last meaningful activity from past 3 days. If quiet, say "quiet".

Return STRICT JSON only — no preamble, no markdown fences, no commentary. Schema:

{
  "topline": "string",
  "needs_you": [{"title": "string", "provenance": "Granola|Calendar|Slack|Gmail", "context": "string"}],
  "network_signal": [{"title": "string", "provenance": "string", "context": "string"}],
  "background": [{"company": "BUCK", "summary": "string"}, ...all 8 companies in this exact order...]
}

If a source returned no data, say so honestly in any item that depends on it. Don't invent activity.`;

// ───────────────────────────────────────────────────────────────────
// Synthesis

interface PulseSection {
  title: string;
  provenance: string;
  context: string;
}

interface Pulse {
  topline: string;
  needs_you: PulseSection[];
  network_signal: PulseSection[];
  background: { company: string; summary: string }[];
}

async function synthesize(input: { date: string; granola: string | null; calendar: string | null; slack: string | null; gmail: string | null }): Promise<Pulse> {
  const anthropic = getAnthropicClient(60_000);
  const dataBlock = [
    `# Date: ${input.date}`,
    "",
    `## Granola meetings (last 3 days + today)`,
    input.granola ?? "(unavailable)",
    "",
    `## Calendar (today)`,
    input.calendar ?? "(unavailable)",
    "",
    `## Slack (DMs + mentions, last 48h)`,
    input.slack ?? "(unavailable)",
    "",
    `## Gmail (last 2 days, substantive)`,
    input.gmail ?? "(unavailable)",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: dataBlock }],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`pulse synthesis: no JSON in response — ${raw.slice(0, 200)}`);
  return JSON.parse(match[0]) as Pulse;
}

// ───────────────────────────────────────────────────────────────────
// Renderers

function wikilink(s: string): string {
  // Wrap company / proper-noun-ish references in [[wikilinks]] for the markdown vault.
  // Conservative: only the 8 companies + "Residence". Don't over-link.
  let out = s;
  for (const co of [...COMPANIES, "Residence", "INT", "IYC"]) {
    const rx = new RegExp(`\\b${co.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    out = out.replace(rx, `[[${co}]]`);
  }
  return out;
}

function renderMarkdown(pulse: Pulse, date: string): string {
  const dayName = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const display = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  const companies = Array.from(new Set(pulse.background.map((b) => b.company)));
  const topicTheme = inferTheme(pulse);

  const fm = [
    "---",
    "type: pulse",
    `date: ${date}`,
    `day_of_week: ${dayName}`,
    "source: claude-scheduled",
    "pulse_managed: true",
    `companies: [${companies.map((c) => JSON.stringify(c)).join(", ")}]`,
    `topline_theme: ${JSON.stringify(topicTheme)}`,
    "---",
    "",
  ].join("\n");

  const body = [
    `# Network Pulse — ${display}`,
    "",
    "## Top line",
    "",
    wikilink(pulse.topline),
    "",
    "## Needs you today",
    "",
    ...pulse.needs_you.flatMap((n) => [`**${wikilink(n.title)}** \`${n.provenance}\``, wikilink(n.context), ""]),
    "## Network signal",
    "",
    ...pulse.network_signal.flatMap((n) => [`**${wikilink(n.title)}** \`${n.provenance}\``, wikilink(n.context), ""]),
    "## Background across the network",
    "",
    ...pulse.background.map((b) => `**[[${b.company}]]** — ${wikilink(b.summary)}`),
    "",
    "---",
    "",
    `*Generated from: Granola, Slack, Gmail, Calendar. v1 · launchd \`com.benlangsfeld.network-pulse\`.*`,
  ].join("\n");

  return fm + body;
}

function inferTheme(pulse: Pulse): string {
  const text = (pulse.topline + " " + pulse.needs_you.map((n) => n.title).join(" ")).toLowerCase();
  if (/positioning|messaging|narrative/.test(text)) return "positioning";
  if (/pipeline|prospect|client|deal/.test(text)) return "pipeline";
  if (/board|leader|exec|cfo|ceo/.test(text)) return "board";
  if (/hire|talent|team/.test(text)) return "talent";
  if (/launch|ship|release/.test(text)) return "launch";
  return "network";
}

function renderHTML(pulse: Pulse, date: string): string {
  const display = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const em = (s: string) => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const needsHtml = pulse.needs_you
    .map((n) => `<div class="item"><div class="item-title">${em(n.title)} <span class="tag">${esc(n.provenance)}</span></div><div class="item-body">${em(n.context)}</div></div>`)
    .join("\n");

  const signalHtml = pulse.network_signal
    .map((n) => `<div class="item"><div class="item-title">${em(n.title)} <span class="tag">${esc(n.provenance)}</span></div><div class="item-body">${em(n.context)}</div></div>`)
    .join("\n");

  const backgroundHtml = pulse.background
    .map((b) => `<div class="bg-row"><span class="bg-co">${esc(b.company)}</span> — ${em(b.summary)}</div>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Network Pulse — ${esc(display)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { --bg:#f5f1e8; --fg:#1a1815; --muted:#6b6760; --accent:#8a3a1e; --tag:#a05a3a; --rule:#d8d2c4; }
    @media (prefers-color-scheme: dark) { :root { --bg:#17171a; --fg:#e8e4d8; --muted:#888279; --accent:#d98a5a; --tag:#c87a4a; --rule:#2c2a26; } }
    html, body { background:var(--bg); color:var(--fg); margin:0; }
    body { font-family: 'Iowan Old Style','Charter',Georgia,serif; font-size:16px; line-height:1.55; padding:48px 24px 96px; }
    .wrap { max-width:680px; margin:0 auto; }
    .masthead { font:11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:0.18em; text-transform:uppercase; color:var(--muted); padding-bottom:12px; border-bottom:1px solid var(--rule); display:flex; justify-content:space-between; }
    h1 { font-size:24px; margin:32px 0 8px; font-weight:600; letter-spacing:-0.01em; }
    h2 { font:11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:0.18em; text-transform:uppercase; color:var(--accent); margin:32px 0 14px; }
    .topline { font-size:19px; line-height:1.5; padding:8px 0 4px; border-bottom:1px solid var(--rule); margin-bottom:24px; }
    .item { margin-bottom:18px; }
    .item-title { font-weight:600; margin-bottom:2px; }
    .item-body { color:var(--fg); }
    .tag { font:10.5px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:0.16em; text-transform:uppercase; color:var(--tag); margin-left:6px; vertical-align:middle; }
    .bg-row { padding:6px 0; border-bottom:1px solid var(--rule); font-size:15px; }
    .bg-row:last-child { border-bottom:none; }
    .bg-co { font:11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:0.16em; text-transform:uppercase; color:var(--accent); margin-right:6px; }
    em { font-style:italic; }
    .footer { font:11px/1.5 ui-sans-serif,system-ui,sans-serif; color:var(--muted); margin-top:48px; padding-top:16px; border-top:1px solid var(--rule); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="masthead"><span>${esc(display)}</span><span>Network Pulse — v1</span></div>
    <h1>Top line</h1>
    <div class="topline">${em(pulse.topline)}</div>
    <h2>Needs you today</h2>
    ${needsHtml}
    <h2>Network signal</h2>
    ${signalHtml}
    <h2>Background across the network</h2>
    ${backgroundHtml}
    <div class="footer">Generated from Granola, Slack, Gmail, Calendar · launchd com.benlangsfeld.network-pulse</div>
  </div>
</body>
</html>`;
}

// ───────────────────────────────────────────────────────────────────
// Telegram ping (best-effort)

async function ping(topline: string, mdPath: string, htmlPath: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!token || !chatId) {
    console.log("[telegram] skipping (TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_ID missing)");
    return;
  }
  const text = `*Network Pulse · ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}*\n\n${topline}\n\n_${mdPath}_`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    if (!res.ok) console.error("[telegram] non-ok:", res.status, await res.text());
  } catch (err) {
    console.error("[telegram] failed:", err);
  }
}

// ───────────────────────────────────────────────────────────────────
// Main

async function main() {
  const arg = process.argv[2];
  const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date().toISOString().split("T")[0];
  const dow = new Date(date + "T12:00:00").getDay();
  const isWeekend = dow === 0 || dow === 6;

  console.log(`[pulse] start ${date}${isWeekend ? " (weekend — running anyway)" : ""}`);

  const [granola, calendar, slack, gmail] = await Promise.all([
    fetchGranola(),
    fetchCalendar(),
    fetchSlack(),
    fetchGmail(),
  ]);

  console.log(`[pulse] sources: granola=${granola ? "ok" : "fail"} · calendar=${calendar ? "ok" : "fail"} · slack=${slack ? "ok" : "fail"} · gmail=${gmail ? "ok" : "fail"}`);

  const pulse = await synthesize({ date, granola, calendar, slack, gmail });

  mkdirSync(PULSE_DIR, { recursive: true });
  const mdPath = join(PULSE_DIR, `${date}.md`);
  const htmlPath = join(PULSE_DIR, `${date}.html`);
  writeFileSync(mdPath, renderMarkdown(pulse, date));
  writeFileSync(htmlPath, renderHTML(pulse, date));

  console.log(`[pulse] wrote ${mdPath}`);
  console.log(`[pulse] wrote ${htmlPath}`);
  console.log(`[pulse] topline: ${pulse.topline}`);

  await ping(pulse.topline, mdPath, htmlPath);

  console.log("[pulse] done");
}

main().catch((err) => {
  console.error("[pulse] fatal:", err);
  process.exit(1);
});
