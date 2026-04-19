/**
 * Run Milli — wiki triage + librarian. Local execution.
 *
 * Triage phase processes 00-inbox/ items: fetches content, classifies shape,
 * writes source pages under 60-reference/wiki/sources/, updates index + log,
 * archives the inbox file. Then the librarian lint runs over the result.
 *
 * Usage: cd ~/Documents/Apps/grain && npx tsx scripts/run-milli.ts
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { runAndWriteWikiLibrarian } from "@/lib/agents/wiki-librarian";
import { processInbox } from "@/lib/agents/wiki-triage";

async function main() {
  console.log("Milli triage...");
  const triage = await processInbox();
  console.log(
    `  scanned=${triage.scanned} processed=${triage.processed} review=${triage.review} skipped=${triage.skipped} errors=${triage.errors}`,
  );
  for (const d of triage.details) {
    const tag = d.status.padEnd(13);
    const url = d.url ? ` ${d.url}` : "";
    const reason = d.reason ? ` — ${d.reason}` : "";
    const slug = d.slug ? ` → [[${d.slug}]]` : "";
    console.log(`  ${tag} ${d.inbox_file}${slug}${url}${reason}`);
  }

  console.log("");
  console.log("Milli lint...");
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
