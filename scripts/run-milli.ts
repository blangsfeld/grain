/**
 * Run Milli — wiki librarian (agent version). Local execution.
 *
 * Usage: cd ~/Documents/Apps/grain && npx tsx scripts/run-milli.ts
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { runAndWriteWikiLibrarian } from "@/lib/agents/wiki-librarian";

async function main() {
  console.log("Milli running...");
  const { output_id, report } = await runAndWriteWikiLibrarian();
  console.log("");
  console.log(`✓ written: agent_outputs id=${output_id}`);
  console.log(`  severity: ${report.severity}`);
  console.log(`  pages: ${report.facts.total_pages}`);
  console.log(`  inbox: ${report.facts.inbox}`);
  console.log(`  broken_links: ${report.facts.broken_links}`);
  console.log(`  orphans: ${report.facts.orphans}`);
  console.log(`  siblings read: guy=${report.had_siblings.guy}, buddy=${report.had_siblings.buddy}`);
}

main().catch((err) => {
  console.error("milli error:", err);
  process.exit(1);
});
