/**
 * Smoke test for the Buddy promote/close loop.
 *
 * Exercises:
 *  - preClassify (regex short-circuit) for promote/close reply shapes
 *  - parsePromoteReply / parseCloseReply parser edge cases
 *  - runBuddyPromoteSurface — read-only gather + dedup + menu persistence
 *    to a synthetic chat_id (99999999) so Ben's real menu isn't touched
 *  - runBuddyCloseSurface — read-only against Notion
 *
 * Does NOT call resolve* (would write to Notion / dx_commitments). Run
 * that manually once you've reviewed the menus this smoke prints.
 */

import { config as loadDotenv } from "dotenv";
import { join } from "path";
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { preClassify } from "@/lib/agents/telegram-desk";
import {
  parsePromoteReply,
  runBuddyPromoteSurface,
} from "@/lib/agents/buddy-promote";
import {
  parseCloseReply,
  runBuddyCloseSurface,
} from "@/lib/agents/buddy-close";
import { getSupabaseAdmin } from "@/lib/supabase";

const TEST_CHAT_ID = 99999999;

function check(label: string, ok: boolean, detail?: string): void {
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log("\n── preClassify regex ─────────────────────────\n");

  const promoteReply = preClassify("promote 2,5");
  check(
    "promote 2,5 → promote_reply",
    promoteReply?.intent === "promote_reply" && promoteReply?.target_agent === "buddy",
  );

  const promoteRewrite = preClassify("promote 3 as: rewrite the statement");
  check(
    "promote 3 as: ... → promote_reply",
    promoteRewrite?.intent === "promote_reply",
  );

  const closeReply = preClassify("done 1,4 recur 2 keep 3 archive 5,6");
  check(
    "done/recur/keep/archive → close_reply",
    closeReply?.intent === "close_reply",
  );

  const singleDone = preClassify("done 1");
  check("done 1 → close_reply", singleDone?.intent === "close_reply");

  const notACommand = preClassify("done.");
  check(
    "bare 'done.' does NOT match close_reply",
    notACommand === null,
    notACommand ? `matched as ${notACommand.intent}` : "no match",
  );

  const plainPromote = preClassify("what should I promote");
  check(
    "'what should I promote' does NOT regex-match (Haiku will classify)",
    plainPromote === null,
  );

  const falsePositive = preClassify("keep active on 3 projects");
  check(
    "'keep active on 3 projects' does NOT false-match close_reply",
    falsePositive === null,
    falsePositive ? `matched as ${falsePositive.intent}` : "no match",
  );

  console.log("\n── parsePromoteReply ─────────────────────────\n");

  const p1 = parsePromoteReply("promote 2,5");
  check(
    "promote 2,5 → [2,5]",
    p1?.selections.map((s) => s.index).join(",") === "2,5",
  );

  const p2 = parsePromoteReply("promote 3 as: new wording");
  check(
    "promote 3 as: new wording → [{3, 'new wording'}]",
    p2?.selections[0]?.index === 3 && p2?.selections[0]?.rewrite === "new wording",
  );

  const p3 = parsePromoteReply("promote 1,2 as: foo; 5 as: bar");
  check(
    "multi-clause with rewrites",
    p3?.selections.length === 3 &&
      p3.selections[0].index === 1 &&
      p3.selections[0].rewrite === "foo" &&
      p3.selections[2].index === 5 &&
      p3.selections[2].rewrite === "bar",
  );

  console.log("\n── parseCloseReply ───────────────────────────\n");

  const c1 = parseCloseReply("done 1,4 recur 2 keep 3 archive 5,6");
  check(
    "done/recur/keep/archive groups parsed",
    c1?.actions.length === 4,
    c1 ? c1.actions.map((a) => `${a.action}:${a.indices.join(",")}`).join(" ") : "null",
  );

  const c2 = parseCloseReply("close 1 2 3");
  check(
    "verb + space-separated indices",
    c2?.actions[0].action === "done" &&
      c2.actions[0].indices.join(",") === "1,2,3",
  );

  const c3 = parseCloseReply("complete 1, recurring 2,3");
  check(
    "alias verbs (complete, recurring)",
    c3?.actions.length === 2 &&
      c3.actions[0].action === "done" &&
      c3.actions[1].action === "recur",
  );

  console.log("\n── Promote surface (read-only against live dx_commitments) ─\n");

  try {
    const promote = await runBuddyPromoteSurface(TEST_CHAT_ID);
    console.log(`  ${promote.items.length} promotion candidate(s) surfaced`);
    if (promote.items.length > 0) {
      console.log("\n" + promote.message + "\n");
    }
    check("promote surface returned without error", true);
  } catch (err) {
    check(
      "promote surface",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  console.log("\n── Close surface (read-only against live Notion) ─────\n");

  try {
    const close = await runBuddyCloseSurface(TEST_CHAT_ID);
    console.log(`  ${close.items.length} stale item(s) on kept list`);
    if (close.items.length > 0) {
      console.log("\n" + close.message + "\n");
    }
    check("close surface returned without error", true);
  } catch (err) {
    check(
      "close surface",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Clean up synthetic menus — Ben's real chat_id is different, but we
  // still don't want test rows lingering.
  const supabase = getSupabaseAdmin();
  const { error: delErr } = await supabase
    .from("buddy_pending_menus")
    .delete()
    .eq("chat_id", TEST_CHAT_ID);
  if (delErr) {
    console.warn(`\n  cleanup warning: ${delErr.message}`);
  } else {
    console.log("\n  cleanup: test menus removed");
  }

  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
