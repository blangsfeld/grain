/**
 * Company Page Generator — living vault pages from atom corpus.
 *
 * Two outputs:
 * 1. Company page (overwrites): current understanding, refreshed weekly.
 * 2. Trajectory (accumulates): quarterly arc, generated monthly.
 *
 * Vault paths:
 *   ~/Documents/Obsidian/Studio/20-network/companies/{slug}.md
 *   ~/Documents/Obsidian/Studio/20-network/companies/trajectories/{slug}-{year}-Q{quarter}.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseAdmin } from "@/lib/supabase";
import { queryAtoms, getAtomsForRange } from "@/lib/atom-db";
import type { DxAtom } from "@/types/atoms";

const VAULT_ROOT = join(homedir(), "Documents/Obsidian/Studio");
const COMPANIES_DIR = join(VAULT_ROOT, "20-network/companies");
const TRAJECTORIES_DIR = join(COMPANIES_DIR, "trajectories");
const MODEL = "claude-sonnet-4-20250514";

// ─── Network companies ──────────────────────────

const NETWORK_COMPANIES = [
  { slug: "buck", name: "BUCK", domain: "design, brand systems" },
  { slug: "wild", name: "Wild", domain: "digital product, AI tools" },
  { slug: "vtpro", name: "VTPro", domain: "experiential, events" },
  { slug: "part-sum", name: "Part + Sum", domain: "full-funnel marketing" },
  { slug: "its-nice-that", name: "It's Nice That", domain: "design community, culture" },
  { slug: "giant-ant", name: "Giant Ant", domain: "boutique animation" },
  { slug: "ok-cool", name: "Ok Cool", domain: "social-first creative" },
  { slug: "clip-iyc", name: "CLIP/IYC", domain: "talent development" },
];

// ─── Company Page Refresh ───────────────────────

export interface CompanyPageResult {
  slug: string;
  name: string;
  atomCount: number;
  updated: boolean;
  path: string | null;
}

/**
 * Refresh company pages where atoms have changed in the last 7 days.
 * Only updates if meaningful new signal exists.
 */
export async function refreshCompanyPages(): Promise<CompanyPageResult[]> {
  if (!existsSync(VAULT_ROOT)) return [];

  const db = getSupabaseAdmin();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  // Get domain IDs
  const { data: domains } = await db
    .from("dx_domains")
    .select("id, canonical_name");

  const domainMap = new Map((domains ?? []).map((d) => [d.canonical_name, d.id]));

  const results: CompanyPageResult[] = [];

  for (const company of NETWORK_COMPANIES) {
    const domainId = domainMap.get(company.name);
    if (!domainId) {
      results.push({ slug: company.slug, name: company.name, atomCount: 0, updated: false, path: null });
      continue;
    }

    // Check if there are new atoms this week
    const recentAtoms = await queryAtoms({
      domain_id: domainId,
      since: sevenDaysAgo,
      archived: false,
      limit: 5,
    });

    if (recentAtoms.length === 0) {
      results.push({ slug: company.slug, name: company.name, atomCount: 0, updated: false, path: null });
      continue;
    }

    // Fetch 30 days of atoms for context
    const atoms = await queryAtoms({
      domain_id: domainId,
      since: thirtyDaysAgo,
      archived: false,
      limit: 100,
    });

    // Fetch contacts for this domain
    const { data: contactsData } = await db
      .from("dx_contacts")
      .select("canonical_name, role")
      .eq("domain_id", domainId);
    const contacts = contactsData ?? [];

    // Generate page content via Claude
    const content = await generateCompanyPage(company, atoms, contacts);
    if (!content) {
      results.push({ slug: company.slug, name: company.name, atomCount: atoms.length, updated: false, path: null });
      continue;
    }

    // Write to vault
    const filePath = join(COMPANIES_DIR, `${company.slug}.md`);
    const md = [
      "---",
      "type: company",
      "network: residence",
      `domain: ${company.domain}`,
      `last_updated: ${today}`,
      `atom_count: ${atoms.length}`,
      "---",
      "",
      content,
    ].join("\n");

    writeFileSync(filePath, md, "utf-8");
    results.push({ slug: company.slug, name: company.name, atomCount: atoms.length, updated: true, path: filePath });
  }

  return results;
}

async function generateCompanyPage(
  company: { slug: string; name: string; domain: string },
  atoms: DxAtom[],
  contacts: Array<{ canonical_name: string; role: string | null }>,
): Promise<string | null> {
  if (atoms.length < 3) return null;

  const client = getAnthropicClient();

  // Format atoms for prompt
  const atomSummary = formatAtomsCompact(atoms);
  const contactList = contacts.map((c) => `${c.canonical_name}${c.role ? ` (${c.role})` : ""}`).join(", ");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.3,
    system: `You write concise, living company profiles for an intelligence vault. No fluff. Every line is signal. Use Obsidian wiki-link syntax [[name]] for people and companies.`,
    messages: [{
      role: "user",
      content: `Generate a company profile for ${company.name} based on these atoms from the last 30 days.

Key people: ${contactList || "None matched"}

${atomSummary}

Structure:
## What They Do
[1-2 sentences. Stable description.]

## Active Threads
[2-3 things currently in play. Each gets 1-2 sentences. Source from recent atoms.]

## Key Dynamics
[How this company relates to the Residence network. Where collaboration works, where it doesn't. What tensions are live.]

## Key People
[Bullet list with [[wiki-links]] and what they're focused on currently.]

Rules:
- Only include what's supported by the atoms
- If a thread or dynamic isn't clear from the evidence, skip it
- Use present tense
- No headers beyond the four above`,
    }],
  });

  return response.content[0]?.type === "text" ? response.content[0].text : null;
}

