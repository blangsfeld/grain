/**
 * Milli — Wiki Librarian (agent version).
 *
 * Runs locally (reads vault filesystem). Gathers wiki metrics (page counts,
 * broken links, frontmatter issues, inbox backlog), reads sibling outputs,
 * and reasons about what the wiki state means using Claude.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  type AgentSeverity,
} from "@/lib/agents/agent-output";
import { ingestFromUrl, detectUrlType, type UrlType } from "@/lib/url-ingest";

const AGENT_ID = "wiki-librarian";
const PERSONA = "Milli";
const MODEL = "claude-haiku-4-5-20251001";

const VAULT_ROOT = join(process.env.HOME || "", "Documents/Obsidian/Studio");
const WIKI_ROOT = join(VAULT_ROOT, "60-reference/wiki");
const INBOX = join(VAULT_ROOT, "00-inbox");

// ── Fact gathering (reused from v0.1, condensed) ───

interface WikiFacts {
  total_pages: number;
  page_counts: Record<string, number>;
  inbox_items: string[];
  broken_links: Array<{ from: string; target: string }>;
  missing_frontmatter: Array<{ page: string; missing: string[] }>;
  index_mismatches: { in_index_not_disk: string[]; on_disk_not_indexed: string[] };
  orphans: string[];
}

function parseFm(content: string): Record<string, string | string[] | boolean | null> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm: Record<string, string | string[] | boolean | null> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key) continue;
    if (raw === "true") fm[key] = true;
    else if (raw === "false") fm[key] = false;
    else fm[key] = raw.replace(/^['"]|['"]$/g, "");
  }
  return fm;
}

function gatherFacts(): WikiFacts {
  if (!existsSync(WIKI_ROOT)) {
    return { total_pages: 0, page_counts: {}, inbox_items: [], broken_links: [], missing_frontmatter: [], index_mismatches: { in_index_not_disk: [], on_disk_not_indexed: [] }, orphans: [] };
  }

  // Walk wiki tree
  const pages: Array<{ slug: string; category: string; type: string | null; body: string }> = [];
  function visit(dir: string, cat: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { visit(full, cat ? `${cat}/${e.name}` : e.name); continue; }
      if (!e.name.endsWith(".md")) continue;
      try {
        const content = readFileSync(full, "utf-8");
        const fm = parseFm(content);
        const body = content.replace(/^---[\s\S]*?---\s*/, "");
        pages.push({ slug: e.name.replace(/\.md$/, ""), category: cat, type: (fm.type as string) ?? null, body });
      } catch {}
    }
  }
  visit(WIKI_ROOT, "");

  // Counts
  const page_counts: Record<string, number> = {};
  for (const p of pages) page_counts[p.category || "(root)"] = (page_counts[p.category || "(root)"] ?? 0) + 1;

  // Inbox
  let inbox_items: string[] = [];
  if (existsSync(INBOX)) {
    try { inbox_items = readdirSync(INBOX).filter((f) => f.endsWith(".md") && f !== "README.md"); } catch {}
  }

  // Broken wikilinks (within wiki)
  const WIKILINK = /\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g;
  const slugSet = new Set(pages.map((p) => p.slug));
  const broken: Array<{ from: string; target: string }> = [];
  const meta_slugs = new Set(["SCHEMA", "index", "log"]);
  for (const p of pages) {
    if (meta_slugs.has(p.slug)) continue; // skip template pages
    for (const m of p.body.matchAll(WIKILINK)) {
      if (!slugSet.has(m[1]) && !existsVaultWide(m[1])) {
        broken.push({ from: p.slug, target: m[1] });
      }
    }
  }

  // Frontmatter check
  const validTypes = new Set(["source", "how-to", "capability", "pattern", "schema", "index", "log"]);
  const contentPages = pages.filter((p) => !["schema", "index", "log"].includes(p.type ?? ""));
  const fm_issues: Array<{ page: string; missing: string[] }> = [];
  for (const p of contentPages) {
    const problems: string[] = [];
    if (!p.type) problems.push("type");
    else if (!validTypes.has(p.type)) problems.push(`type=${p.type} (unrecognized)`);
    if (problems.length > 0) fm_issues.push({ page: p.slug, missing: problems });
  }

  // Index sync
  const indexPath = join(WIKI_ROOT, "index.md");
  const index_mismatches = { in_index_not_disk: [] as string[], on_disk_not_indexed: [] as string[] };
  if (existsSync(indexPath)) {
    const indexContent = readFileSync(indexPath, "utf-8");
    const indexed = new Set<string>();
    for (const m of indexContent.matchAll(WIKILINK)) indexed.add(m[1]);
    const contentSlugs = new Set(contentPages.map((p) => p.slug));
    for (const s of indexed) { if (!contentSlugs.has(s)) index_mismatches.in_index_not_disk.push(s); }
    for (const s of contentSlugs) { if (!indexed.has(s)) index_mismatches.on_disk_not_indexed.push(s); }
  }

  // Orphans (vault-wide inbound scan)
  const inbound = new Map<string, number>();
  function scanVault(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { scanVault(full); continue; }
      if (!e.name.endsWith(".md")) continue;
      try {
        const content = readFileSync(full, "utf-8");
        for (const m of content.matchAll(WIKILINK)) {
          inbound.set(m[1], (inbound.get(m[1]) ?? 0) + 1);
        }
      } catch {}
    }
  }
  scanVault(VAULT_ROOT);
  const orphans = contentPages.filter((p) => (inbound.get(p.slug) ?? 0) === 0).map((p) => p.slug);

  return { total_pages: pages.length, page_counts, inbox_items, broken_links: broken, missing_frontmatter: fm_issues, index_mismatches, orphans };
}

