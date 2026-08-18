/**
 * Wire types, transcribed from docs/API.md. Nothing here is invented; where the
 * contract leaves a field open (`context.links`, audit `detail`) the type stays
 * loose rather than guessing a shape the server may not send.
 */

export type ReviewKind = "confirm" | "choice" | "ack" | "manual" | "review";
export type Urgency = "low" | "normal" | "blocking";
export type ReviewStatus = "open" | "answered" | "expired" | "cancelled";
export type AttachmentKind = "diff" | "code" | "markdown" | "mermaid";

export interface User {
  id: string;
  handle: string;
  display_name: string;
  role: string;
  created_at: string;
}

export interface AuthState {
  enrolled: boolean;
  enrollment_open: boolean;
  origin: string;
  rp_id: string;
}

export interface Bootstrap {
  user: User;
  version: string;
  terminal_enabled: boolean;
  counts: { review_open: number; agents_blocked: number };
  vapid_public_key: string | null;
  /** Whether this session has asserted a passkey inside the step-up window. */
  stepped_up?: boolean;
  /** How long an assertion counts as fresh. 300 at the time of writing. */
  step_up_window_seconds?: number;
}

export interface ReviewOption {
  key: string;
  label: string;
  detail?: string;
}

export interface ReviewContext {
  repo?: string;
  branch?: string;
  worker?: string;
  links?: { label?: string; title?: string; url: string }[];
}

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  title: string;
  language?: string;
  content: string;
}

export interface ReviewItem {
  id: string;
  title: string;
  kind: ReviewKind;
  urgency: Urgency;
  status: ReviewStatus;
  body_md: string;
  options?: ReviewOption[] | null;
  /** Dropped entirely when status is `expired` — a timeout is never consent. */
  recommend?: string | null;
  context?: ReviewContext | null;
  attachments?: Attachment[] | null;
  created_at: string;
  expires_at?: string | null;
  answered_at?: string | null;
  answer_value?: string | null;
  answer_note?: string | null;
  /** "agent" for a submitted document, "herdr" for a synthesized blocked-agent row. */
  source?: string;
}

export interface Task {
  id: string;
  body: string;
  scope?: string | null;
  status?: string;
  created_at?: string;
  claimed_at?: string | null;
  completed_at?: string | null;
  result?: string | null;
}

export interface AgentRow {
  name: string;
  workspace: string;
  kind: string;
  status: string;
  /** Seconds in the current status, per the contract's `elapsed`. */
  elapsed: number;
  pane_id: string;
}

export interface Ticket {
  ticket: string;
  expires_at: string;
}

export interface Credential {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
  backup_state?: string | null;
  /**
   * Whether a step-up satisfied by *this* passkey may open a terminal. A phone
   * left as review-only cannot reach a PTY even if its session is stolen.
   */
  can_terminal?: boolean;
}

/** What `POST /api/v1/auth/stepup/finish` hands back. */
export interface StepUpResult {
  stepped_up_until: string;
  credential: { id: string; name: string; can_terminal: boolean };
}

export interface SessionRow {
  id: string;
  user_agent: string;
  ip: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  kind: string;
  subject: string;
  ip?: string | null;
  user_agent?: string | null;
  detail?: unknown;
}

export interface EnrollmentPermit {
  code: string;
  expires_at: string;
}

/** `/ws/stream` text frames. Ids and versions, never bodies. */
export interface StreamEvent {
  type: "review.created" | "review.answered" | "agent.status" | "counts" | string;
  id?: string;
  counts?: { review_open: number; agents_blocked: number };
  [k: string]: unknown;
}
