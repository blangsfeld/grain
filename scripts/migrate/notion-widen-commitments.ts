/**
 * Widen Notion Personal Commitments DB schema so Buddy's semantic reply
 * interpreter has places to write evolution, conversation, and softer state.
 *
 * Additive only — existing properties and select options are preserved. Run
 * with `--dry` to print the diff without hitting Notion.
 *
 * Adds (if missing):
 *   - Status select options: Recurring, Evolved, Dormant, Not a thing
 *     (existing: Open, In Progress, Waiting, Done)
 *   - Evolved To: single_property relation → same DB (self-reference)
 *   - Conversation Log: rich_text (Buddy's append-only per-item journal)
 *
 * Safe to re-run. Idempotent: each field is checked for existence and
 * missing options are merged on top of the current select definition with
 * original ids preserved (Notion's databases.update deletes omitted options).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const NEW_STATUS_OPTIONS: Array<{ name: string; color: string }> = [
  { name: "Recurring", color: "purple" },
  { name: "Evolved", color: "pink" },
  { name: "Dormant", color: "gray" },
  { name: "Not a thing", color: "default" },
];

const DRY = process.argv.includes("--dry");

interface NotionDatabase {
  id: string;
  title: Array<{ plain_text: string }>;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  id: string;
  type: string;
  name?: string;
  [key: string]: unknown;
}

type SelectOption = {
  id?: string;
  name: string;
  color?: string;
};

function token(): string {
  const t = process.env.NOTION_API_KEY;
  if (!t) throw new Error("NOTION_API_KEY missing");
  return t;
}

function dbId(): string {
  const id = process.env.NOTION_PERSONAL_COMMITMENTS_DB_ID;
  if (!id) throw new Error("NOTION_PERSONAL_COMMITMENTS_DB_ID missing");
  return id;
}

async function fetchDatabase(): Promise<NotionDatabase> {
  const res = await fetch(`${NOTION_API}/databases/${dbId()}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fetch database failed: ${res.status} ${body}`);
  }
  return (await res.json()) as NotionDatabase;
}

async function updateDatabase(properties: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${NOTION_API}/databases/${dbId()}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`update database failed: ${res.status} ${body}`);
  }
}

function mergeStatusOptions(current: NotionProperty): {
  options: SelectOption[];
  added: string[];
} {
  const existing: SelectOption[] =
    ((current.select as { options: SelectOption[] } | undefined)?.options ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      color: o.color,
    }));
  const known = new Set(existing.map((o) => o.name.toLowerCase()));
  const added: string[] = [];
  const next: SelectOption[] = [...existing];
  for (const opt of NEW_STATUS_OPTIONS) {
    if (known.has(opt.name.toLowerCase())) continue;
    next.push({ name: opt.name, color: opt.color });
    added.push(opt.name);
  }
  return { options: next, added };
}

async function main() {
  const db = await fetchDatabase();
  console.log("DB:", db.title.map((t) => t.plain_text).join(""), "—", db.id);
  console.log(DRY ? "\n[DRY RUN — no writes]\n" : "");

  const payload: Record<string, unknown> = {};
  const plan: string[] = [];

  // 1. Status — merge new options into existing.
  const statusProp = db.properties["Status"];
  if (!statusProp || statusProp.type !== "select") {
    throw new Error("Status property missing or not a select — refusing to overwrite");
  }
  const { options: mergedStatus, added: addedStatus } = mergeStatusOptions(statusProp);
  if (addedStatus.length > 0) {
    payload["Status"] = { select: { options: mergedStatus } };
    plan.push(`Status: add options → ${addedStatus.join(", ")}`);
  } else {
    plan.push("Status: all four new options already present — skip");
  }

  // 2. Evolved To — self-referential single_property relation.
  if (!db.properties["Evolved To"]) {
    payload["Evolved To"] = {
      relation: {
        database_id: db.id,
        type: "single_property",
        single_property: {},
      },
    };
    plan.push("Evolved To: add self-referential relation");
  } else {
    plan.push("Evolved To: already present — skip");
  }

  // 3. Conversation Log — rich_text.
  if (!db.properties["Conversation Log"]) {
    payload["Conversation Log"] = { rich_text: {} };
    plan.push("Conversation Log: add rich_text");
  } else {
    plan.push("Conversation Log: already present — skip");
  }

  console.log("Plan:");
  for (const line of plan) console.log(" •", line);
  console.log("");

  if (Object.keys(payload).length === 0) {
    console.log("Nothing to do — schema is already wide enough.");
    return;
  }

  if (DRY) {
    console.log("Payload (would PATCH):");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  await updateDatabase(payload);
  console.log("Schema updated. Refetching to verify...\n");

  const after = await fetchDatabase();
  const statusAfter = (
    (after.properties["Status"]?.select as { options: SelectOption[] } | undefined)?.options ?? []
  )
    .map((o) => o.name)
    .join(", ");
  console.log("Status options:", statusAfter);
  console.log("Evolved To:", after.properties["Evolved To"]?.type ?? "MISSING");
  console.log("Conversation Log:", after.properties["Conversation Log"]?.type ?? "MISSING");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
