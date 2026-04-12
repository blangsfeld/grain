-- Extends dx_atoms.type check constraint to allow 'decision'.
-- Applied alongside meta_relationships column for Phase 1-2 of the vault evolution.
ALTER TABLE dx_atoms DROP CONSTRAINT IF EXISTS dx_atoms_type_check;
ALTER TABLE dx_atoms ADD CONSTRAINT dx_atoms_type_check
  CHECK (type = ANY (ARRAY['belief'::text, 'tension'::text, 'quote'::text, 'voice'::text, 'commitment'::text, 'read'::text, 'decision'::text]));
