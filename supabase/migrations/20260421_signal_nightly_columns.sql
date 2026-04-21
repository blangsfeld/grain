-- Nightly job output columns + tables.
--
-- cadence_stats: {median_gap_days, last_gap_days, stddev_days, n_gaps}
-- dormant_flag: true when last_gap_days > 2 * median_gap_days
-- signal_nightly_runs: append-only log, composer reads latest row to write vault file
-- signal_merge_proposals: review queue for LLM merges below auto-threshold

alter table signal_entities
  add column if not exists cadence_stats jsonb not null default '{}'::jsonb,
  add column if not exists dormant_flag boolean not null default false,
  add column if not exists dormant_since date;

create index if not exists idx_signal_entities_dormant on signal_entities(dormant_flag) where dormant_flag = true;

create table if not exists signal_nightly_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  -- Tier-1 summaries
  retirements jsonb not null default '[]'::jsonb,
  dormancies jsonb not null default '[]'::jsonb,
  crystallizations jsonb not null default '[]'::jsonb,
  merges_auto jsonb not null default '[]'::jsonb,
  merges_proposed jsonb not null default '[]'::jsonb,
  -- Tier-2 summaries (empty until Tier-2 built)
  loop_closures jsonb not null default '[]'::jsonb,
  first_namings jsonb not null default '[]'::jsonb,
  framing_variances jsonb not null default '[]'::jsonb,
  -- Composer output
  composed_narrative text,
  vault_path text,
  tokens_used int not null default 0,
  errors jsonb not null default '[]'::jsonb
);

create index if not exists idx_signal_nightly_runs_date on signal_nightly_runs(run_date desc);

create table if not exists signal_merge_proposals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references signal_nightly_runs(id) on delete set null,
  proposed_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','applied')),
  entity_a_id uuid not null references signal_entities(id) on delete cascade,
  entity_b_id uuid not null references signal_entities(id) on delete cascade,
  confidence numeric(4,3) not null,
  llm_reasoning text,
  merged_label_suggestion text,
  resolved_at timestamptz,
  resolved_by text
);

create index if not exists idx_signal_merge_proposals_status on signal_merge_proposals(status);

alter table signal_nightly_runs enable row level security;
alter table signal_merge_proposals enable row level security;
