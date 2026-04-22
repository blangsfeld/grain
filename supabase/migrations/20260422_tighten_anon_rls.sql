-- Tighten anon-accessible tables from FOR ALL USING(true) to SELECT-only.
-- Service role bypasses RLS so ingest/writes are unaffected. Town + other
-- read-only consumers keep their SELECT path via the anon/publishable key.
--
-- Mirrors the 20260421_anon_select_atoms_signal pattern.
-- Remaining permissive policies flagged by Dood's security sweep.

DROP POLICY IF EXISTS dx_contacts_all ON dx_contacts;
DROP POLICY IF EXISTS dx_domains_all ON dx_domains;
DROP POLICY IF EXISTS dx_transcripts_all ON dx_transcripts;
DROP POLICY IF EXISTS "Allow all" ON signal_cards;

CREATE POLICY dx_contacts_anon_select ON dx_contacts
  FOR SELECT TO anon USING (true);

CREATE POLICY dx_domains_anon_select ON dx_domains
  FOR SELECT TO anon USING (true);

CREATE POLICY dx_transcripts_anon_select ON dx_transcripts
  FOR SELECT TO anon USING (true);

CREATE POLICY signal_cards_anon_select ON signal_cards
  FOR SELECT TO anon USING (true);
