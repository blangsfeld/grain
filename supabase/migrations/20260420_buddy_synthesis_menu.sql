-- Buddy synthesis menu — the sectioned chief-of-staff briefing Buddy surfaces
-- to Telegram each morning. Stored in buddy_pending_menus so replies ("2",
-- "tell me about 3", "draft the Daniell one") can resolve against the most
-- recent synthesis for that chat.

ALTER TABLE buddy_pending_menus
  DROP CONSTRAINT IF EXISTS buddy_pending_menus_kind_check;

ALTER TABLE buddy_pending_menus
  ADD CONSTRAINT buddy_pending_menus_kind_check
  CHECK (kind IN ('promote', 'close', 'synthesis'));

COMMENT ON TABLE buddy_pending_menus IS
  'Most recent unresolved menu per chat is what Telegram replies resolve against — "promote 2,5", "done 1 recur 2", or a bare "2" referencing a synthesis briefing thread. Resolved menus are kept for audit.';