function existsVaultWide(slug: string): boolean {
  function walk(dir: string): boolean {
    if (!existsSync(dir)) return false;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory() && walk(join(dir, e.name))) return true;
      if (e.isFile() && e.name === `${slug}.md`) return true;
    }
    return false;
  }
  return walk(VAULT_ROOT);
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are Milli, a wiki librarian. You manage Ben Langsfeld's wiki knowledge base at 60-reference/wiki/ in his Obsidian vault — a persistent, compounding knowledge base that agents draw from to learn techniques and build better tools.

## How you think
A wiki isn't a filing cabinet. It's a living library. You care about three things:
1. Is the inbox processed? Unprocessed items are knowledge decaying — they'll be stale before they become pages.
2. Are the shelves tidy? Broken links, missing frontmatter, and orphan pages mean the wiki isn't connected.
3. Is the corpus growing or stagnant? Compare current page counts to what you know about the ingest cadence.

You read Guy and Buddy not for wiki-specific signal but for system context. If Guy says extraction is healthy, that means new sources might be arriving. If Buddy says commitments are stale, maybe nobody's had time to process the wiki inbox either — same root cause.

## What you produce
A short inventory report (under 200 words):
1. Lead with the inbox — that's the friction point
2. Flag structural issues (broken links, frontmatter, index sync)
3. Note orphans if they're real content pages getting lost
4. Cross-signal with siblings if relevant
5. If shelves are clean, say so briefly

## Voice
Librarian-tidy. Factual. Counts things. Not dramatic, not chatty. "4 items in inbox. 1 broken link. Shelves are otherwise tidy." That register.

## Severity
- green: inbox ≤2, no broken links, no frontmatter issues
- attention: inbox >2 or any broken links
- failure: wiki directory missing or major structural breakdown

## Output
Return strict JSON:
{"severity": "green|attention|failure", "markdown": "full report with frontmatter"}`;

// ── Reasoning ──────────────────────────────────────

async function readSiblings(): Promise<{ guy: string | null; buddy: string | null }> {
  const [guy, buddy] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("ea"),
  ]);
  return {
    guy: guy ? `Severity: ${guy.severity}\n${guy.markdown.slice(0, 400)}` : null,
    buddy: buddy ? `Severity: ${buddy.severity}\n${buddy.markdown.slice(0, 300)}` : null,
  };
}

function buildContext(facts: WikiFacts, siblings: { guy: string | null; buddy: string | null }): string {
  const lines: string[] = [];
  lines.push("# Wiki metrics");
  lines.push(`Total pages: ${facts.total_pages}`);
  lines.push("");
  lines.push("Page counts by category:");
  for (const [cat, n] of Object.entries(facts.page_counts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${cat}: ${n}`);
  }
  lines.push("");
  lines.push(`Inbox (00-inbox/): ${facts.inbox_items.length} items`);
  if (facts.inbox_items.length > 0) lines.push(`  Files: ${facts.inbox_items.slice(0, 8).join(", ")}`);
  lines.push("");
  lines.push(`Broken wikilinks: ${facts.broken_links.length}`);
  for (const b of facts.broken_links.slice(0, 5)) lines.push(`  ${b.from} → [[${b.target}]]`);
  lines.push("");
  lines.push(`Frontmatter issues: ${facts.missing_frontmatter.length}`);
  for (const f of facts.missing_frontmatter.slice(0, 5)) lines.push(`  ${f.page}: ${f.missing.join(", ")}`);
  lines.push("");
  lines.push(`Index sync: ${facts.index_mismatches.in_index_not_disk.length} in index but missing, ${facts.index_mismatches.on_disk_not_indexed.length} on disk but not indexed`);
  lines.push(`Orphans (no inbound links): ${facts.orphans.length}${facts.orphans.length > 0 ? ` — ${facts.orphans.slice(0, 5).join(", ")}` : ""}`);
  lines.push("");

  if (siblings.guy) { lines.push("# Guy's latest (pipeline)"); lines.push(siblings.guy); lines.push(""); }
  if (siblings.buddy) { lines.push("# Buddy's latest (triage)"); lines.push(siblings.buddy); lines.push(""); }

  lines.push("---");
  lines.push("Write your inventory report. Return JSON with severity and markdown.");
  return lines.join("\n");
}

