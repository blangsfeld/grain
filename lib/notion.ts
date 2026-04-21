/**
 * Thin Notion API client for Timi (notion-steward agent).
 *
 * Starts with read-only database queries; write helpers are scoped to
 * updates Timi proposes when we wire v2 (Keys-triggered writes). Only the
 * surface Timi actually uses lives here — grow deliberately.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ── Types (minimal — just what Timi reads) ─────────

export type NotionPropertyValue = {
  id: string;
  type: string;
  // Every type has its own payload; we use index signatures to stay permissive.
  [key: string]: unknown;
};

export interface NotionPage {
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, NotionPropertyValue>;
  archived: boolean;
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

// ── Client ─────────────────────────────────────────

function getToken(): string {
  const token = process.env.NOTION_API_KEY;
  if (!token) throw new Error("NOTION_API_KEY missing");
  return token;
}

async function notionFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Query all pages in a database. Handles pagination automatically.
 * `filter` and `sorts` follow Notion's API shape (pass through).
 */
export async function queryDatabase(
  database_id: string,
  options: { filter?: unknown; sorts?: unknown; page_size?: number } = {},
): Promise<NotionPage[]> {
  const all: NotionPage[] = [];
  let cursor: string | null = null;
  const pageSize = options.page_size ?? 100;

  do {
    const body: Record<string, unknown> = { page_size: pageSize };
    if (options.filter) body.filter = options.filter;
    if (options.sorts) body.sorts = options.sorts;
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch<NotionQueryResponse>(
      `/databases/${database_id}/query`,
      { method: "POST", body: JSON.stringify(body) },
    );
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return all;
}

// ── Property helpers ───────────────────────────────
// Notion's property values are nested by type. These unwrap the common ones
// Timi reads, returning plain values so the agent code stays legible.

export function getTitle(page: NotionPage, propName = "Name"): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "title") return "";
  const parts = (prop.title as Array<{ plain_text: string }> | undefined) ?? [];
  return parts.map((p) => p.plain_text).join("").trim();
}

export function getSelect(page: NotionPage, propName: string): string | null {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "select") return null;
  const sel = prop.select as { name: string } | null;
  return sel?.name ?? null;
}

export function getMultiSelect(page: NotionPage, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "multi_select") return [];
  const items = (prop.multi_select as Array<{ name: string }> | undefined) ?? [];
  return items.map((i) => i.name);
}

export function getRichText(page: NotionPage, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "rich_text") return "";
  const parts = (prop.rich_text as Array<{ plain_text: string }> | undefined) ?? [];
  return parts.map((p) => p.plain_text).join("").trim();
}

export function getDate(page: NotionPage, propName: string): string | null {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "date") return null;
  const d = prop.date as { start: string } | null;
  return d?.start ?? null;
}

export function getUrl(page: NotionPage, propName: string): string | null {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "url") return null;
  return (prop.url as string) ?? null;
}

export function getNumber(page: NotionPage, propName: string): number | null {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "number") return null;
  const n = prop.number;
  return typeof n === "number" ? n : null;
}

export function getRelationIds(page: NotionPage, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "relation") return [];
  const items = (prop.relation as Array<{ id: string }> | undefined) ?? [];
  return items.map((i) => i.id);
}

// ── Property builders (for writes) ─────────────────
// Notion writes expect properties in the typed-object shape. These builders
// keep the call sites in agent code readable.

export function titleProp(text: string): NotionPropertyValue {
  return {
    id: "",
    type: "title",
    title: [{ type: "text", text: { content: text } }],
  } as NotionPropertyValue;
}

export function selectProp(name: string): NotionPropertyValue {
  return {
    id: "",
    type: "select",
    select: { name },
  } as NotionPropertyValue;
}

export function richTextProp(text: string): NotionPropertyValue {
  return {
    id: "",
    type: "rich_text",
    rich_text: [{ type: "text", text: { content: text } }],
  } as NotionPropertyValue;
}

export function dateProp(startISO: string): NotionPropertyValue {
  return {
    id: "",
    type: "date",
    date: { start: startISO },
  } as NotionPropertyValue;
}

export function relationProp(pageIds: string[]): NotionPropertyValue {
  return {
    id: "",
    type: "relation",
    relation: pageIds.map((id) => ({ id })),
  } as NotionPropertyValue;
}

// ── Page create ────────────────────────────────────

export interface CreatePageResult {
  id: string;
  url: string;
}

/**
 * Create a page in a database. `properties` uses the Notion property-object
 * shape — use the prop builders above to construct it.
 */
export async function createPage(
  database_id: string,
  properties: Record<string, NotionPropertyValue>,
): Promise<CreatePageResult> {
  const body = {
    parent: { database_id },
    properties,
  };
  const res = await notionFetch<{ id: string; url: string }>("/pages", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { id: res.id, url: res.url };
}

// ── Page update ────────────────────────────────────

/**
 * Update properties on an existing page. Only properties you pass are changed;
 * others stay as-is. Use the prop builders to construct values.
 */
export async function updatePage(
  page_id: string,
  properties: Record<string, NotionPropertyValue>,
): Promise<void> {
  await notionFetch(`/pages/${page_id}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

// ── Page fetch ─────────────────────────────────────

export async function getPage(page_id: string): Promise<NotionPage> {
  return notionFetch<NotionPage>(`/pages/${page_id}`);
}

// ── Append-only rich_text helper ───────────────────

/**
 * Append a timestamped line to a rich_text property without losing prior
 * content. Used for Buddy's per-item Conversation Log. The fetch-then-write
 * is not transactional — concurrent writers can race — but Buddy is the
 * only process writing this field, so a race is a non-goal.
 *
 * Each entry is prefixed with `YYYY-MM-DD · ` so the log reads as a journal.
 */
export async function appendRichText(
  page_id: string,
  propName: string,
  entry: string,
): Promise<string> {
  const page = await getPage(page_id);
  const existing = getRichText(page, propName);
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `${stamp} · ${entry.trim()}`;
  const merged = existing ? `${existing}\n${line}` : line;
  await updatePage(page_id, { [propName]: richTextProp(merged) });
  return merged;
}

// ── Age helpers ────────────────────────────────────

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}
