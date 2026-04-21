/**
 * One-off: dump the current Notion Personal Commitments DB schema so we can
 * see Status options, existing property names, and relation configs before
 * designing the schema widening.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const token = process.env.NOTION_API_KEY;
  const dbId = process.env.NOTION_PERSONAL_COMMITMENTS_DB_ID;
  if (!token) throw new Error("NOTION_API_KEY missing");
  if (!dbId) throw new Error("NOTION_PERSONAL_COMMITMENTS_DB_ID missing");

  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!res.ok) {
    console.error("Notion fetch failed:", res.status, await res.text());
    process.exit(1);
  }
  const db = (await res.json()) as {
    id: string;
    title: Array<{ plain_text: string }>;
    properties: Record<string, { id: string; type: string; [key: string]: unknown }>;
  };

  console.log("## DB:", db.title.map((t) => t.plain_text).join(""), "—", db.id);
  console.log("");
  console.log("## Properties");
  for (const [name, prop] of Object.entries(db.properties)) {
    console.log(`- ${name} [${prop.type}]`);
    if (prop.type === "select" || prop.type === "multi_select") {
      const options = (prop[prop.type] as { options: Array<{ name: string; color: string }> })?.options ?? [];
      for (const o of options) console.log(`    · ${o.name} (${o.color})`);
    }
    if (prop.type === "relation") {
      const rel = prop.relation as { database_id: string; type?: string; single_property?: unknown; dual_property?: unknown };
      console.log(`    · → ${rel.database_id} (${rel.type ?? "?"})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
