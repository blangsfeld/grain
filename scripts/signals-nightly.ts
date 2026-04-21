/**
 * Run the nightly Tier-1 pipeline end-to-end for local testing or
 * Mac-orchestrator invocation. Tier 2 lives in a separate file when built.
 *
 * Usage:
 *   npx tsx scripts/signals-nightly.ts              # today
 *   npx tsx scripts/signals-nightly.ts 2026-04-21   # explicit date
 *   npx tsx scripts/signals-nightly.ts --no-compose # skip vault write
 */

import { config as loadDotenv } from "dotenv";
import { join } from "path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { runNightlyTier1 } from "@/lib/signal-engine/nightly";
import { composeNightly } from "@/lib/signal-engine/compose";

async function main() {
  const argv = process.argv.slice(2);
  const noCompose = argv.includes("--no-compose");
  const composeOnly = argv.includes("--compose-only");
  const dateArg = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const runDate = dateArg ?? new Date().toISOString().slice(0, 10);

  if (composeOnly) {
    console.log(`Composing nightly narrative for ${runDate} from existing run...`);
    const compose = await composeNightly(runDate);
    console.log();
    console.log("=== Composer ===");
    console.log(`  Vault path: ${compose.vault_path ?? "(not written)"}`);
    console.log(`  Tokens:     ${compose.tokens}`);
    console.log();
    console.log("--- narrative ---");
    console.log(compose.narrative);
    return;
  }

  console.log(`Running signal-engine nightly for ${runDate}...`);

  const tier1 = await runNightlyTier1(runDate);
  console.log();
  console.log("=== Tier 1 ===");
  console.log(`  Cadence updated:    ${tier1.cadence_updated}`);
  console.log(`  Dormancies:         ${tier1.dormancies.length}`);
  console.log(`  Retirements:        ${tier1.retirements.length}`);
  console.log(`  Crystallizations:   ${tier1.crystallizations.length}`);
  console.log(`  Merges auto:        ${tier1.merges_auto.length}`);
  console.log(`  Merges proposed:    ${tier1.merges_proposed.length}`);
  console.log(`  Tokens used:        ${tier1.tokens_used}`);
  if (tier1.errors.length > 0) {
    console.log(`  Errors:             ${tier1.errors.length}`);
    for (const e of tier1.errors.slice(0, 5)) console.log(`    - ${e}`);
  }

  if (noCompose) {
    console.log();
    console.log("(--no-compose: skipping vault write)");
    return;
  }

  const compose = await composeNightly(runDate);
  console.log();
  console.log("=== Composer ===");
  console.log(`  Vault path: ${compose.vault_path ?? "(not written)"}`);
  console.log(`  Tokens:     ${compose.tokens}`);
  console.log();
  console.log("--- narrative ---");
  console.log(compose.narrative);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
