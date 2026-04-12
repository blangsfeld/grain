CREATE TABLE IF NOT EXISTS dx_resolved_loops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  statement_hash text NOT NULL UNIQUE,
  statement text NOT NULL,
  owner text,
  resolved_at timestamptz DEFAULT now(),
  resolved_note text
);

CREATE INDEX idx_resolved_loops_hash ON dx_resolved_loops (statement_hash);

COMMENT ON TABLE dx_resolved_loops IS 'Loops marked as resolved via /wrap. Boot context filters these out so resolved loops stop surfacing.';
