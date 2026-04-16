/**
 * Smoke test for runBuddyAdd.
 * Writes a test page to the Notion Personal Commitments DB, logs URL,
 * leaves it for manual cleanup (or Ben can mark Done).
 */
import { config as loadDotenv } from "dotenv";
import { join } from "path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { runBuddyAdd } from "@/lib/agents/ea";

async function main() {
  const res = await runBuddyAdd({
    statement: "grain smoke test — delete this",
    notes: "Created by scripts/smoke-buddy-add.ts to verify the Notion write path.",
    source: "Manual",
  });
  console.log("OK:", res);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
