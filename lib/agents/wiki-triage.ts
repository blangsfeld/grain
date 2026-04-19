/**
 * Milli — Wiki Triage (Phase A).
 *
 * Processes items in 00-inbox/: fetch content, classify shape with Haiku,
 * write a source page into 60-reference/wiki/sources/{type}/, update
 * index.md, append to log.md, move the inbox file into _archive/.
 *
 * New pages are written with `status: draft` — the trust-building flag.
 * Once Milli's filing is tuned we'll drop it. Cross-links only point to
 * slugs that actually exist — no phantom wikilinks.
 *
 * Raw notes (no URL) are moved to 00-inbox/_review/ and left for Phase B
 * synthesis. They require deeper reasoning than a shape-classifier pass.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  appendFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  fetchArticle,
  fetchClaudeChat,
  detectUrlType,
  type UrlType,
} from "@/lib/url-ingest";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const WIKI_ROOT = join(VAULT_ROOT, "60-reference/wiki");
const INBOX = join(VAULT_ROOT, "00-inbox");
const ARCHIVE = join(INBOX, "_archive");
const REVIEW = join(INBOX, "_review");
const INDEX_PATH = join(WIKI_ROOT, "index.md");
const LOG_PATH = join(WIKI_ROOT, "log.md");

const HAIKU = "claude-haiku-4-5-20251001";
const MAX_PER_RUN = 10;

export type TriageStatus = "processed" | "skipped" | "needs_review" | "error";
export type WikiSection = "YouTube" | "Articles" | "Claude Chats";

export interface TriageResult {
  inbox_file: string;
  status: TriageStatus;
  reason?: string;
  wiki_page?: string;
  slug?: string;
  url?: string;
  section?: WikiSection;
}

export interface TriageSummary {
  scanned: number;
  processed: number;
  review: number;
  skipped: number;
  errors: number;
  details: TriageResult[];
  rollup?: RollupSummary;
}

export interface RollupSummary {
  months_rolled: number;
  files_consolidated: number;
  errors: string[];
}

// ── Frontmatter + URL utilities ───────────

function parseFm(content: string): { fm: Record<string, string | boolean | null>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm: Record<string, string | boolean | null> = {};
  for (const line of m[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!key) continue;
    if (raw === "true") fm[key] = true;
    else if (raw === "false") fm[key] = false;
    else fm[key] = raw || null;
  }
  return { fm, body: m[2] };
}

function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)>\]"']+/i);
  return m?.[0]?.replace(/[),.;!?]+$/, "") ?? null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

function listExistingSlugs(): Set<string> {
  const slugs = new Set<string>();
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(join(dir, e.name));
        continue;
      }
      if (e.name.endsWith(".md")) slugs.add(e.name.replace(/\.md$/, ""));
    }
  }
  walk(WIKI_ROOT);
  return slugs;
}

function uniqueSlug(base: string, existing: Set<string>): string {
  if (!base) base = `untitled-${Date.now().toString(36)}`;
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const c = `${base}-${i}`;
    if (!existing.has(c)) return c;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function urlTypeRouting(urlType: UrlType): { section: WikiSection; dir: string } {
  switch (urlType) {
    case "video":
      return { section: "YouTube", dir: "sources/youtube" };
    case "claude_chat":
      return { section: "Claude Chats", dir: "sources/claude-chats" };
    case "article":
      return { section: "Articles", dir: "sources/articles" };
  }
}

// ── YouTube metadata (Phase A — transcript later) ───────────

interface VideoMeta {
  title: string;
  author: string | null;
  description: string | null;
  video_id: string | null;
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.endsWith("youtube.com")) {
      return (
        u.searchParams.get("v") ??
        u.pathname.match(/\/shorts\/([^/]+)/)?.[1] ??
        u.pathname.match(/\/embed\/([^/]+)/)?.[1] ??
        null
      );
    }
  } catch {
    /* noop */
  }
  return null;
}

