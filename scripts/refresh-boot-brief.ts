/**
 * On-demand refresh of 70-agents/boot-brief.md. The orchestrator rebuilds
 * this each tick, but /boot can call this directly when something just
 * happened and stale by-the-tick isn't good enough.
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { materializeBootBrief } from "../lib/boot-brief";

async function main() {
  const r = await materializeBootBrief();
  if (!r.ok) {
    console.error(`refresh failed: ${r.reason ?? "unknown"}`);
    process.exit(1);
  }
  console.log(`✓ ${r.path}`);
  console.log(`  sections=${r.sections} anomalies=${r.anomalies}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