// ─── Trajectory Generation ──────────────────────

export interface TrajectoryResult {
  slug: string;
  name: string;
  quarter: string;
  atomCount: number;
  path: string | null;
}

/**
 * Generate quarterly trajectory documents for all companies.
 * Call monthly — only generates if the quarter has enough data.
 */
export async function generateTrajectories(year: number, quarter: number): Promise<TrajectoryResult[]> {
  if (!existsSync(VAULT_ROOT)) return [];
  if (!existsSync(TRAJECTORIES_DIR)) mkdirSync(TRAJECTORIES_DIR, { recursive: true });

  const db = getSupabaseAdmin();
  const qStart = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
  const qEndMonth = quarter * 3;
  const qEnd = `${year}-${String(qEndMonth).padStart(2, "0")}-${qEndMonth === 2 ? "28" : "30"}`;
  const quarterLabel = `${year}-Q${quarter}`;

  const { data: domains } = await db.from("dx_domains").select("id, canonical_name");
  const domainMap = new Map((domains ?? []).map((d) => [d.canonical_name, d.id]));

  const results: TrajectoryResult[] = [];

  for (const company of NETWORK_COMPANIES) {
    const domainId = domainMap.get(company.name);
    if (!domainId) {
      results.push({ slug: company.slug, name: company.name, quarter: quarterLabel, atomCount: 0, path: null });
      continue;
    }

    // Fetch all atoms for this quarter
    const atoms = await getAtomsForRange(qStart, qEnd);
    const companyAtoms = atoms.filter((a) => a.domain_id === domainId);

    if (companyAtoms.length < 10) {
      results.push({ slug: company.slug, name: company.name, quarter: quarterLabel, atomCount: companyAtoms.length, path: null });
      continue;
    }

    const content = await generateTrajectoryContent(company, companyAtoms, quarterLabel);
    if (!content) continue;

    const filePath = join(TRAJECTORIES_DIR, `${company.slug}-${quarterLabel}.md`);
    const md = [
      "---",
      "type: company-trajectory",
      `company: ${company.name}`,
      `quarter: ${quarterLabel}`,
      `atom_count: ${companyAtoms.length}`,
      `generated: ${new Date().toISOString().split("T")[0]}`,
      "---",
      "",
      `# ${company.name} — ${quarterLabel} Trajectory`,
      "",
      content,
    ].join("\n");

    writeFileSync(filePath, md, "utf-8");
    results.push({ slug: company.slug, name: company.name, quarter: quarterLabel, atomCount: companyAtoms.length, path: filePath });
  }

  return results;
}

async function generateTrajectoryContent(
  company: { name: string },
  atoms: DxAtom[],
  quarterLabel: string,
): Promise<string | null> {
  const client = getAnthropicClient();
  const atomSummary = formatAtomsCompact(atoms);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    temperature: 0.4,
    system: `You synthesize quarterly trajectories for companies. You're looking for directional movement — what changed, what stayed stuck, what's emerging. Write in clean prose. No fluff.`,
    messages: [{
      role: "user",
      content: `Generate a ${quarterLabel} trajectory analysis for ${company.name} based on these atoms across the quarter.

${atomSummary}

Structure:
## Arc
[3-4 sentences. What was the dominant story of this quarter for this company? What shifted from beginning to end?]

## Beliefs Formed
[Beliefs that emerged or strengthened. Include confidence level and whether they're stated/implied/aspirational.]

## Beliefs Challenged
[Beliefs that weakened or were contradicted by events. What changed someone's mind?]

## Chronic Tensions
[Tensions that appeared repeatedly without resolving. These are structural, not incidental.]

## Tensions Resolved
[Things that were stuck but got unstuck. What unblocked them?]

## Commitment Patterns
[Were commitments made and kept? What domains kept getting committed to but never delivered? What got done?]

## Open at Quarter End
[What's unresolved. What carries forward.]

Rules:
- Only include sections with real evidence from the atoms
- Name people when relevant
- This is the permanent record — accuracy matters more than narrative
- Skip sections with insufficient evidence rather than guessing`,
    }],
  });

  return response.content[0]?.type === "text" ? response.content[0].text : null;
}

// ─── Helpers ────────────────────────────────────

function formatAtomsCompact(atoms: DxAtom[]): string {
  const lines: string[] = [];
  const byType: Record<string, DxAtom[]> = {};
  for (const a of atoms) {
    if (!byType[a.type]) byType[a.type] = [];
    byType[a.type].push(a);
  }

  for (const [type, items] of Object.entries(byType)) {
    lines.push(`\n## ${type.toUpperCase()} (${items.length})`);
    for (const a of items.slice(0, 15)) {
      const c = a.content as unknown as Record<string, unknown>;
      const summary = (c.statement ?? c.gap ?? c.text ?? c.quote ?? c.the_read ?? c.whats_moving ?? "") as string;
      const date = a.source_date ?? "";
      const src = a.source_title ?? "";
      lines.push(`- [${date}] ${summary.slice(0, 200)} (${src})`);
    }
    if (items.length > 15) lines.push(`  ...and ${items.length - 15} more`);
  }

  return lines.join("\n");
}
