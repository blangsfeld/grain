/**
 * Label commitments CLI — training data for Buddy (EA).
 *
 * Usage:
 *   npx tsx scripts/label-commitments.ts           # label Ben's commitments (default)
 *   npx tsx scripts/label-commitments.ts --all     # label everyone's commitments
 *   npx tsx scripts/label-commitments.ts --stats   # show label counts so far
 *
 * Keys during labeling:
 *   1  high     — surface near the top, strategic/meaningful work
 *   2  medium   — surface if capacity, ops hygiene worth tracking
 *   3  low      — quiet; real but not prioritizing
 *   4  skip     — shouldn't be a commitment at all (scaffolding, micro-task, moot)
 *   r  relabel  — re-enter the previous commitment (if I mis-typed)
 *   q  quit     — quit and save progress
 *
 * After a label, you can optionally type a one-line reason.
 * Labels auto-save; quit any time and resume later.
 */

import { config as loadDotenv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

// ─── Args ──────────────────────────────────────────
const args = process.argv.slice(2);
const ALL = args.includes("--all");
const STATS_ONLY = args.includes("--stats");
const OWNER = ALL ? null : "Ben";

type Weight = "high" | "medium" | "low" | "skip";

interface Commitment {
  id: string;
  statement: string;
  category: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  status: string | null;
  person: string | null;
}

// ─── Stats ─────────────────────────────────────────
async function showStats(): Promise<void> {
  const [totalRes, labeledRes, byWeightRes] = await Promise.all([
    supabase.from("dx_commitments").select("id", { count: "exact", head: true }),
    supabase.from("commitment_labels").select("id", { count: "exact", head: true }),
    supabase.from("commitment_labels").select("weight"),
  ]);

  const total = totalRes.count ?? 0;
  const labeled = labeledRes.count ?? 0;
  const weights = (byWeightRes.data ?? []) as { weight: Weight }[];
  const counts: Record<Weight, number> = { high: 0, medium: 0, low: 0, skip: 0 };
  for (const row of weights) counts[row.weight]++;

  console.log("\n── commitment_labels stats ──");
  console.log(`  total commitments: ${total}`);
  console.log(`  labeled:           ${labeled} (${total ? Math.round((labeled / total) * 100) : 0}%)`);
  console.log(`  high:   ${counts.high}`);
  console.log(`  medium: ${counts.medium}`);
  console.log(`  low:    ${counts.low}`);
  console.log(`  skip:   ${counts.skip}`);
  console.log("");
}

// ─── Fetch unlabeled ───────────────────────────────
async function fetchUnlabeled(): Promise<Commitment[]> {
  let query = supabase
    .from("dx_commitments")
    .select("id, statement, category, meeting_title, meeting_date, due_date, status, person")
    .order("meeting_date", { ascending: false, nullsFirst: false });

  if (OWNER) query = query.eq("person", OWNER);

  const { data, error } = await query;
  if (error) throw new Error(`commitments fetch: ${error.message}`);

  // Filter out already-labeled
  const labeled = await supabase.from("commitment_labels").select("commitment_id");
  if (labeled.error) throw new Error(`labels fetch: ${labeled.error.message}`);
  const labeledSet = new Set((labeled.data ?? []).map((l) => l.commitment_id as string));

  return (data ?? []).filter((c) => !labeledSet.has(c.id)) as Commitment[];
}

// ─── Label one ─────────────────────────────────────
async function saveLabel(
  commitment_id: string,
  weight: Weight,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.from("commitment_labels").upsert(
    {
      commitment_id,
      weight,
      reason: reason && reason.length > 0 ? reason : null,
    },
    { onConflict: "commitment_id" },
  );
  if (error) throw new Error(`label save: ${error.message}`);
}

async function deleteLabel(commitment_id: string): Promise<void> {
  await supabase.from("commitment_labels").delete().eq("commitment_id", commitment_id);
}

// ─── Render commitment ─────────────────────────────
function renderCommitment(c: Commitment, idx: number, total: number): void {
  const bar = "─".repeat(60);
  console.log("");
  console.log(bar);
  console.log(`  [${idx + 1}/${total}]  ${c.person ?? "?"}  ·  ${c.status ?? "open"}  ·  ${c.category ?? "—"}`);
  if (c.meeting_date || c.due_date) {
    const parts: string[] = [];
    if (c.meeting_date) parts.push(`meeting: ${c.meeting_date}`);
    if (c.due_date) parts.push(`due: ${c.due_date}`);
    console.log(`  ${parts.join("  ·  ")}`);
  }
  if (c.meeting_title) console.log(`  from: ${c.meeting_title}`);
  console.log(bar);
  console.log("");
  console.log(`  ${c.statement}`);
  console.log("");
}

// ─── Main loop ─────────────────────────────────────
async function main(): Promise<void> {
  if (STATS_ONLY) {
    await showStats();
    return;
  }

  const queue = await fetchUnlabeled();
  if (queue.length === 0) {
    console.log(`\nNothing unlabeled for ${OWNER ?? "anyone"}. Try --all or --stats.\n`);
    return;
  }

  console.log(`\n${queue.length} unlabeled commitment(s) for ${OWNER ?? "everyone"}.`);
  console.log(`Keys: 1=high  2=medium  3=low  4=skip  r=relabel last  q=quit\n`);

  const rl = readline.createInterface({ input, output });
  const weightMap: Record<string, Weight> = { "1": "high", "2": "medium", "3": "low", "4": "skip" };

  let i = 0;
  let last: { commitment_id: string } | null = null;

  while (i < queue.length) {
    const c = queue[i];
    renderCommitment(c, i, queue.length);

    const answer = (await rl.question("  label (1/2/3/4) · r=relabel · q=quit > ")).trim().toLowerCase();

    if (answer === "q") {
      console.log("\nSaved. Resume any time.");
      break;
    }

    if (answer === "r") {
      if (!last) {
        console.log("  nothing to relabel yet.");
        continue;
      }
      await deleteLabel(last.commitment_id);
      console.log(`  deleted label; that commitment will resurface next run.`);
      last = null;
      continue;
    }

    const weight = weightMap[answer];
    if (!weight) {
      console.log(`  unrecognized. try 1/2/3/4, r, or q.`);
      continue;
    }

    const reason = (await rl.question("  reason (optional, Enter to skip) > ")).trim();
    await saveLabel(c.id, weight, reason || null);
    last = { commitment_id: c.id };
    console.log(`  ✓ ${weight}${reason ? ` — ${reason}` : ""}`);
    i++;
  }

  rl.close();
  await showStats();
}

main().catch((err) => {
  console.error("\nerror:", err);
  process.exit(1);
});
