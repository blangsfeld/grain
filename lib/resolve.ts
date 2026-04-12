/**
 * Entity Resolution — match names against contact/domain registries.
 * Simplified from Source v2: no overrides, no batch re-resolve.
 * Atoms get entity resolution after all passes complete.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { DxContact, DxDomain } from "@/types/entities";
import type { DxAtomInsert } from "@/types/atoms";

// ─── Matching ────────────────────────────────────

export function matchContact(name: string, contacts: DxContact[]): DxContact | null {
  const lower = name.toLowerCase().trim();
  for (const c of contacts) {
    if (c.canonical_name.toLowerCase() === lower) return c;
    if (c.aliases.some((a) => a.toLowerCase() === lower)) return c;
  }
  return null;
}

export function matchDomain(domain: string, domains: DxDomain[]): DxDomain | null {
  const lower = domain.toLowerCase().trim();
  for (const d of domains) {
    if (d.canonical_name.toLowerCase() === lower) return d;
    if (d.aliases.some((a) => a.toLowerCase() === lower)) return d;
  }
  return null;
}

// ─── Load registries ─────────────────────────────

export async function loadRegistries(): Promise<{
  contacts: DxContact[];
  domains: DxDomain[];
}> {
  const db = getSupabaseAdmin();
  const [contactsResult, domainsResult] = await Promise.all([
    db.from("dx_contacts").select("id, canonical_name, aliases, role, domain_id"),
    db.from("dx_domains").select("id, canonical_name, aliases, entity_type"),
  ]);
  return {
    contacts: (contactsResult.data || []) as DxContact[],
    domains: (domainsResult.data || []) as DxDomain[],
  };
}

// ─── Resolve atoms ───────────────────────────────

/**
 * Resolve entities across all atoms from a single transcript.
 * Extracts names from atom content, matches against registries,
 * and stamps each atom with entity/domain/contact_ids.
 */
export function resolveAtoms(
  atoms: DxAtomInsert[],
  contacts: DxContact[],
  domains: DxDomain[],
): void {
  // Collect all names mentioned across atoms
  const allNames = new Set<string>();
  for (const atom of atoms) {
    const names = extractNamesFromAtom(atom);
    for (const name of names) allNames.add(name);
  }

  // Resolve names to contacts/domains
  const contactMap = new Map<string, DxContact>();
  const domainFromNames: DxDomain | null = null;
  let resolvedDomain: DxDomain | null = null;

  for (const name of allNames) {
    const contact = matchContact(name, contacts);
    if (contact) {
      contactMap.set(name.toLowerCase(), contact);
      // If contact has a domain, use it
      if (contact.domain_id && !resolvedDomain) {
        resolvedDomain = domains.find((d) => d.id === contact.domain_id) ?? null;
      }
      continue;
    }
    const domain = matchDomain(name, domains);
    if (domain && !resolvedDomain) {
      resolvedDomain = domain;
    }
  }

  // Stamp each atom
  const contactIds = Array.from(contactMap.values()).map((c) => c.id);
  const entities = Array.from(contactMap.values()).map((c) => c.canonical_name);

  for (const atom of atoms) {
    const atomNames = extractNamesFromAtom(atom);
    const atomContactIds: string[] = [];
    const atomEntities: string[] = [];

    for (const name of atomNames) {
      const contact = contactMap.get(name.toLowerCase());
      if (contact) {
        if (!atomContactIds.includes(contact.id)) atomContactIds.push(contact.id);
        if (!atomEntities.includes(contact.canonical_name)) atomEntities.push(contact.canonical_name);
      }
    }

    atom.entities = atomEntities.length > 0 ? atomEntities : entities;
    atom.contact_ids = atomContactIds.length > 0 ? atomContactIds : contactIds;
    atom.domain = resolvedDomain?.canonical_name;
    atom.domain_id = resolvedDomain?.id;
  }
}

/**
 * Extract person/org names mentioned in an atom's content.
 *
 * Convention: each atom type contributes whatever name-bearing fields
 * it has. New atom types MUST add their name-bearing fields here or
 * they will not participate in entity resolution (contact_ids, domain
 * stamping) during `resolveAtoms`. Silent absence from this function
 * is the main way new atoms fall off the knowledge graph — if a new
 * atom type lands and its entities column comes out empty, this is
 * almost always the place to look.
 */
function extractNamesFromAtom(atom: DxAtomInsert): string[] {
  const names: string[] = [];
  const c = atom.content as unknown as Record<string, unknown>;

  // Quote speaker
  if (typeof c.speaker === "string" && c.speaker !== "You") {
    names.push(c.speaker);
  }

  // Commitment person/company
  if (typeof c.person === "string") names.push(c.person);
  if (typeof c.company === "string") names.push(c.company);

  // Decision author
  if (typeof c.made_by === "string") names.push(c.made_by);

  // Relationships meta atom — people[].name
  if (Array.isArray((c as { people?: unknown }).people)) {
    for (const p of (c as { people: Array<{ name?: unknown }> }).people) {
      if (p && typeof p.name === "string") names.push(p.name);
    }
  }

  return names;
}
