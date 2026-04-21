/**
 * Smoke test for the semantic reply interpreter.
 *
 * Fires runBuddySurface against chat_id=-1 so a fresh menu (with kept_index)
 * exists, then runs classifyReply (write-free) across several canonical
 * shapes and prints what would be applied. No Notion writes — safe to run.
 *
 *   npx tsx scripts/smoke-buddy-evolve.ts
 *
 * Cleanup:
 *   delete from buddy_pending_menus where chat_id = -1;
 */
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { runBuddySurface } from "@/lib/agents/buddy-synthesize";
import { classifyReply } from "@/lib/agents/buddy-evolve";

const TEST_CHAT_ID = -1;

const REPLY_SHAPES = [
  "that's done",
  "retire the first one — it was never really a thing",
  "bump 2 to next week",
  "the third one evolved into 5",
  "just a thought on 1 — I was thinking about this wrong",
  "hey buddy what's on my plate",
  "https://example.com",
];

async function main() {
  console.log(`Preparing synthesis menu for chat_id=${TEST_CHAT_ID}...\n`);
  const { synthesis } = await runBuddySurface(TEST_CHAT_ID);
  console.log(
    `Menu ready: ${synthesis.kept_index.length} kept · ${synthesis.plate_index.length} plate · ${synthesis.attention.length} attention.`,
  );
  console.log("\nKept list (1-indexed):");
  for (let i = 0; i < synthesis.kept_index.length; i++) {
    const k = synthesis.kept_index[i];
    console.log(`  ${i + 1}. "${k.name}" (${k.category ?? "—"} · ${k.status ?? "—"})`);
  }

  console.log("\n" + "=".repeat(72));
  for (const reply of REPLY_SHAPES) {
    console.log(`\n# Reply: "${reply}"`);
    const t0 = Date.now();
    const result = await classifyReply(TEST_CHAT_ID, reply);
    const ms = Date.now() - t0;
    console.log(`  → ${result.kind} (${ms}ms)`);

    if (result.kind === "updates") {
      for (const u of result.updates) {
        const ref = result.kept[u.kept_index - 1];
        const name = ref ? `"${ref.name}"` : `#${u.kept_index} (missing)`;
        const extras: string[] = [];
        if (u.evolved_to_kept_index) {
          const target = result.kept[u.evolved_to_kept_index - 1];
          extras.push(`→ ${target ? `"${target.name}"` : `#${u.evolved_to_kept_index}`}`);
        }
        if (u.new_due_date) extras.push(`due ${u.new_due_date}`);
        console.log(
          `    · ${name} → ${u.action}${extras.length ? ` (${extras.join(", ")})` : ""}`,
        );
        console.log(`      log: ${u.log_entry}`);
      }
    } else if (result.kind === "clarify" && result.clarify) {
      console.log(`    ? ${result.clarify.question}`);
      for (const idx of result.clarify.candidate_kept_indexes) {
        const item = result.kept[idx - 1];
        console.log(`        - ${idx}. ${item ? `"${item.name}"` : "(out of range)"}`);
      }
    }
  }

  console.log(
    "\nDone. Clean up with: delete from buddy_pending_menus where chat_id = -1;\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