async function fetchYouTubeMeta(url: string): Promise<VideoMeta> {
  const res = await fetch(url, { headers: { "User-Agent": "Grain/1.0" } });
  if (!res.ok) throw new Error(`YouTube fetch failed: ${res.status}`);
  const html = await res.text();

  const og = (prop: string): string | null => {
    const r1 = new RegExp(`<meta\\s+property=["']${prop}["']\\s+content=["']([^"']+)["']`, "i");
    const r2 = new RegExp(`<meta\\s+name=["']${prop}["']\\s+content=["']([^"']+)["']`, "i");
    return html.match(r1)?.[1] ?? html.match(r2)?.[1] ?? null;
  };

  const rawTitle =
    og("og:title") ??
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s*-\s*YouTube\s*$/i, "")?.trim() ??
    "YouTube video";
  const author =
    html.match(/"ownerChannelName":"([^"]+)"/)?.[1] ??
    html.match(/<link\s+itemprop=["']name["']\s+content=["']([^"']+)["']/i)?.[1] ??
    null;
  const description = og("og:description") ?? og("description");

  return {
    title: decodeHtml(rawTitle),
    author: author ? decodeHtml(author) : null,
    description: description ? decodeHtml(description) : null,
    video_id: extractYouTubeId(url),
  };
}

// ── Haiku shape classifier ───────────

interface Classification {
  suggested_slug: string;
  summary: string;
  key_claims: string[];
  tags: string[];
  cross_links: string[];
}

const CLASSIFIER_SYSTEM = `You are Milli's triage classifier. Given a newly ingested source, extract a filing record for the wiki.

Rules:
- suggested_slug: kebab-case, <= 50 chars, based on the core subject (not the full title)
- summary: 1-2 sentences in librarian register — factual, compressed, no hedging
- key_claims: 3-7 substantive claims, techniques, or positions the source makes. Skip chrome (intro, outro, sign-offs)
- tags: 2-6 lowercase kebab-case tags (topics, tools, domains)
- cross_links: ONLY return slugs from the provided existing-slugs list that genuinely relate. Empty array if none apply. NEVER invent slugs

Return JSON only, matching:
{"suggested_slug": "string", "summary": "string", "key_claims": ["..."], "tags": ["..."], "cross_links": ["..."]}`;

async function classify(params: {
  title: string;
  url: string;
  excerpt: string;
  existingSlugs: string[];
}): Promise<Classification> {
  const anthropic = getAnthropicClient(30_000);

  const userPrompt = [
    `Title: ${params.title}`,
    `URL: ${params.url}`,
    "",
    `Existing wiki slugs (cross-link candidates — choose only from this list):`,
    params.existingSlugs.length > 0 ? params.existingSlugs.join(", ") : "(none yet)",
    "",
    "Excerpt:",
    "---",
    params.excerpt.slice(0, 6000),
    "---",
    "",
    "Return JSON only.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 700,
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const match = text.replace(/```(?:json)?\s*|\s*```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("classifier returned no JSON");

  const parsed = JSON.parse(match[0]) as Partial<Classification>;
  return {
    suggested_slug: slugify(String(parsed.suggested_slug ?? params.title)),
    summary: String(parsed.summary ?? "").trim() || params.title,
    key_claims: Array.isArray(parsed.key_claims) ? parsed.key_claims.map(String).filter(Boolean) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => slugify(String(t))).filter(Boolean) : [],
    cross_links: Array.isArray(parsed.cross_links)
      ? parsed.cross_links.map(String).filter((s) => params.existingSlugs.includes(s))
      : [],
  };
}

// ── Source-page writers ───────────

function fmBlock(fields: Record<string, string | string[] | null>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${item}`);
      }
    } else if (typeof v === "string" && (v.includes(":") || v.startsWith("'") || v.includes("\n"))) {
      lines.push(`${k}: '${v.replace(/'/g, "''")}'`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function buildSourcePage(params: {
  urlType: UrlType;
  title: string;
  url: string;
  author: string | null;
  datePublished: string | null;
  classification: Classification;
  content: string;
  contentLabel: string;
  extraFm?: Record<string, string | null>;
}): string {
  const fm: Record<string, string | string[] | null> = {
    type: "source",
    source_type: params.urlType === "video" ? "youtube" : params.urlType === "claude_chat" ? "claude_chat" : "article",
    source_url: params.url,
    author: params.author,
    date_published: params.datePublished,
    ingested: today(),
    status: "draft",
    tags: params.classification.tags,
  };
  if (params.extraFm) Object.assign(fm, params.extraFm);

  const sections: string[] = [fmBlock(fm), "", `# ${params.title}`, "", params.classification.summary];

  if (params.classification.key_claims.length > 0) {
    sections.push("", "## Key claims");
    for (const c of params.classification.key_claims) sections.push(`- ${c}`);
  }

  if (params.classification.cross_links.length > 0) {
    sections.push("", "## Related");
    for (const slug of params.classification.cross_links) sections.push(`- [[${slug}]]`);
  }

  sections.push("", `## ${params.contentLabel}`, "", params.content.trim());

  return sections.join("\n") + "\n";
}

