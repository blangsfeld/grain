-- Grain: typed intelligence atoms extracted from conversations
CREATE TABLE IF NOT EXISTS dx_atoms (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),

  -- Type discriminator
  type text NOT NULL CHECK (type IN (
    'belief', 'tension', 'quote', 'voice',
    'commitment', 'read'
  )),

  -- Content (shape varies by type)
  content jsonb NOT NULL,

  -- Attribution
  transcript_id uuid REFERENCES dx_transcripts(id) ON DELETE SET NULL,
  source_title text,
  source_date date,

  -- Entity resolution
  entities text[],
  domain text,
  domain_id uuid REFERENCES dx_domains(id) ON DELETE SET NULL,
  contact_ids uuid[],

  -- Housekeeping
  archived boolean DEFAULT false,
  saved boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_atoms_type ON dx_atoms (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atoms_transcript ON dx_atoms (transcript_id);
CREATE INDEX IF NOT EXISTS idx_atoms_domain ON dx_atoms (domain_id) WHERE domain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_atoms_date ON dx_atoms (source_date DESC);
CREATE INDEX IF NOT EXISTS idx_atoms_contact ON dx_atoms USING gin (contact_ids);
