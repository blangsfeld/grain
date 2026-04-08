/**
 * Entity types — contacts and domains.
 * Carried forward from Source v2.
 */

export interface DxContact {
  id: string;
  canonical_name: string;
  aliases: string[];
  role: string | null;
  domain_id: string | null;
}

export interface DxDomain {
  id: string;
  canonical_name: string;
  aliases: string[];
  entity_type: string | null;
}

export interface ResolvedContact {
  canonicalName: string;
  contactId: string;
}

export interface ResolvedDomain {
  canonicalName: string;
  domainId: string;
}
