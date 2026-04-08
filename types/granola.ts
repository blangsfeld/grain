/**
 * Granola API types
 * Carried forward from Source v2.
 */

export interface GranolaTokens {
  access_token: string;
  refresh_token: string;
}

export interface GranolaDocument {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  last_viewed_panel?: {
    content: Record<string, unknown>;
  };
}

export interface GranolaUtterance {
  source: "microphone" | "system";
  text: string;
  start_timestamp: string;
  end_timestamp: string;
  confidence: number;
}

export interface GranolaFolder {
  id: string;
  title: string;
  created_at: string;
  workspace_id: string;
  document_ids: string[];
  is_favourite: boolean;
}

export interface GranolaNotesMetadata {
  participants: string[];
  topic?: string;
}

export type GranolaConnectionStatus =
  | "unknown"
  | "connected"
  | "expired"
  | "unavailable"
  | "error";
