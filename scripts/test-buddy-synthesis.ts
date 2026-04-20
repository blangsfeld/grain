/**
 * Test Buddy's synthesis pass locally. Prints both output shapes:
 * — Morning map (what Buddy would surface to Telegram)
 * — Single-thread focus (what Ben sees when he picks one)
 *
 * Does NOT write anywhere. Read-only probe of the synthesis quality.
 */
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import {
  runBuddySynthesis,
  formatBriefing,
  formatItemFocus,
  formatTaskDelivery,
} from "@/lib/agents/buddy-synthesize";

async function main() {
  console.log("Running Buddy synthesis...\n");
  const t0 = Date.now();
  const s = await runBuddySynthesis();
  const ms = Date.now() - t0;

  console.log(`Generated in ${ms}ms`);
  console.log(`Siblings read: ${s.siblings_read.join(", ")}`);
  console.log(
    `Corpus: ${s.corpus_sizes.plate} plate · ${s.corpus_sizes.kept} kept · ${s.corpus_sizes.tensions} tensions · ${s.corpus_sizes.beliefs} beliefs`,
  );
  console.log(
    `Sections: ${s.attention.length} attention · ${s.carried_forward.length} carried · ${s.others_owe_you.length} owed · ${s.patterns.length} patterns · ${s.tasks_can_help_with.length} tasks`,
  );
  if (s.voice_warnings.length > 0) {
    console.log(`⚠ Voice warnings: ${s.voice_warnings.join("; ")}`);
  }
  console.log("");
  console.log("=".repeat(72));
  console.log("BRIEFING");
  console.log("=".repeat(72));
  console.log(formatBriefing(s));

  if (s.attention.length > 0) {
    console.log("");
    console.log("=".repeat(72));
    console.log("ITEM FOCUS (attention #1)");
    console.log("=".repeat(72));
    console.log(formatItemFocus(s.attention[0]));
  }

  const draftTask = s.tasks_can_help_with.find((t) => t.draft);
  if (draftTask) {
    console.log("");
    console.log("=".repeat(72));
    console.log(`TASK DELIVERY — "${draftTask.title}"`);
    console.log("=".repeat(72));
    console.log(formatTaskDelivery(draftTask));
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