// ── Index + log updates ───────────

function updateIndex(section: WikiSection, slug: string, description: string): void {
  if (!existsSync(INDEX_PATH)) return;
  const existing = readFileSync(INDEX_PATH, "utf-8");
  const lines = existing.split("\n");

  // Find section header; if missing, append near end.
  let headerIdx = lines.findIndex((l) => l.trim() === `### ${section}`);
  if (headerIdx === -1) {
    // Try to insert under "## Sources (N ingested)"
    const sourcesIdx = lines.findIndex((l) => /^##\s+Sources\b/.test(l));
    const insertAt = sourcesIdx !== -1 ? sourcesIdx + lines.slice(sourcesIdx + 1).findIndex((l) => /^##\s/.test(l) || false) : lines.length;
    const anchor = sourcesIdx !== -1 ? sourcesIdx + 2 : lines.length; // after header + blank
    lines.splice(anchor, 0, ``, `### ${section}`, `- [[${slug}]] — ${description}`);
    writeFileSync(INDEX_PATH, lines.join("\n"));
    return;
  }

  // Find end of section (next ### or ## or EOF) and insert bullet at its tail
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // Back up past trailing blank lines
  let insertAt = endIdx;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `- [[${slug}]] — ${description}`);
  writeFileSync(INDEX_PATH, lines.join("\n"));
}

function appendLog(results: TriageResult[]): void {
  if (results.length === 0) return;
  const processed = results.filter((r) => r.status === "processed");
  if (processed.length === 0) return;

  const ts = new Date().toISOString();
  const lines = [``, `## ${ts} — triage`, `Processed ${processed.length} item${processed.length === 1 ? "" : "s"}:`];
  for (const r of processed) lines.push(`- [[${r.slug}]] ← ${r.inbox_file} (${r.section})`);

  const prefix = existsSync(LOG_PATH) ? "" : "---\ntype: log\n---\n# Wiki Log\n";
  appendFileSync(LOG_PATH, prefix + lines.join("\n") + "\n");
}

// ── Move helpers ───────────

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function moveToArchive(inboxPath: string, filename: string, wikiSlug: string): void {
  ensureDir(ARCHIVE);
  const existing = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : "";
  const { fm, body } = parseFm(existing);
  const stampedFm: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === true) stampedFm[k] = "true";
    else if (v === false) stampedFm[k] = "false";
    else stampedFm[k] = (v as string) ?? null;
  }
  stampedFm.status = "processed";
  stampedFm.processed_date = today();
  stampedFm.wiki_page = wikiSlug;

  const newContent = fmBlock(stampedFm) + "\n\n" + body.trim() + "\n";
  writeFileSync(inboxPath, newContent);

  renameSync(inboxPath, join(ARCHIVE, filename));
}

function moveToReview(inboxPath: string, filename: string, reason: string): void {
  ensureDir(REVIEW);
  try {
    const existing = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : "";
    const { fm, body } = parseFm(existing);
    const stampedFm: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (v === true) stampedFm[k] = "true";
      else if (v === false) stampedFm[k] = "false";
      else stampedFm[k] = (v as string) ?? null;
    }
    stampedFm.status = "needs_review";
    stampedFm.review_reason = reason;
    const newContent = fmBlock(stampedFm) + "\n\n" + body.trim() + "\n";
    writeFileSync(inboxPath, newContent);
  } catch {
    /* noop — just attempt the move */
  }
  renameSync(inboxPath, join(REVIEW, filename));
}

// ── Per-item processing ───────────

