# Grain

Autonomous intelligence pipeline. Listens to conversations, extracts typed atoms (beliefs, tensions, quotes, voice, commitments), builds knowledge that flows into Obsidian vault, daily briefings, and Canvas.

Granular synthesis for conversations: snip, clip, sample, smudge, loop, reverb.

## Architecture

Headless pipeline with minimal UI. Same Supabase instance as Source v2.

```
Granola (polling) → Classify (Haiku) → Multi-pass Extract (Sonnet) → Entity Resolve → dx_atoms
                                                                                        ↓
                                                                              Vault Export (daily highlights)
                                                                              Daily Briefing (calendar-aware)
                                                                              Weekly Digest (emerging narratives)
```

## Database

Shared Supabase instance. Tables retain `dx_` prefix. Key tables:
- `dx_atoms` — Typed intelligence atoms (belief, tension, quote, voice, commitment, read)
- `dx_transcripts` — Source material, dedup by hash
- `dx_contacts` — People with aliases, domain affiliation
- `dx_domains` — Organizations with aliases and hierarchy

## File Architecture

```
lib/
  supabase.ts          # Shared Supabase client
  anthropic.ts         # Shared Anthropic client
  granola.ts           # Granola API client (token mgmt, API calls, formatting)
  classify.ts          # Lightweight Haiku classifier (dual boolean)
  atom-extract.ts      # Multi-pass extraction engine
  atom-db.ts           # dx_atoms CRUD + search
  resolve.ts           # Entity resolution (contact + domain matching)
  entities-db.ts       # Contact + domain CRUD
  vault-export.ts      # Daily highlights + weekly digest to Obsidian
  granola-ingest.ts    # Auto-ingest orchestrator
  briefing-daily.ts    # Daily briefing context assembly
  briefing-daily-prompt.ts  # Daily briefing prompt
  prompts/
    read.ts            # Meeting read pass (momentum, friction, commitments, gaps)
    quotes.ts          # High-weight quotes with strategic context
    beliefs.ts         # Belief extraction (stated/implied/aspirational)
    tensions.ts        # Stated vs actual gaps
    voice.ts           # Verbal frameworks, compressions, reframes
    commitments.ts     # Who owes what by when
types/
  atoms.ts             # DxAtom types + content shapes per type
  granola.ts           # Granola API types
  entities.ts          # Contact/domain types
app/
  api/ingest/granola/  # Auto-ingest endpoint
  api/atoms/           # Atom CRUD + search
  api/mailroom/        # Classification endpoint
  api/briefings/daily/ # Daily briefing
```

## Rules
1. No new npm dependencies without justification
2. Prompts are short and focused (~200-400 words each, adapted from Canvas instrument model)
3. `maxDuration = 120` on single-meeting API routes, `300` on batch ingest
4. All prompts doctrine-compliant (empathy-first, lead with strengths, no hedge words)
5. Beliefs are the USER's beliefs, not other people's. Other people's convictions are quotes
6. Entity resolution runs once after all passes complete for a transcript
7. Vault export is non-fatal — filesystem errors never fail extraction

## Vocabulary
- **Atom** — Typed intelligence unit: belief, tension, quote, voice, commitment, read
- **Grain** — The system itself. Granular synthesis metaphor
- **Pass** — One focused extraction run (e.g. "the quotes pass", "the beliefs pass")
- **Read** — The trajectory diagnosis of a meeting (momentum, friction, gaps)
