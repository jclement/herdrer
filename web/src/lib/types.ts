/**
 * Wire types, transcribed from docs/API.md. Nothing here is invented; where the
 * contract leaves a field open (`context.links`, audit `detail`) the type stays
 * loose rather than guessing a shape the server may not send.
 */

export type ReviewKind = "confirm" | "choice" | "ack" | "manual" | "review";
export type Urgency = "low" | "normal" | "blocking";
export type ReviewStatus = "open" | "answered" | "expired" | "cancelled";
/**
 * `image` and `filediff` are newer than the rest and both render *inside* the
 * sandboxed document rather than out here — an image is inlined as a data URI,
 * and a filediff is a unified diff the server computed from the two whole files
 * the agent sent. The page's own chrome still has to count them and offer a way
 * to jump to them, which is what lib/attachments.ts is for.
 *
 * The union stays open at the end: a server that grows a seventh kind should
 * make this UI show a row that says so, not crash and not silently drop it.
 */
export type AttachmentKind =
  "diff" | "code" | "markdown" | "mermaid" | "image" | "filediff" | (string & {});

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
  /**
   * Optional because two of the kinds do not have one. An `image` carries an
   * asset reference the document inlines, and a `filediff` may arrive as its
   * two originals with the server's computed diff alongside.
   */
  content?: string;
  /** `image`: the uploaded asset the document inlines as a data URI. */
  asset_id?: string;
  media_type?: string;
  /** `filediff`: the originals, kept so the reader can expand past the hunks. */
  before?: string;
  after?: string;
  context?: number;
  /** `diff` / `filediff`: the server's line counts, when it sends them. */
  adds?: number;
  dels?: number;
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

/* --- the herdr session tree -------------------------------------------------
 *
 * `GET /api/v1/herdr/state`. Transcribed from docs/API.md; the shape is
 * workspace → tab → pane, with an agent hanging off a pane when herdr
 * recognised one in it.
 *
 * `running:false` with an empty tree is an ordinary state, not an error — a box
 * that has just booted may not have a herdr server yet. Nothing here may treat
 * it as a failure.
 */

/** The agent occupying a pane. Same shape as a row of `/api/v1/agents`. */
export interface HerdrAgent {
  name: string;
  kind: string;
  status: string;
  workspace?: string;
  pane_id?: string;
  title?: string;
  cwd?: string;
  focused?: boolean;
  /** Present on the flat `/api/v1/agents` list, absent inside the tree. */
  elapsed?: number;
}

export interface HerdrPane {
  id: string;
  tab_id: string;
  workspace_id: string;
  title: string;
  cwd: string;
  focused: boolean;
  agent_status: string;
  /** Absent when the pane holds a plain shell rather than a recognised agent. */
  agent?: HerdrAgent;
}

export interface HerdrTab {
  id: string;
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  agent_status: string;
  panes?: HerdrPane[] | null;
}

export interface HerdrWorkspace {
  id: string;
  label: string;
  number: number;
  focused: boolean;
  agent_status: string;
  tab_count: number;
  pane_count: number;
  tabs?: HerdrTab[] | null;
}

export interface HerdrState {
  running: boolean;
  version?: string;
  protocol?: number;
  blocked?: number;
  workspaces?: HerdrWorkspace[] | null;
  agents?: HerdrAgent[] | null;
}
