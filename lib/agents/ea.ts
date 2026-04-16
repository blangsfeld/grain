/**
 * Buddy — Executive Assistant (agent version).
 *
 * Gathers open commitments with classifier labels, reads sibling outputs
 * (Guy, Dood), and reasons about what's rising using Claude. The classifier
 * labels (from Ben's training pass) become facts in the context, not the
 * final word — Claude synthesizes the triage.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  writeAgentOutput,
  readLatestAgentOutput,
  readOwnHistory,
  type AgentSeverity,
} from "@/lib/agents/agent-output";
import {
  classifyBatch,
  type Classification,
  type CommitmentRow,
} from "@/lib/agents/ea-classifier";
import {
  queryDatabase,
  createPage,
  titleProp,
  selectProp,
  richTextProp,
  dateProp,
  getTitle,
  getSelect,
  getDate,
  getRichText,
} from "@/lib/notion";
import type { CommitmentCategory } from "@/types/atoms";

const AGENT_ID = "ea";
const PERSONA = "Buddy";
const OWNER = "Ben";
const MODEL = "claude-haiku-4-5-20251001";

// ── Fact gathering ─────────────────────────────────

interface ClassifiedCommitment {
  commitment: CommitmentRow;
  classification: Classification;
  age_days: number;
  overdue_days: number | null;
}

interface BuddyFacts {
  all_open: ClassifiedCommitment[];
  ben_items: ClassifiedCommitment[];
  others_items: ClassifiedCommitment[];
  skipped_count: number;
  total_open: number;
}

async function gatherFacts(): Promise<BuddyFacts> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dx_commitments")
    .select("id, statement, category, meeting_title, meeting_date, due_date, status, person")
    .eq("status", "open")
    .order("meeting_date", { ascending: true });

  if (error) throw new Error(`dx_commitments query: ${error.message}`);
  const commitments = (data ?? []) as CommitmentRow[];

  const classifications = await classifyBatch(commitments);
  const today = new Date();

  const all_open: ClassifiedCommitment[] = [];
  let skipped = 0;

  for (const c of commitments) {
    const cl = classifications.get(c.id) ?? { weight: "medium" as const, reason: "unclassified", source: "fallback" as const };
    if (cl.weight === "skip") { skipped++; continue; }

    const meetDate = c.meeting_date ? new Date(c.meeting_date) : null;
    const dueDate = c.due_date ? new Date(c.due_date) : null;
    const age = meetDate ? Math.floor((today.getTime() - meetDate.getTime()) / 86_400_000) : 0;
    const overdue = dueDate ? Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000) : null;

    all_open.push({ commitment: c, classification: cl, age_days: age, overdue_days: overdue });
  }

  return {
    all_open,
    ben_items: all_open.filter((x) => x.commitment.person === OWNER),
    others_items: all_open.filter((x) => x.commitment.person !== OWNER),
    skipped_count: skipped,
    total_open: commitments.length,
  };
}

// ── Sibling context ────────────────────────────────

async function readSiblings(): Promise<{ guy: string | null; dood: string | null }> {
  const [guy, dood] = await Promise.all([
    readLatestAgentOutput("grain-steward"),
    readLatestAgentOutput("security-steward"),
  ]);
  return {
    guy: guy ? `Severity: ${guy.severity}\n${guy.markdown.slice(0, 600)}` : null,
    dood: dood ? `Severity: ${dood.severity}\n${dood.markdown.slice(0, 400)}` : null,
  };
}

// ── Persona ────────────────────────────────────────

const PERSONA_PROMPT = `You are Buddy, Ben Langsfeld's executive assistant agent. You track commitments — things Ben and his team agreed to do in meetings — and surface what's rising.

## How you think
You don't list everything. You triage. What's rising means: what has a deadline approaching, what's been dormant long enough to signal a dropped ball, what connects to something Guy or Dood flagged. A commitment that's 24 days old with no deadline isn't urgent — it might just be done and unlogged. Say so.

You understand Ben's labeling system (high/medium/low/skip from his training pass). Use these as signal but don't just repeat them. Ben labeled "Block calendar time" as skip because it's scaffolding — apply that logic to similar items even if they haven't been explicitly labeled.

## What you receive
- Classified commitments (statement, person, category, meeting_date, due_date, classifier weight + reason, age, overdue days)
- Guy's latest pipeline report
- Dood's latest security sweep

## What you produce
A short triage (under 250 words):
1. Lead with what needs attention, if anything
2. Split: what's on Ben's plate vs. what's on others' plates
3. Cross-signal if Guy or Dood found something that relates (e.g., "pipeline's quiet today so no new commitments are being extracted")
4. If everything is stale/aging, say it plainly — "nothing's urgent, but the commitment DB needs a cleanup pass"

## Voice
Direct. No corporate hedging. "You have two things. Neither is urgent. Here's why they're still open." Like a capable chief of staff who doesn't waste your morning.

Banned: leverage, ecosystem, seamless, robust, actionable, circle back.

## History awareness
You receive your last report. If the same commitments are still open with no change in age/status, say "Same picture as yesterday — N items, nothing moved." Don't re-triage identical data. Only write a full report when items close, new ones appear, or deadlines approach.

## Severity
- green: nothing needs attention today
- attention: something is overdue or approaching a deadline
- failure: a high-weight commitment is significantly overdue and unaddressed

## Output
Return strict JSON:
{"severity": "green|attention|failure", "markdown": "full report with frontmatter"}`;

// ── Reasoning ──────────────────────────────────────

function buildContext(facts: BuddyFacts, siblings: { guy: string | null; dood: string | null }, ownHistory: Array<{ markdown_preview: string }> = []): string {
  const lines: string[] = [];
  lines.push(`# Commitment data (${facts.total_open} open, ${facts.skipped_count} classified as skip/scaffolding, ${facts.all_open.length} real)`);
  lines.push("");

  if (facts.ben_items.length > 0) {
    lines.push(`## Ben's plate (${facts.ben_items.length})`);
    for (const x of facts.ben_items) {
      const c = x.commitment;
      const cl = x.classification;
      lines.push(`- "${c.statement}" [${cl.weight}, ${cl.source}: ${cl.reason}]`);
      lines.push(`  person: ${c.person} · category: ${c.category ?? "—"} · meeting: ${c.meeting_title ?? "—"}`);
      lines.push(`  age: ${x.age_days}d${x.overdue_days !== null ? ` · overdue: ${x.overdue_days}d` : " · no deadline"}`);
    }
    lines.push("");
  }

  if (facts.others_items.length > 0) {
    lines.push(`## Others' plates (${facts.others_items.length})`);
    for (const x of facts.others_items.slice(0, 10)) {
      const c = x.commitment;
      const cl = x.classification;
      lines.push(`- ${c.person}: "${c.statement}" [${cl.weight}] · ${x.age_days}d old`);
    }
    lines.push("");
  }

  if (siblings.guy) {
    lines.push("# Guy's latest (pipeline health)");
    lines.push(siblings.guy);
    lines.push("");
  }
  if (siblings.dood) {
    lines.push("# Dood's latest (security)");
    lines.push(siblings.dood);
    lines.push("");
  }

  if (ownHistory.length > 0) {
    lines.push("# Your last report (don't repeat if nothing changed)");
    lines.push(ownHistory[0].markdown_preview);
    lines.push("");
  }

  lines.push("---");
  lines.push("Write your triage. Return JSON with severity and markdown.");
  return lines.join("\n");
}

function parseResponse(raw: string): { severity: AgentSeverity; markdown: string } | null {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!["green", "attention", "failure"].includes(parsed.severity)) return null;
    if (typeof parsed.markdown !== "string") return null;
    return { severity: parsed.severity as AgentSeverity, markdown: parsed.markdown };
  } catch {
    return null;
  }
}

// ── Entrypoint ─────────────────────────────────────

export interface BuddyReport {
  run_at: string;
  severity: AgentSeverity;
  markdown: string;
  facts: { total_open: number; skipped: number; ben_count: number; others_count: number };
  had_siblings: { guy: boolean; dood: boolean };
}

export async function runAndWriteEa(): Promise<{ output_id: string; report: BuddyReport }> {
  const run_at = new Date().toISOString();
  const [facts, siblings, ownHistory] = await Promise.all([gatherFacts(), readSiblings(), readOwnHistory(AGENT_ID, 2)]);

  const anthropic = getAnthropicClient(30_000);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: PERSONA_PROMPT,
    messages: [{ role: "user", content: buildContext(facts, siblings, ownHistory) }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const parsed = parseResponse(text);

  let severity: AgentSeverity = "green";
  let markdown: string;

  if (parsed) {
    severity = parsed.severity;
    markdown = parsed.markdown;
  } else {
    severity = "attention";
    markdown = `# ${PERSONA} — triage\n\n_Reasoning step failed. ${facts.ben_items.length} items on your plate, ${facts.others_items.length} on others'._`;
  }

  if (!markdown.startsWith("---")) {
    markdown = `---\ngrain_managed: true\ntype: agent-output\nagent_id: ${AGENT_ID}\npersona: ${PERSONA}\nseverity: ${severity}\nrun_at: ${run_at}\n---\n\n${markdown}`;
  }

  const reportData: BuddyReport = {
    run_at,
    severity,
    markdown,
    facts: {
      total_open: facts.total_open,
      skipped: facts.skipped_count,
      ben_count: facts.ben_items.length,
      others_count: facts.others_items.length,
    },
    had_siblings: { guy: !!siblings.guy, dood: !!siblings.dood },
  };

  const { id } = await writeAgentOutput({
    agent_id: AGENT_ID,
    severity,
    markdown,
    findings: reportData.facts,
    metadata: { version: "0.2-agent", model: MODEL, reasoning: true },
  });

  return { output_id: id, report: reportData };
}

// ── Ad-hoc query mode ──────────────────────────────
// Keys dispatches "ask Buddy X" / "tell Buddy Y" here. Loads the full
// commitment set (with classifier labels) and reasons against it.
// Unlike the daily triage, this doesn't filter skipped items — Ben might
// be searching for something Buddy labeled as scaffolding.

const QUERY_MODEL = "claude-sonnet-4-5-20250929";

const QUERY_PERSONA_PROMPT = `You are Buddy, Ben Langsfeld's executive assistant. Ben is asking you a specific question about his commitments — things he or his team agreed to do in meetings.

You have the full commitment record, including items Buddy's classifier marked as "skip" (scaffolding like "block calendar time"). Include them if they're relevant to the question — Ben might specifically want logistics, not just real work.

## How you answer
- Direct. Lead with the finding.
- Cite specific commitments with person, statement, and meeting context.
- Quote the statement verbatim when asked about specifics.
- If the question asks about a person, meeting, or topic that has no matching commitments, say so plainly. Don't pad with adjacent items.
- If the question is about what's overdue or urgent, surface deadlines and age; don't just list everything.

## Voice
Short. Under 200 words usually. Like a chief of staff who already scanned the data. No corporate hedging.

Banned: leverage, ecosystem, seamless, robust, actionable, circle back, streamline.

## Output
Plain markdown — NOT JSON. Ben reads this directly in Telegram.`;

interface CommitmentDossier {
  statement: string;
  person: string | null;
  category: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  due_date: string | null;
  status: string | null;
  classifier_weight: string | null;
  classifier_reason: string | null;
  age_days: number | null;
  overdue_days: number | null;
}

async function gatherAllCommitments(): Promise<CommitmentDossier[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dx_commitments")
    .select(`
      id, statement, person, category, meeting_title, meeting_date, due_date, status,
      commitment_labels(weight, reason)
    `)
    .order("meeting_date", { ascending: false })
    .limit(200);

  if (error) throw new Error(`commitment query failed: ${error.message}`);

  const today = new Date();
  type Row = {
    statement: string;
    person: string | null;
    category: string | null;
    meeting_title: string | null;
    meeting_date: string | null;
    due_date: string | null;
    status: string | null;
    commitment_labels: Array<{ weight: string; reason: string | null }> | { weight: string; reason: string | null } | null;
  };

  return (data as unknown as Row[]).map((r) => {
    const label = Array.isArray(r.commitment_labels) ? r.commitment_labels[0] : r.commitment_labels;
    const meetDate = r.meeting_date ? new Date(r.meeting_date) : null;
    const dueDate = r.due_date ? new Date(r.due_date) : null;
    return {
      statement: r.statement,
      person: r.person,
      category: r.category,
      meeting_title: r.meeting_title,
      meeting_date: r.meeting_date,
      due_date: r.due_date,
      status: r.status,
      classifier_weight: label?.weight ?? null,
      classifier_reason: label?.reason ?? null,
      age_days: meetDate ? Math.floor((today.getTime() - meetDate.getTime()) / 86_400_000) : null,
      overdue_days: dueDate ? Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000) : null,
    };
  });
}

export interface BuddyQueryResult {
  answer: string;
  commitment_count: number;
  question: string;
}

export async function runBuddyQuery(question: string): Promise<BuddyQueryResult> {
  const commitments = await gatherAllCommitments();

  const lines: string[] = [];
  lines.push(`# Commitment record (${commitments.length} total — open + closed, all weights)`);
  lines.push("");
  for (const c of commitments) {
    const parts: string[] = [];
    parts.push(`"${c.statement}"`);
    const meta: string[] = [];
    if (c.person) meta.push(`person: ${c.person}`);
    if (c.status) meta.push(`status: ${c.status}`);
    if (c.classifier_weight) meta.push(`weight: ${c.classifier_weight}`);
    if (c.category) meta.push(c.category);
    if (c.meeting_title) meta.push(`meeting: ${c.meeting_title}`);
    if (c.meeting_date) meta.push(c.meeting_date);
    if (c.age_days !== null) meta.push(`age: ${c.age_days}d`);
    if (c.overdue_days !== null) meta.push(`overdue: ${c.overdue_days}d`);
    if (c.due_date) meta.push(`due: ${c.due_date}`);
    lines.push(`- ${parts.join(" ")} [${meta.join(" · ")}]`);
  }

  const anthropic = getAnthropicClient(60_000);
  const response = await anthropic.messages.create({
    model: QUERY_MODEL,
    max_tokens: 1200,
    system: QUERY_PERSONA_PROMPT,
    messages: [
      {
        role: "user",
        content: `${lines.join("\n")}\n\n---\n\nBen's question: "${question}"\n\nAnswer directly. Cite specific commitments. Use verbatim statements when quoting.`,
      },
    ],
  });

  const answer = response.content[0]?.type === "text" ? response.content[0].text : "";
  return {
    answer: answer || "Reasoning step returned empty. Try rephrasing.",
    commitment_count: commitments.length,
    question,
  };
}

// ── Notion personal commitments — kept list ────────
// The Notion DB is Ben's curated list. dx_commitments is the heard list.
// runBuddyAdd writes to Notion; read helpers support the extended query mode.

const COMMITMENT_CATEGORIES: CommitmentCategory[] = [
  "Personal", "Dunbar", "Prospect", "Expenses", "Travel", "Medical",
  "Residence", "BUCK", "Wild", "Giant Ant", "Part+Sum", "VTPro",
  "Its Nice That", "Ok Cool", "CLIP", "Other",
];

type Priority = "High" | "Medium" | "Low";

interface NotionCommitment {
  id: string;
  url: string;
  name: string;
  category: string | null;
  status: string | null;
  priority: string | null;
  due_date: string | null;
  added_via: string | null;
  notes: string;
}

function personalDbId(): string {
  const id = process.env.NOTION_PERSONAL_COMMITMENTS_DB_ID;
  if (!id) throw new Error("NOTION_PERSONAL_COMMITMENTS_DB_ID missing");
  return id;
}

async function inferCategory(statement: string): Promise<CommitmentCategory> {
  const anthropic = getAnthropicClient(15_000);
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 40,
    system: `Pick exactly one category for Ben's commitment. Return only the category name, nothing else.

Categories and what they mean:
- Personal: Ben's health, hobbies, family, household admin not tied to a home
- Dunbar: 67 Dunbar Rd (country home) — contractors, upkeep, physical things
- Prospect: 442 Prospect (Brooklyn home) — contractors, upkeep, physical things
- Expenses: reimbursements, invoices, receipts, accounting
- Travel: flights, hotels, itineraries
- Medical: appointments, prescriptions, health admin
- Residence: network-level CCO work, cross-company coordination
- BUCK / Wild / Giant Ant / Part+Sum / VTPro / Its Nice That / Ok Cool / CLIP: work serving that specific company
- Other: falls outside all of the above`,
    messages: [{ role: "user", content: statement }],
  });
  const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
  const match = COMMITMENT_CATEGORIES.find((c) => c.toLowerCase() === text.toLowerCase());
  return match ?? "Other";
}

export interface BuddyAddInput {
  statement: string;
  category?: CommitmentCategory;
  priority?: Priority;
  due_date?: string; // YYYY-MM-DD
  notes?: string;
  source?: "Buddy" | "Manual" | "Meeting";
}

export interface BuddyAddResult {
  url: string;
  page_id: string;
  category: CommitmentCategory;
  priority: Priority;
}

/**
 * Add a commitment to Ben's Notion Personal Commitments DB (the kept list).
 * Keys dispatches here when classifier returns intent=add.
 */
