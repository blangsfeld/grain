/**
 * dx_atoms CRUD + search
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { DxAtom, DxAtomInsert, AtomType } from "@/types/atoms";

// ─── Insert ──────────────────────────────────────

export async function insertAtoms(atoms: DxAtomInsert[]): Promise<DxAtom[]> {
  if (atoms.length === 0) return [];

  // Defensive backstop: meta atoms must never hit dx_atoms. Callers are
  // expected to have split them out already (see granola-ingest.ts). If
  // any slip through this is a programming error, not expected flow.
  const metaCount = atoms.filter((a) => a.meta).length;
  if (metaCount > 0) {
    console.warn(
      `insertAtoms: filtering out ${metaCount} meta atom(s) — callers should split these before calling.`,
    );
    atoms = atoms.filter((a) => !a.meta);
    if (atoms.length === 0) return [];
  }

  const db = getSupabaseAdmin();
  const rows = atoms.map((a) => ({
    type: a.type,
    content: a.content,
    transcript_id: a.transcript_id ?? null,
    source_title: a.source_title ?? null,
    source_date: a.source_date ?? null,
    entities: a.entities ?? [],
    domain: a.domain ?? null,
    domain_id: a.domain_id ?? null,
    contact_ids: a.contact_ids ?? [],
  }));

  const { data, error } = await db
    .from("dx_atoms")
    .insert(rows)
    .select("*");

  if (error) throw new Error(`insertAtoms failed: ${error.message}`);
  return (data || []) as DxAtom[];
}

// ─── Query ───────────────────────────────────────

export interface AtomQuery {
  type?: AtomType | AtomType[];
  domain_id?: string;
  contact_name?: string;
  search?: string;      // text search across content + source_title
  since?: string;       // ISO date
  until?: string;       // ISO date
  saved?: boolean;
  archived?: boolean;
  limit?: number;
}

export async function queryAtoms(query: AtomQuery): Promise<DxAtom[]> {
  const db = getSupabaseAdmin();

  // Text search uses an RPC function that can cast JSONB to text in SQL
  if (query.search) {
    const typeFilter = query.type
      ? Array.isArray(query.type) ? query.type : [query.type]
      : null;

    const { data, error } = await db.rpc("search_atoms", {
      search_term: query.search,
      type_filter: typeFilter,
      max_results: query.limit ?? 50,
    });

    if (error) throw new Error(`search_atoms failed: ${error.message}`);
    return (data || []) as DxAtom[];
  }

  // Standard query (no text search)
  let q = db
    .from("dx_atoms")
    .select("*")
    .order("created_at", { ascending: false });

  if (query.type) {
    if (Array.isArray(query.type)) {
      q = q.in("type", query.type);
    } else {
      q = q.eq("type", query.type);
    }
  }

  if (query.domain_id) {
    q = q.eq("domain_id", query.domain_id);
  }

  if (query.contact_name) {
    q = q.contains("entities", [query.contact_name]);
  }

  if (query.since) {
    q = q.gte("source_date", query.since);
  }

  if (query.until) {
    q = q.lte("source_date", query.until);
  }

  if (query.saved !== undefined) {
    q = q.eq("saved", query.saved);
  }

  if (query.archived !== undefined) {
    q = q.eq("archived", query.archived);
  }

  q = q.limit(query.limit ?? 100);

  const { data, error } = await q;
  if (error) throw new Error(`queryAtoms failed: ${error.message}`);
  return (data || []) as DxAtom[];
}

// ─── Get atoms for a specific date (for vault export) ──

export async function getAtomsForDate(date: string): Promise<DxAtom[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("dx_atoms")
    .select("*")
    .eq("source_date", date)
    .eq("archived", false)
    .order("type")
    .order("created_at");

  if (error) throw new Error(`getAtomsForDate failed: ${error.message}`);
  return (data || []) as DxAtom[];
}

// ─── Get atoms for a date range (for weekly digest) ──

export async function getAtomsForRange(
  since: string,
  until: string,
): Promise<DxAtom[]> {
  const db = getSupabaseAdmin();

  // Paginate to avoid Supabase 1000-row default limit
  const allAtoms: DxAtom[] = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await db
      .from("dx_atoms")
      .select("*")
      .gte("source_date", since)
      .lte("source_date", until)
      .eq("archived", false)
      .order("source_date")
      .order("type")
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`getAtomsForRange failed: ${error.message}`);
    if (!data || data.length === 0) break;

    allAtoms.push(...(data as DxAtom[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return allAtoms;
}

// ─── Update ──────────────────────────────────────

export async function updateAtom(
  id: string,
  updates: Partial<Pick<DxAtom, "archived" | "saved">>,
): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db.from("dx_atoms").update(updates).eq("id", id);
  if (error) throw new Error(`updateAtom failed: ${error.message}`);
}