function parseResponse(raw: string): { severity: AgentSeverity; markdown: string } | null {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!["green", "attention", "failure"].includes(parsed.severity)) return null;
    if (typeof parsed.markdown !== "string") return null;
    return { severity: parsed.severity as AgentSeverity, markdown: parsed.markdown };
  } catch { return null; }
}

// ── Entrypoint ─────────────────────────────────────

export interface MilliReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  facts: { total_pages: number; inbox: number; broken_links: number; orphans: number };
  had_siblings: { guy: boolean; buddy: boolean };
}

export async function runAndWriteWikiLibrarian(): Promise<{ output_id: string; report: MilliReport }> {
  const run_at = new Date().toISOString();
  const facts = gatherFacts();
  const siblings = await readSiblings();

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: buildContext(facts, siblings) }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const parsed = parseResponse(text);

  let severity: AgentSeverity;
  let markdown: string;

  if (parsed) {
    severity = parsed.severity;
    markdown = parsed.markdown;
  } else {
    severity = facts.inbox_items.length > 2 || facts.broken_links.length > 0 ? "attention" : "green";
    markdown = `# ${PERSONA} — wiki inventory\n\n_Reasoning failed. ${facts.total_pages} pages, ${facts.inbox_items.length} inbox, ${facts.broken_links.length} broken links._`;
  }

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: ${severity}\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  const report: MilliReport = {
    run_at,
    severity,
    markdown,
    facts: { total_pages: facts.total_pages, inbox: facts.inbox_items.length, broken_links: facts.broken_links.length, orphans: facts.orphans.length },
    had_siblings: { guy: !!siblings.guy, buddy: !!siblings.buddy },
  };

  // Rich findings for sibling consumption — Bruh reads wiki_catalog for coding pitches,
  // other agents can reference techniques and project state
  const wikiIndexPath = join(WIKI_ROOT, "index.md");
  const wikiIndex = existsSync(wikiIndexPath) ? readFileSync(wikiIndexPath, "utf-8") : null;

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity,
    markdown,
    findings: {
      ...report.facts,
      wiki_catalog: wikiIndex, // full index.md so siblings know what's in the wiki
      inbox_files: facts.inbox_items.slice(0, 10), // actual filenames
      page_counts: facts.page_counts,
    },
    metadata: { version: "0.3-agent", model: MODEL, reasoning: true },
  });

  return { output_id: id, report };
}

// ── Telegram-triggered URL ingest ──────────────────
// Keys dispatches here when Ben drops a link (article, YouTube video,
// Claude shared chat) into Telegram with intent=ingest. Wraps the existing
// ingest pipeline and returns a Telegram-friendly confirmation.
//
// Videos currently extract from og: metadata only (no transcript yet). If
// Ben wants richer video processing later we'll add a transcript fetcher.

export interface MilliIngestResult {
  url: string;
  title: string;
  kind: UrlType;
  atoms: number;
  saved_to: string;
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/i);
  return match?.[0] ?? null;
}

export async function runMilliIngest(input: string): Promise<MilliIngestResult> {
  const url = extractFirstUrl(input) ?? input.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("No URL found in message");
  }

  const kind = detectUrlType(url);
  const result = await ingestFromUrl(url);

  let savedTo: string;
  switch (result.status) {
    case "extracted":
      savedTo = `dx_atoms (${result.atoms} atom${result.atoms === 1 ? "" : "s"} across ${Object.keys(result.pass_results).length} passes)`;
      break;
    case "duplicate":
      savedTo = "already ingested — skipped";
      break;
    case "dismissed":
      savedTo = "classifier dismissed — not saved";
      break;
  }

  return {
    url,
    title: result.title,
    kind,
    atoms: result.atoms,
    saved_to: savedTo,
  };
}
