-- Widen dx_transcripts.source_type check constraint to cover the URL-ingest
-- lane: article, claude_chat, and youtube (Milli's wiki triage → atoms path).
-- The prior constraint silently rejected every URL-ingest attempt.

ALTER TABLE dx_transcripts DROP CONSTRAINT dx_transcripts_source_type_check;

ALTER TABLE dx_transcripts ADD CONSTRAINT dx_transcripts_source_type_check CHECK (
  source_type = ANY (ARRAY[
    'transcript'::text,
    'document'::text,
    'paste'::text,
    'voice'::text,
    'granola'::text,
    'slack'::text,
    'article'::text,
    'claude_chat'::text,
    'youtube'::text
  ])
);
