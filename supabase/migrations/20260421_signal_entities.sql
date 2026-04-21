-- Signal Engine — entity lifecycle substrate
--
-- Two tables backing the compression lifecycle index:
--   signal_entities         canonical row per normalized entity
--   signal_entity_mentions  append-only mention log per atom/transcript
--
-- Lifecycle states:
--   first_appearance → recurrence → crystallization → published / retired
--
-- Normalization strategy (v0): exact-match on canonical_key.
--   tensions: slug (already kebab-normalized by the relationships pass)
--   voice / belief: lower-case, strip punctuation, collapse whitespace,
--                   take first 100 chars of the compression statement
--
-- Nightly LLM merge pass and embedding clustering are layered on later.

create table if not exists signal_entities (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('tension','voice','belief','phrase','topic','question')),
  canonical_label text not null,
  canonical_key text not null,
  aliases text[] not null default '{}',
  first_seen date not null,
  last_seen date not null,
  mention_count int not null default 0,
  distinct_context_count int not null default 0,
  lifecycle_state text not null default 'first_appearance'
    check (lifecycle_state in ('first_appearance','recurrence','crystallization','published','retired')),
  state_transitions jsonb not null default '[]'::jsonb,
  domain text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (type, canonical_key)
);

create index if not exists idx_signal_entities_type on signal_entities(type);
create index if not exists idx_signal_entities_last_seen on signal_entities(last_seen desc);
create index if not exists idx_signal_entities_lifecycle on signal_entities(lifecycle_state);
create index if not exists idx_signal_entities_type_state on signal_entities(type, lifecycle_state);

create table if not exists signal_entity_mentions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references signal_entities(id) on delete cascade,
  atom_id uuid references dx_atoms(id) on delete set null,
  transcript_id uuid references dx_transcripts(id) on delete set null,
  source_date date not null,
  source_title text,
  raw_label text not null,
  people text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_signal_mentions_entity on signal_entity_mentions(entity_id);
create index if not exists idx_signal_mentions_date on signal_entity_mentions(source_date desc);
create index if not exists idx_signal_mentions_atom on signal_entity_mentions(atom_id);
create index if not exists idx_signal_mentions_transcript on signal_entity_mentions(transcript_id);

-- Row-level security: match the pattern used for dx_atoms / dx_transcripts
-- (service role only for now — no end-user access surface yet).
alter table signal_entities enable row level security;
alter table signal_entity_mentions enable row level security;
