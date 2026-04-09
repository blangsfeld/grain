# Grain

Autonomous intelligence pipeline. Listens to conversations, extracts typed atoms (beliefs, tensions, quotes, voice, commitments), builds knowledge that flows into Obsidian vault, daily briefings, and Canvas.

Granular synthesis for conversations: snip, clip, sample, smudge, loop, reverb.

## Architecture

Headless pipeline with minimal UI. Same Supabase instance as Source v2.

```
Granola (polling) → Classify (Haiku) → Multi-pass Extract (Sonnet) → Entity Resolve → dx_atoms
URL Ingest (paste) → Classify (Haiku) → Multi-pass Extract (Sonnet) → Entity Resolve → dx_atoms
                                                                                        ↓
                                                                              Vault Export (daily highlights)
                                                                              Daily Briefing (email + vault)
                                                                              Weekly Digest (emerging narratives)
                                                                              Company Pages (living vault profiles)
                                                                              Company Trajectories (quarterly arcs)
```

### Briefing System

Three modes, same atom corpus:
- **Monday exec prep** — week-in-review, commitment audit, exec anticipation, agenda items to raise
- **Tue-Fri daily** — calendar-prepped meetings with atom context, open loops, build + industry intel
- **Company pages** — living vault profiles refreshed weekly, trajectory docs generated quarterly

Delivery: email to ben@residence.co (from "Grain") + vault archive.

Context sources: Google Calendar, Gmail, atom corpus, git repo activity, web search seeded by atom themes.

## Database

Shared Supabase instance. Tables retain `dx_` prefix. Key tables:
- `dx_atoms` — Typed intelligence atoms (belief, tension, quote, voice, commitment, read)
- `dx_transcripts` — Source material, dedup by hash (has source_url for ingested URLs)
- `dx_contacts` — People with aliases, domain affiliation
- `dx_domains` — Organizations with aliases and hierarchy
- `dx_briefings` — Generated briefings (type: daily, monday_exec)

Postgres function `search_atoms(search_term, type_filter, max_results)` — full-text search across atom content JSONB.

## File Architecture

```
lib/
  supabase.ts            # Shared Supabase client
  anthropic.ts           # Shared Anthropic client
  google.ts              # Google Calendar + Gmail + Send client
  granola.ts             # Granola API client (token mgmt, API calls, formatting)
  classify.ts            # Lightweight Haiku classifier (dual boolean)
  atom-extract.ts        # Multi-pass extraction engine
  atom-db.ts             # dx_atoms CRUD + search (incl. RPC text search)
  resolve.ts             # Entity resolution (contact + domain matching)
  entities-db.ts         # Contact + domain CRUD
  url-ingest.ts          # URL ingest (Claude.ai chats, articles → atoms)
  vault-export.ts        # Daily highlights + weekly digest to Obsidian
  granola-ingest.ts      # Auto-ingest orchestrator
  briefing-context.ts    # Briefing context assembly (Monday + daily modes)
  briefing-prompts.ts    # Briefing prompt variants
  briefing-deliver.ts    # Email delivery + vault archive
  build-intel.ts         # Git repo activity scanning
  industry-edge.ts       # Web search seeded by atom themes
  company-pages.ts       # Company page + trajectory generation
  weekly-digest.ts       # Weekly digest generation
  prompts/
    read.ts              # Meeting read pass
    quotes.ts            # High-weight quotes with strategic context
    beliefs.ts           # Belief extraction (stated/implied/aspirational)
    tensions.ts          # Stated vs actual gaps
    voice.ts             # Verbal frameworks, compressions, reframes
    commitments.ts       # Who owes what by when
    weekly-digest.ts     # Weekly digest prompt
types/
  atoms.ts               # DxAtom types + content shapes per type
  granola.ts             # Granola API types
  entities.ts            # Contact/domain types
  google.ts              # Google Calendar + Gmail types
app/
  page.tsx               # Paste/search UI
  api/ingest/granola/    # Auto-ingest endpoint (Granola polling)
  api/ingest/url/        # URL ingest endpoint (paste → extract)
  api/atoms/             # Atom CRUD + search
  api/briefings/daily/   # Briefing generation (Monday + daily)
  api/company-pages/     # Company page + trajectory refresh
  api/cron/daily/        # Daily cron: vault highlights + briefing
  api/cron/weekly/       # Weekly cron: digest + company pages
  api/digest/daily/      # Batch daily highlights
  api/digest/weekly/     # Batch weekly digests
```

## Rules
1. No new npm dependencies without justification
2. Prompts are short and focused (~200-400 words each, adapted from Canvas instrument model)
3. `maxDuration = 120` on single-meeting API routes, `300` on batch/briefing routes
4. All prompts doctrine-compliant (empathy-first, lead with strengths, no hedge words)
5. Beliefs are the USER's beliefs, not other people's. Other people's convictions are quotes
6. Entity resolution runs once after all passes complete for a transcript
7. Vault export is non-fatal — filesystem errors never fail extraction
8. Email delivery is non-fatal — email errors never fail briefing generation
9. Supabase queries must paginate or set explicit limits (1000-row default)

## Vocabulary
- **Atom** — Typed intelligence unit: belief, tension, quote, voice, commitment, read
- **Grain** — The system itself. Granular synthesis metaphor
- **Pass** — One focused extraction run (e.g. "the quotes pass", "the beliefs pass")
- **Read** — The trajectory diagnosis of a meeting (momentum, friction, gaps)
- **Trajectory** — Quarterly arc document showing how a company's understanding evolved
- **Edge** — Build intel + industry context that keeps you a step ahead
