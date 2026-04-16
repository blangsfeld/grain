/**
 * Materialize agent outputs into the Obsidian vault.
 * Reads latest agent_outputs from Supabase, writes 70-agents/{agent_id}.md.
 * Also materializes pending desk_captures into their vault destinations.
 *
 * Run at /boot: cd ~/Documents/Apps/grain && npx tsx scripts/materialize-agents.ts
 * Designed to be called from the /boot skill sequence.
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const VAULT = join(process.env.HOME || "", "Documents/Obsidian/Studio");
const AGENTS_DIR = join(VAULT, "70-agents");
const IDEAS_DIR = join(VAULT, "20-ideas");
const INBOX_DIR = join(VAULT, "00-inbox");
const DECISIONS_DIR = join(VAULT, "30-decisions");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Agent outputs → 70-agents/*.md ─────────────────

const AGENT_IDS = [
  "grain-steward",   // Guy
  "ea",              // Buddy
  "security-steward",// Dood
  "what-if",         // Bruh
  "columnist",       // Clark
  "wiki-librarian",  // Milli
  "notion-steward",  // Timi
];

async function materializeAgentOutputs() {
  console.log("Materializing agent outputs...");
  ensureDir(AGENTS_DIR);

  for (const agent_id of AGENT_IDS) {
    const { data, error } = await supabase
      .from("agent_outputs")
      .select("run_at, severity, markdown")
      .eq("agent_id", agent_id)
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`  ✗ ${agent_id}: ${error.message}`);
      continue;
    }
    if (!data) {
      console.log(`  - ${agent_id}: no output yet`);
      continue;
    }

    const filePath = join(AGENTS_DIR, `${agent_id}.md`);
    writeFileSync(filePath, data.markdown as string, "utf-8");
    console.log(`  ✓ ${agent_id} → ${agent_id}.md (${data.severity}, ${data.run_at})`);
  }
}

// ── Desk captures → vault destinations ─────────────

const DESTINATION_MAP: Record<string, string> = {
  "wiki-inbox": INBOX_DIR,
  "ideas": IDEAS_DIR,
  "decisions": DECISIONS_DIR,
  "commitments": INBOX_DIR, // commitments go to inbox for manual triage
  "reference": INBOX_DIR,
  "loops": INBOX_DIR,
};

async function materializeDeskCaptures() {
  console.log("\nMaterializing pending desk captures...");

  const { data, error } = await supabase
    .from("desk_captures")
    .select("id, created_at, raw_text, kind, proposed_destination, classification_reason, reply_text")
    .eq("status", "pending")
    .eq("kind", "capture") // only file actual captures, not queries/commands/unknowns
    .order("created_at", { ascending: true });

  if (error) {
    console.error(`  ✗ desk_captures query: ${error.message}`);
    return;
  }

  if (!data || data.length === 0) {
    console.log("  - no pending captures");
    return;
  }

  let filed = 0;
  for (const capture of data) {
    const dest = capture.proposed_destination as string | null;
    const destDir = dest ? DESTINATION_MAP[dest] : INBOX_DIR;

    if (!destDir) {
      console.log(`  - skipping ${capture.id} (destination: ${dest})`);
      continue;
    }

    ensureDir(destDir);

    // Generate filename from timestamp + first few words
    const date = new Date(capture.created_at as string);
    const dateStr = date.toISOString().slice(0, 10);
    const slug = (capture.raw_text as string || "capture")
      .slice(0, 40)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+$/, "");
    const filename = `${dateStr}-${slug}.md`;
    const filePath = join(destDir, filename);

    // Build the capture file
    const lines: string[] = [];
    lines.push("---");
    lines.push(`type: desk-capture`);
    lines.push(`source: telegram`);
    lines.push(`captured_at: ${capture.created_at}`);
    lines.push(`kind: ${capture.kind}`);
    lines.push(`destination: ${dest ?? "inbox"}`);
    lines.push(`reason: ${capture.classification_reason ?? ""}`);
    lines.push("---");
    lines.push("");
    lines.push(capture.raw_text as string || "_(empty capture)_");
    lines.push("");
    if (capture.reply_text) {
      lines.push("---");
      lines.push(`_Keys replied: ${(capture.reply_text as string).slice(0, 200)}_`);
    }

    writeFileSync(filePath, lines.join("\n"), "utf-8");

    // Mark as filed in Supabase
    await supabase
      .from("desk_captures")
      .update({
        status: "filed",
        filed_at: new Date().toISOString(),
        filed_path: filePath.replace(VAULT + "/", ""),
      })
      .eq("id", capture.id);

    console.log(`  ✓ ${filename} → ${dest ?? "inbox"}`);
    filed++;
  }

  console.log(`  ${filed} capture(s) filed.`);
}

// ── Main ───────────────────────────────────────────

async function main() {
  if (!existsSync(VAULT)) {
    console.error(`Vault not found at ${VAULT}`);
    process.exit(1);
  }

  await materializeAgentOutputs();
  await materializeDeskCaptures();
  console.log("\nDone. Vault is current.");
}

main().catch((err) => {
  console.error("materialize error:", err);
  process.exit(1);
});