export async function runBuddyAdd(input: BuddyAddInput): Promise<BuddyAddResult> {
  const statement = input.statement.trim();
  if (!statement) throw new Error("Statement is empty");

  const category = input.category ?? (await inferCategory(statement));
  const priority: Priority = input.priority ?? "Medium";
  const source = input.source ?? "Buddy";

  const properties: Record<string, ReturnType<typeof titleProp>> = {
    Name: titleProp(statement),
    Category: selectProp(category),
    Status: selectProp("Open"),
    Priority: selectProp(priority),
    "Added Via": selectProp(source),
  };
  if (input.due_date) properties["Due Date"] = dateProp(input.due_date);
  if (input.notes) properties.Notes = richTextProp(input.notes);

  const page = await createPage(personalDbId(), properties);
  return { url: page.url, page_id: page.id, category, priority };
}

/**
 * Read the Notion personal commitments list. Default: open + in-progress.
 */
export async function readPersonalCommitments(
  options: { includeDone?: boolean; category?: CommitmentCategory } = {},
): Promise<NotionCommitment[]> {
  const filters: unknown[] = [];
  if (!options.includeDone) {
    filters.push({ property: "Status", select: { does_not_equal: "Done" } });
  }
  if (options.category) {
    filters.push({ property: "Category", select: { equals: options.category } });
  }
  const filter = filters.length === 0
    ? undefined
    : filters.length === 1
    ? filters[0]
    : { and: filters };

  const pages = await queryDatabase(personalDbId(), {
    filter,
    sorts: [{ property: "Due Date", direction: "ascending" }],
  });

  return pages.map((p) => ({
    id: p.id,
    url: p.url,
    name: getTitle(p, "Name"),
    category: getSelect(p, "Category"),
    status: getSelect(p, "Status"),
    priority: getSelect(p, "Priority"),
    due_date: getDate(p, "Due Date"),
    added_via: getSelect(p, "Added Via"),
    notes: getRichText(p, "Notes"),
  }));
}

