CREATE POLICY dx_atoms_anon_select ON dx_atoms
  FOR SELECT TO anon USING (true);

CREATE POLICY signal_entities_anon_select ON signal_entities
  FOR SELECT TO anon USING (true);
