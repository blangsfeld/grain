/**
 * Build Intelligence — scan git repos for recent activity.
 * Returns a text summary of what changed across repos.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const APPS_DIR = join(homedir(), "Documents/Apps");

interface RepoActivity {
  name: string;
  commits: string[];
  filesChanged: number;
}

/**
 * Gather git activity across all repos in ~/Documents/Apps/
 * @param days — how many days back to look (1 for daily, 7 for Monday)
 */
export async function gatherBuildIntel(days: number): Promise<string | null> {
  if (!existsSync(APPS_DIR)) return null;

  const entries = readdirSync(APPS_DIR, { withFileTypes: true });
  const repos: RepoActivity[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = join(APPS_DIR, entry.name);
    const gitDir = join(repoPath, ".git");
    if (!existsSync(gitDir)) continue;

    try {
      const log = execSync(
        `git log --oneline --since="${days} days ago" --no-merges 2>/dev/null`,
        { cwd: repoPath, encoding: "utf-8", timeout: 5000 },
      ).trim();

      if (!log) continue;

      const commits = log.split("\n").filter(Boolean);

      // Count files changed
      let filesChanged = 0;
      try {
        const diffStat = execSync(
          `git diff --stat HEAD~${Math.min(commits.length, 20)}..HEAD 2>/dev/null | tail -1`,
          { cwd: repoPath, encoding: "utf-8", timeout: 5000 },
        ).trim();
        const match = diffStat.match(/(\d+) files? changed/);
        if (match) filesChanged = parseInt(match[1]);
      } catch {
        filesChanged = commits.length; // rough estimate
      }

      repos.push({ name: entry.name, commits, filesChanged });
    } catch {
      continue;
    }
  }

  if (repos.length === 0) return null;

  // Format summary
  const lines: string[] = [];
  const period = days === 1 ? "Yesterday" : `Last ${days} days`;
  lines.push(`${period}: ${repos.length} active repos, ${repos.reduce((s, r) => s + r.commits.length, 0)} commits`);

  // Sort by activity
  repos.sort((a, b) => b.commits.length - a.commits.length);

  for (const repo of repos) {
    lines.push(`\n**${repo.name}** (${repo.commits.length} commits, ${repo.filesChanged} files)`);
    for (const commit of repo.commits.slice(0, 5)) {
      lines.push(`  - ${commit}`);
    }
    if (repo.commits.length > 5) {
      lines.push(`  - ...and ${repo.commits.length - 5} more`);
    }
  }

  return lines.join("\n");
}