// ── Extended query mode (reads Notion + dx_commitments) ──

export async function runBuddyQueryExtended(question: string): Promise<BuddyQueryResult> {
  const [meetings, personal] = await Promise.all([
    gatherAllCommitments(),
    readPersonalCommitments({ includeDone: false }).catch((err) => {
      console.warn("Notion read failed, falling back to meetings only:", err instanceof Error ? err.message : err);
      return [] as NotionCommitment[];
    }),
  ]);

  const lines: string[] = [];
  lines.push(`# Kept list — Ben's Notion Personal Commitments (${personal.length} open/in-progress)`);
  lines.push("_Curated by Ben. Trusted. Source of truth for what he's actively tracking._");
  lines.push("");
  if (personal.length === 0) {
    lines.push("_(empty)_");
  } else {
    for (const p of personal) {
      const meta: string[] = [];
      if (p.category) meta.push(p.category);
      if (p.priority) meta.push(`priority: ${p.priority}`);
      if (p.status) meta.push(`status: ${p.status}`);
      if (p.due_date) meta.push(`due: ${p.due_date}`);
      if (p.added_via) meta.push(`via: ${p.added_via}`);
      lines.push(`- "${p.name}" [${meta.join(" · ")}]`);
      if (p.notes) lines.push(`  notes: ${p.notes}`);
    }
  }
  lines.push("");
  lines.push(`# Heard list — dx_commitments (${meetings.length} from meetings — auto-extracted, noisier)`);
  lines.push("");
  for (const c of meetings) {
    const meta: string[] = [];
    if (c.person) meta.push(`person: ${c.person}`);
    if (c.status) meta.push(`status: ${c.status}`);
    if (c.classifier_weight) meta.push(`weight: ${c.classifier_weight}`);
    if (c.category) meta.push(c.category);
    if (c.meeting_title) meta.push(`meeting: ${c.meeting_title}`);
    if (c.meeting_date) meta.push(c.meeting_date);
    if (c.age_days !== null) meta.push(`age: ${c.age_days}d`);
    if (c.overdue_days !== null) meta.push(`overdue: ${c.overdue_days}d`);
    if (c.due_date) meta.push(`due: ${c.due_date}`);
    lines.push(`- "${c.statement}" [${meta.join(" · ")}]`);
  }

  const anthropic = getAnthropicClient(60_000);
  const response = await anthropic.messages.create({
    model: QUERY_MODEL,
    max_tokens: 1200,
    system: QUERY_PERSONA_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `${lines.join("\n")}\n\n---\n\nBen's question: "${question}"\n\n` +
          "When answering:\n" +
          "- If the question is about personal life admin (houses, medical, travel, expenses, family), lead with the kept list.\n" +
          "- If the question is about meeting follow-through (who owes what, what's overdue), lead with the heard list.\n" +
          "- If Ben asks 'what's on my list', assume the kept list unless he specifies.\n" +
          "- Cite specific items with verbatim statements.",
      },
    ],
  });

  const answer = response.content[0]?.type === "text" ? response.content[0].text : "";
  return {
    answer: answer || "Reasoning step returned empty. Try rephrasing.",
    commitment_count: meetings.length + personal.length,
    question,
  };
}