async function processItem(filename: string, existingSlugs: Set<string>): Promise<TriageResult> {
  const fullpath = join(INBOX, filename);
  const raw = readFileSync(fullpath, "utf-8");
  const { fm, body } = parseFm(raw);

  if (fm.status === "processed") {
    // Legacy processed items sitting in the top-level inbox — move to
    // _archive/ so Milli's count reflects actual backlog.
    try {
      ensureDir(ARCHIVE);
      renameSync(fullpath, join(ARCHIVE, filename));
    } catch {
      /* non-fatal */
    }
    return { inbox_file: filename, status: "skipped", reason: "already processed → archived" };
  }

  const url =
    (typeof fm.source_url === "string" && fm.source_url) ||
    extractFirstUrl(body) ||
    extractFirstUrl(raw);

  if (!url) {
    moveToReview(fullpath, filename, "no URL — raw note, Phase B");
    return { inbox_file: filename, status: "needs_review", reason: "no URL in item" };
  }

  const urlType = detectUrlType(url);
  const routing = urlTypeRouting(urlType);

  // Fetch content
  let title = "Untitled";
  let author: string | null = null;
  let content = "";
  let contentLabel = "Content";
  const extraFm: Record<string, string | null> = {};

  try {
    if (urlType === "video") {
      const meta = await fetchYouTubeMeta(url);
      title = meta.title;
      author = meta.author;
      content = meta.description ?? "(no description returned by YouTube)";
      contentLabel = "Description";
      extraFm.transcript = "pending";
      if (meta.video_id) extraFm.video_id = meta.video_id;
    } else if (urlType === "claude_chat") {
      const chat = await fetchClaudeChat(url);
      title = chat.title;
      content = chat.text.slice(0, 80_000);
      contentLabel = "Conversation";
    } else {
      // Article — prefer body text if it's already substantive (clipped transcript case)
      const bodyStripped = body.trim();
      if (bodyStripped.length > 1500) {
        content = bodyStripped;
        title = (fm.title as string | null) ?? extractFirstHeading(body) ?? filename.replace(/\.md$/, "");
        contentLabel = "Content (from clipper)";
      } else {
        const article = await fetchArticle(url);
        title = article.title;
        content = article.text.slice(0, 80_000);
        contentLabel = "Content";
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { inbox_file: filename, status: "error", url, reason: `fetch: ${msg}` };
  }

  // Classify
  const existingSlugList = Array.from(existingSlugs);
  let classification: Classification;
  try {
    classification = await classify({
      title,
      url,
      excerpt: content,
      existingSlugs: existingSlugList,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { inbox_file: filename, status: "error", url, reason: `classify: ${msg}` };
  }

  // Slug + uniqueness
  const slug = uniqueSlug(classification.suggested_slug, existingSlugs);
  existingSlugs.add(slug);

  // Write source page
  const sourceDir = join(WIKI_ROOT, routing.dir);
  ensureDir(sourceDir);
  const pagePath = join(sourceDir, `${slug}.md`);
  const pageContent = buildSourcePage({
    urlType,
    title,
    url,
    author,
    datePublished: null,
    classification,
    content,
    contentLabel,
    extraFm,
  });
  writeFileSync(pagePath, pageContent);

  // Update index + log
  updateIndex(routing.section, slug, `${classification.summary.split(/(?<=[.!?])\s/)[0] ?? title}`);

  // Move inbox file to archive
  moveToArchive(fullpath, filename, slug);

  return {
    inbox_file: filename,
    status: "processed",
    url,
    slug,
    section: routing.section,
    wiki_page: pagePath.replace(VAULT_ROOT + "/", ""),
  };
}

function extractFirstHeading(body: string): string | null {
  const m = body.match(/^#+\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

// ── Monthly archive rollup ───────────
// Every tick, consolidate fully-elapsed months of _archive/*.md into a
// single _archive/YYYY-MM.md index file, then delete the individual stubs.
// Keeps the audit trail searchable while bounding disk growth.
// Idempotent — never touches the current month, never re-rolls an existing
// rollup file.

interface ArchivedStub {
  filename: string;
  processed_date: string | null;
  wiki_slug: string | null;
}

function readArchivedStub(filename: string): ArchivedStub | null {
  const full = join(ARCHIVE, filename);
  try {
    const content = readFileSync(full, "utf-8");
    const { fm, body } = parseFm(content);
    const processed_date =
      (typeof fm.processed_date === "string" && fm.processed_date) ||
      (typeof fm.ingested === "string" && fm.ingested) ||
      null;
    // Prefer explicit wiki_page frontmatter; fall back to scanning body for
    // legacy "processed to wiki: [[slug]]" note.
    let wiki_slug: string | null =
      typeof fm.wiki_page === "string" && fm.wiki_page ? fm.wiki_page : null;
    if (!wiki_slug) {
      const m = body.match(/\[\[([a-z0-9-]+)\]\]/);
      if (m) wiki_slug = m[1];
    }
    return { filename, processed_date, wiki_slug };
  } catch {
    return null;
  }
}

function monthKeyOf(iso: string | null): string | null {
  if (!iso || iso.length < 7) return null;
  const key = iso.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : null;
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export function rollupArchive(): RollupSummary {
  const summary: RollupSummary = { months_rolled: 0, files_consolidated: 0, errors: [] };
  if (!existsSync(ARCHIVE)) return summary;

  const currentMonth = currentMonthKey();
  const entries = readdirSync(ARCHIVE, { withFileTypes: true });

  // Gather stubs (non-rollup .md files) and group by month
  const byMonth = new Map<string, ArchivedStub[]>();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    // Skip existing rollup files (YYYY-MM.md shape)
    if (/^\d{4}-\d{2}\.md$/.test(e.name)) continue;
    const stub = readArchivedStub(e.name);
    if (!stub) continue;
    const mk = monthKeyOf(stub.processed_date);
    if (!mk) continue;
    if (mk === currentMonth) continue; // never roll the current month
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk)!.push(stub);
  }

  for (const [mk, stubs] of byMonth) {
    try {
      const rollupPath = join(ARCHIVE, `${mk}.md`);
      const existing = existsSync(rollupPath) ? readFileSync(rollupPath, "utf-8") : null;

      // Build new rollup body — merge with existing if present
      stubs.sort((a, b) => (a.processed_date ?? "").localeCompare(b.processed_date ?? ""));

      const header = existing
        ? existing.replace(/\n*$/, "") + "\n"
        : [
            "---",
            "type: archive-rollup",
            `month: '${mk}'`,
            "---",
            "",
            `# Inbox Archive — ${mk}`,
            "",
          ].join("\n");

      const lines: string[] = [];
      for (const s of stubs) {
        const date = s.processed_date ?? "(undated)";
        const slugLink = s.wiki_slug ? `[[${s.wiki_slug}]]` : "(no wiki page recorded)";
        lines.push(`- ${date} ${slugLink} ← ${s.filename}`);
      }

      writeFileSync(rollupPath, header + lines.join("\n") + "\n");

      // Delete the individual stubs
      for (const s of stubs) {
        try {
          unlinkSync(join(ARCHIVE, s.filename));
        } catch (err) {
          summary.errors.push(`unlink ${s.filename}: ${err instanceof Error ? err.message : err}`);
        }
      }

      summary.months_rolled++;
      summary.files_consolidated += stubs.length;
    } catch (err) {
      summary.errors.push(`rollup ${mk}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return summary;
}

// ── Public entrypoint ───────────

export async function processInbox(): Promise<TriageSummary> {
  if (!existsSync(INBOX)) {
    return { scanned: 0, processed: 0, review: 0, skipped: 0, errors: 0, details: [] };
  }

  const files = readdirSync(INBOX)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .slice(0, MAX_PER_RUN);

  const existingSlugs = listExistingSlugs();
  const details: TriageResult[] = [];

  for (const f of files) {
    try {
      const result = await processItem(f, existingSlugs);
      details.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      details.push({ inbox_file: f, status: "error", reason: msg });
    }
  }

  appendLog(details);

  // Consolidate prior-month archives into monthly rollup files.
  const rollup = rollupArchive();

  const processed = details.filter((d) => d.status === "processed").length;
  const review = details.filter((d) => d.status === "needs_review").length;
  const skipped = details.filter((d) => d.status === "skipped").length;
  const errors = details.filter((d) => d.status === "error").length;

  return { scanned: files.length, processed, review, skipped, errors, details, rollup };
}

// ── Stub writer (Telegram → inbox) ───────────
// Called by runMilliIngest when Ben drops a URL in Telegram. Writes a
// minimal unprocessed inbox item; the next triage tick picks it up.

export interface InboxStubResult {
  url: string;
  filename: string;
  path: string;
}

export function writeInboxStub(url: string, note?: string): InboxStubResult {
  ensureDir(INBOX);
  const ts = new Date().toISOString();
  const date = ts.split("T")[0];
  const timeTag = ts.slice(11, 19).replace(/:/g, "");
  const slug = slugify(url.replace(/^https?:\/\//, "")).slice(0, 40) || "url";
  const filename = `${date}-${timeTag}-${slug}.md`;
  const path = join(INBOX, filename);

  const fm = fmBlock({
    type: "inbox",
    status: "unprocessed",
    source: "telegram",
    source_url: url,
    captured_at: ts,
  });
  const body = note?.trim() ? `\n${note.trim()}\n\n${url}\n` : `\n${url}\n`;

  writeFileSync(path, fm + "\n" + body);
  return { url, filename, path };
}
