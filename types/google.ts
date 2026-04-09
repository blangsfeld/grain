/**
 * Google OAuth + Calendar + Gmail types
 */

// ─── Auth ─────────────────────────────────────

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  /** Unix timestamp (ms) when access_token expires */
  expires_at: number;
  scope: string;
}

export type GoogleConnectionStatus =
  | "connected"
  | "expired"
  | "no_token"
  | "invalid_token";

// ─── Calendar ─────────────────────────────────

export interface GoogleCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  attendees: GoogleAttendee[];
  description?: string;
  location?: string;
  calendar_id: string;
  calendar_name: string;
}

export interface GoogleAttendee {
  email: string;
  name?: string;
  self?: boolean;
  response?: "accepted" | "declined" | "tentative" | "needsAction";
}

export interface GoogleCalendar {
  id: string;
  name: string;
  primary: boolean;
}

// ─── Gmail ────────────────────────────────────

export interface GmailThread {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  message_count: number;
}

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;
}
