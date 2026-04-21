# Source v2 Legacy Archive

Archived at: 2026-04-21T03:13:55.887Z
Source DB: https://znyermbuvnpulpfutros.supabase.co

## Contents

- dx_transcripts: 92 rows → transcripts.jsonl + transcripts/*.md
- dx_signals:     301 rows → signals.jsonl
- dx_atoms:       132 rows → atoms.jsonl
- dx_commitments: 98 rows → commitments.jsonl

## Restoration

Each .jsonl is one row per line, full column set. To restore into a new Supabase:

```sql
-- Example for transcripts:
CREATE TEMP TABLE t AS SELECT * FROM dx_transcripts WHERE false;
COPY t FROM 'transcripts.jsonl' WITH (FORMAT json);
-- then INSERT INTO dx_transcripts SELECT * FROM t;
```

## Why archived

Pre-Granola-public-API ingest pipeline. `source_type='transcript'` rows
contaminated the shared `dx_transcripts` table with 20 NULL-dated entries
whose titles misled Keys into reporting February titles as "the latest".
Keys was patched (NULLS LAST + NOT NULL filter) and this legacy slice
was moved here to remove the contamination at the source.

No grain code references these rows. The 21 hand-labeled training
commitments (via commitment_labels) have zero overlap with this archive.
