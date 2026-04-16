/**
 * Run the Wrap Steward — session closer.
 *
 * Usage:
 *   npx tsx scripts/run-wrap.ts "Built 7 reasoning agents, deployed to Vercel, wired Keys to Telegram"
 *   npx tsx scripts/run-wrap.ts "description" --project=grain
 *   npx tsx scripts/run-wrap.ts "description" --git     (auto-captures git diff)
 *
 * The description is the first positional arg.
 * --project=NAME sets the project context.
 * --git includes git diff --stat from the CWD.
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

import { runWrapSteward, type WrapInput } from "@/lib/agents/wrap-steward";
import { execSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const VAULT = join(process.env.HOME || "", "Documents/Obsidian/Studio");

async function main() {
  const args = process.argv.slice(2);
  const description = args.find((a) => !a.startsWith("--")) ?? "No description provided";
  const projectFlag = args.find((a) => a.startsWith("--project="));
  const project = projectFlag?.split("=")[1] ?? undefined;
  const includeGit = args.includes("--git");

  let gitDiff: string | undefined;
  if (includeGit) {
    try {
      const stat = execSync("git diff --stat HEAD~1", { encoding: "utf-8", timeout: 10_000 });
      const log = execSync("git log --oneline -5", { encoding: "utf-8", timeout: 5_000 });
      gitDiff = `Recent commits:\n${log}\n\nDiff stat:\n${stat}`;
    } catch {
      gitDiff = "(git diff unavailable)";
    }
  }

  console.log("Running Wrap Steward...");
  console.log(`  Project: ${project ?? "studio"}`);
  console.log(`  Description: ${description.slice(0, 80)}...`);

  const input: WrapInput = {
    session_description: description,
    project,
    git_diff_summary: gitDiff,
  };

  const { output_id, report } = await runWrapSteward(input);
  console.log(`\n✓ Written: agent_outputs id=${output_id}`);

  // Also materialize directly to the vault
  const agentsDir = join(VAULT, "70-agents");
  if (existsSync(VAULT)) {
    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "wrap-steward.md"), report.markdown, "utf-8");
    console.log(`✓ Materialized: 70-agents/wrap-steward.md`);

    // Also write a dated session log
    const sessionsDir = join(agentsDir, "sessions");
    if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toISOString().slice(11, 16).replace(":", "");
    const sessionFile = `${dateStr}-${timeStr}-${(project ?? "studio").slice(0, 20)}.md`;
    writeFileSync(join(sessionsDir, sessionFile), report.markdown, "utf-8");
    console.log(`✓ Session log: 70-agents/sessions/${sessionFile}`);
  }

  // Print the report
  console.log("\n" + "─".repeat(60));
  console.log(report.markdown);
}

main().catch((err) => {
  console.error("wrap error:", err);
  process.exit(1);
});
