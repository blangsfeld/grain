/**
 * dx_atoms CRUD + search
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { DxAtom, DxAtomInsert, AtomType } from "@/types/atoms";

// ─── Insert ──────────────────────────────────────

export async function insertAtoms(atoms: DxAtomInsert[]): Promise<DxAtom[]> {
  if (atoms.length === 0) return [];

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
  since?: string;       // ISO date
  until?: string;       // ISO date
  saved?: boolean;
  archived?: boolean;
  limit?: number;
}

export async function queryAtoms(query: AtomQuery): Promise<DxAtom[]> {
  const db = getSupabaseAdmin();
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
  const { data, error } = await db
    .from("dx_atoms")
    .select("*")
    .gte("source_date", since)
    .lte("source_date", until)
    .eq("archived", false)
    .order("source_date")
    .order("type");

  if (error) throw new Error(`getAtomsForRange failed: ${error.message}`);
  return (data || []) as DxAtom[];
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
