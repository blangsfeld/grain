-- Buddy promotion + close loop: track which meeting commitments have been
-- promoted to Notion (kept list), and store pending Telegram menus so
-- "promote 2,5" / "done 1 recur 2" replies can resolve against the last
-- menu sent to that chat.

ALTER TABLE dx_commitments
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_to_notion_id text;

-- Surfacing query hits this constantly. Partial index keeps it tight.
CREATE INDEX IF NOT EXISTS idx_dx_commitments_unpromoted
  ON dx_commitments (person, meeting_date DESC)
  WHERE status = 'open' AND promoted_at IS NULL;

CREATE TABLE IF NOT EXISTS buddy_pending_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('promote', 'close')),
  items jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_buddy_menus_pending
  ON buddy_pending_menus (chat_id, created_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE buddy_pending_menus IS
  'Most recent unresolved menu per chat is what "promote 2,5" / "done 1 recur 2" resolves against. Resolved menus are kept for audit.';
