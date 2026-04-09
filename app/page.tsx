"use client";

import { useState, useCallback } from "react";
import type { AtomType } from "@/types/atoms";

// ─── Types ──────────────────────────────────────

interface IngestResult {
  title: string;
  url: string;
  url_type: string;
  atoms: number;
  tokens: number;
  pass_results: Record<string, number>;
  status: "extracted" | "dismissed" | "duplicate";
  error?: string;
}

interface Atom {
  id: string;
  type: AtomType;
  content: Record<string, unknown>;
  source_title: string | null;
  source_date: string | null;
  entities: string[];
  domain: string | null;
  saved: boolean;
}

// ─── Atom type config ───────────────────────────

const TYPE_COLORS: Record<AtomType, string> = {
  belief: "bg-violet-500/20 text-violet-300",
  tension: "bg-amber-500/20 text-amber-300",
  quote: "bg-sky-500/20 text-sky-300",
  voice: "bg-emerald-500/20 text-emerald-300",
  commitment: "bg-rose-500/20 text-rose-300",
  read: "bg-zinc-500/20 text-zinc-300",
};

const ALL_TYPES: AtomType[] = ["belief", "tension", "quote", "voice", "commitment", "read"];

// ─── Atom content rendering ─────────────────────

function atomSummary(atom: Atom): string {
  const c = atom.content;
  switch (atom.type) {
    case "belief":
      return (c.statement as string) || "";
    case "tension":
      return (c.gap as string) || `${c.stated} → ${c.actual}`;
    case "quote":
      return `"${c.text}" — ${c.speaker}`;
    case "voice":
      return `"${c.quote}"`;
    case "commitment":
      return (c.statement as string) || "";
    case "read":
      return (c.the_read as string) || (c.whats_moving as string) || "";
    default:
      return JSON.stringify(c).slice(0, 200);
  }
}

