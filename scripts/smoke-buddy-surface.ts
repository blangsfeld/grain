/**
 * Smoke test for runBuddySurface + resolveSynthesisReply.
 *
 * Runs synthesis, persists the menu keyed to a test chat_id, prints the
 * briefing, then exercises the reply resolver on several shapes to confirm
 * routing: "2", "#3", "task 1", "carry 1", gibberish (falls through).
 *
 * Does NOT send to Telegram. Uses a synthetic chat_id so it doesn't
 * overwrite Ben's real menu. The inserted row stays in
 * buddy_pending_menus for inspection — safe to clean up with:
 *   delete from buddy_pending_menus where chat_id = -1;
 */
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import {
  runBuddySurface,
  resolveSynthesisReply,
} from "@/lib/agents/buddy-synthesize";

const TEST_CHAT_ID = -1;

async function main() {
  console.log(`Running Buddy surface for chat_id=${TEST_CHAT_ID}...\n`);
  const t0 = Date.now();
  const { synthesis, menu_id, message } = await runBuddySurface(TEST_CHAT_ID);
  const ms = Date.now() - t0;

  console.log(`Surface generated in ${ms}ms`);
  console.log(`Menu id: ${menu_id}`);
  console.log(
    `Sections: ${synthesis.attention.length} attention · ${synthesis.carried_forward.length} carried · ${synthesis.others_owe_you.length} owed · ${synthesis.patterns.length} patterns · ${synthesis.tasks_can_help_with.length} tasks`,
  );
  if (synthesis.voice_warnings.length > 0) {
    console.log(`⚠ Voice warnings: ${synthesis.voice_warnings.join("; ")}`);
  }
  console.log("");
  console.log("=".repeat(72));
  console.log("BRIEFING (what Telegram would receive)");
  console.log("=".repeat(72));
  console.log(message);
  console.log("");

  const probes = ["2", "#1", "task 1", "t1", "carry 1", "c1", "watch 1", "help 2", "hello buddy"];
  console.log("=".repeat(72));
  console.log("REPLY RESOLUTION");
  console.log("=".repeat(72));
  for (const probe of probes) {
    const r = await resolveSynthesisReply(TEST_CHAT_ID, probe);
    const preview = r.message.split("\n")[0].slice(0, 70);
    console.log(`  "${probe}" → kind=${r.kind} section=${r.section ?? "—"} idx=${r.index ?? "—"}  ${preview}`);
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