function atomDetail(atom: Atom): string | null {
  const c = atom.content;
  switch (atom.type) {
    case "belief":
      return c.evidence as string;
    case "tension":
      return c.breakthrough_condition as string;
    case "quote":
      return c.reasoning as string;
    case "voice":
      return c.why_it_works as string;
    case "commitment": {
      const parts: string[] = [];
      if (c.person) parts.push(c.person as string);
      if (c.due_date) parts.push(`by ${c.due_date}`);
      if (c.conviction) parts.push(`(${c.conviction})`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "read":
      return c.whats_stuck as string;
    default:
      return null;
  }
}

// ─── Component ──────────────────────────────────

export default function GrainUI() {
  // Ingest state
  const [url, setUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);

  // Search state
  const [search, setSearch] = useState("");
  const [activeTypes, setActiveTypes] = useState<Set<AtomType>>(new Set());
  const [atoms, setAtoms] = useState<Atom[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // ─── Ingest ───────────────────────────────────

  const handleIngest = useCallback(async () => {
    if (!url.trim()) return;
    setIngesting(true);
    setIngestResult(null);
    setIngestError(null);

    try {
      const res = await fetch("/api/ingest/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ingest failed");
      setIngestResult(data);
      setUrl("");
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIngesting(false);
    }
  }, [url]);

  // ─── Search ───────────────────────────────────

  const handleSearch = useCallback(async () => {
    setSearching(true);
    setHasSearched(true);

    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (activeTypes.size > 0) params.set("type", Array.from(activeTypes).join(","));
    params.set("limit", "50");

    try {
      const res = await fetch(`/api/atoms?${params}`);
      const data = await res.json();
      setAtoms(data.atoms || []);
    } catch {
      setAtoms([]);
    } finally {
      setSearching(false);
    }
  }, [search, activeTypes]);

  const toggleType = (type: AtomType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // ─── Save/unsave ──────────────────────────────

  const toggleSaved = async (atom: Atom) => {
    const newSaved = !atom.saved;
    setAtoms((prev) =>
      prev.map((a) => (a.id === atom.id ? { ...a, saved: newSaved } : a))
    );
    await fetch("/api/atoms", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: atom.id, saved: newSaved }),
    });
  };

  // ─── Render ───────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Grain</h1>
        <p className="text-sm text-zinc-500 mb-10">
          Paste a URL to ingest. Search your atoms.
        </p>

        {/* ─── Ingest ─────────────────────────── */}
        <section className="mb-12">
          <div className="flex gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleIngest()}
              placeholder="Paste a URL — Claude.ai chat, article, anything"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
              disabled={ingesting}
            />
            <button
              onClick={handleIngest}
              disabled={ingesting || !url.trim()}
              className="px-5 py-2.5 bg-zinc-100 text-zinc-900 text-sm font-medium rounded-lg hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {ingesting ? "Ingesting…" : "Ingest"}
            </button>
          </div>

          {ingestResult && (
            <div className="mt-3 p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-sm">
              {ingestResult.status === "extracted" && (
                <span className="text-emerald-400">
                  Extracted {ingestResult.atoms} atoms from "{ingestResult.title}"
                  {Object.keys(ingestResult.pass_results).length > 0 && (
                    <span className="text-zinc-500">
                      {" "}— {Object.entries(ingestResult.pass_results).map(([k, v]) => `${k}: ${v}`).join(", ")}
                    </span>
                  )}
                </span>
              )}
              {ingestResult.status === "duplicate" && (
                <span className="text-zinc-400">Already ingested: "{ingestResult.title}"</span>
              )}
              {ingestResult.status === "dismissed" && (
                <span className="text-zinc-400">Dismissed (no extractable content): "{ingestResult.title}"</span>
              )}
            </div>
          )}

          {ingestError && (
            <div className="mt-3 p-3 rounded-lg bg-red-950/50 border border-red-900/50 text-sm text-red-300">
              {ingestError}
            </div>
          )}
        </section>

        {/* ─── Search ─────────────────────────── */}
        <section>
          <div className="flex gap-3 mb-4">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search atoms…"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="px-5 py-2.5 bg-zinc-800 text-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              {searching ? "…" : "Search"}
            </button>
          </div>

          {/* Type filters */}
          <div className="flex flex-wrap gap-2 mb-6">
            {ALL_TYPES.map((type) => (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  activeTypes.has(type)
                    ? `${TYPE_COLORS[type]} border-transparent`
                    : "text-zinc-500 border-zinc-800 hover:border-zinc-600"
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* Results */}
          {atoms.length > 0 && (
            <div className="space-y-2">
              {atoms.map((atom) => (
                <div
                  key={atom.id}
                  className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${TYPE_COLORS[atom.type]}`}>
                          {atom.type}
                        </span>
                        {atom.source_date && (
                          <span className="text-[10px] text-zinc-600">{atom.source_date}</span>
                        )}
                        {atom.domain && (
                          <span className="text-[10px] text-zinc-600">{atom.domain}</span>
                        )}
                      </div>
                      <p className="text-sm text-zinc-200 leading-relaxed">
                        {atomSummary(atom)}
                      </p>
                      {atomDetail(atom) && (
                        <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
                          {atomDetail(atom)}
                        </p>
                      )}
                      {atom.entities.length > 0 && (
                        <div className="flex gap-1.5 mt-2">
                          {atom.entities.map((e) => (
                            <span key={e} className="text-[10px] text-zinc-600">{e}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => toggleSaved(atom)}
                      className={`shrink-0 text-xs transition-colors ${
                        atom.saved ? "text-amber-400" : "text-zinc-700 opacity-0 group-hover:opacity-100"
                      }`}
                      title={atom.saved ? "Unsave" : "Save"}
                    >
                      {atom.saved ? "★" : "☆"}
                    </button>
                  </div>
                  {atom.source_title && (
                    <p className="text-[10px] text-zinc-700 mt-2 truncate">{atom.source_title}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {hasSearched && atoms.length === 0 && !searching && (
            <p className="text-sm text-zinc-600 text-center py-8">No atoms found.</p>
          )}
        </section>
      </div>
    </div>
  );
}
