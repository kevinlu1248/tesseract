/**
 * The IPC contract — the typed boundary between the renderer (presentation) and
 * the main process (which drives Claude Code). Both sides import these types so
 * the wire format is a single explicit contract.
 */
import type { CcEvent, SessionStatus, TranscriptItem, UiImage } from './schema'

export type BackendProvider = 'claude' | 'codex'

/* ───────────────────────────── Channels ─────────────────────────────── */

export const IPC = {
  authGet: 'auth:get',
  dialogPickRepo: 'dialog:pick-repo',
  sessionStart: 'session:start',
  /** Create a git worktree (new branch) from a workspace repo. */
  worktreeCreate: 'worktree:create',
  sessionRevive: 'session:revive',
  sessionSend: 'session:send',
  sessionInterrupt: 'session:interrupt',
  sessionClose: 'session:close',
  permissionAnswer: 'permission:answer',
  questionAnswer: 'question:answer',
  sessionList: 'session:list',
  /** List recent conversations enriched with AI title + description (cards). */
  sessionSummaries: 'session:summaries',
  /** Lazily generate (or serve cached) one recent conversation's AI summary. */
  sessionGenerateSummary: 'session:generate-summary',
  sessionLoadHistory: 'session:load-history',
  sessionGenerateTitle: 'session:generate-title',
  /** Regenerate + cache a live session's AI description (on task completion). */
  sessionSummarize: 'session:summarize',
  /** main → renderer: a background-generated session card is ready. */
  sessionSummaryUpdated: 'session:summary-updated',
  /** Look up the most recently captured screenshot (for the "add to context" chip). */
  screenshotRecent: 'screenshot:recent',
  /** Bring the app window to the foreground (e.g. from a notification click). */
  windowFocus: 'window:focus',
  /** Relaunch the whole app — tears down every session, then restarts the process. */
  appRestart: 'app:restart',
  /** main → renderer push channel */
  sessionEvent: 'session:event'
} as const

/* ──────────────────────────────── Auth ──────────────────────────────── */

export interface AuthInfo {
  /** Always 'subscription' — this app never uses API-key billing. */
  mode: 'subscription'
  /** True if API-billing env vars were present (they are stripped / ignored). */
  apiKeyEnvSet: boolean
  /** Human-readable explanation for the status bar. */
  detail: string
}

/* ───────────────────────────── Permissions ──────────────────────────── */

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string }

/* ─────────────────────────── User questions ─────────────────────────── */

/** One selectable choice in an AskUserQuestion question. */
export interface QuestionOption {
  label: string
  /** What this choice means / its trade-offs. Shown under the label. */
  description?: string
}

/** A single question raised by the AskUserQuestion tool. */
export interface QuestionItem {
  /** The full question text. */
  question: string
  /** Short chip label (≤12 chars), e.g. "Auth method". */
  header: string
  /** When true the user may pick more than one option. */
  multiSelect: boolean
  options: QuestionOption[]
}

/** A request to ask the user one to four multiple-choice questions. */
export interface QuestionRequest {
  requestId: string
  questions: QuestionItem[]
}

/** The user's reply: one list of chosen labels per question, in order. A
 *  free-text "Other" answer appears verbatim as its question's entry. */
export interface QuestionAnswer {
  answers: string[][]
}

/* ─────────────────────── Main → renderer events ─────────────────────── */

export type SessionOutboundEvent =
  | { kind: 'cc'; event: CcEvent }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'error'; message: string; fatal: boolean }
  | { kind: 'sdk_session'; sdkSessionId: string }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'permission_resolved'; requestId: string }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'question_resolved'; requestId: string }

export interface SessionEventEnvelope {
  localId: string
  event: SessionOutboundEvent
}

/* ─────────────────────── Renderer → main requests ───────────────────── */

export interface StartSessionArgs {
  cwd: string
  provider?: BackendProvider
  model?: string
  /** Resume an existing SDK session id (re-attach a persisted conversation). */
  resumeSessionId?: string
  /**
   * "Yolo mode": auto-approve every tool permission instead of prompting.
   * Defaults to on for new sessions — the workspace is built for fast,
   * uninterrupted concurrent agents.
   */
  yolo?: boolean
}

/** Ask the main process to spin a new git worktree off a workspace repo. */
export interface CreateWorktreeArgs {
  /** The workspace repo path the worktree is branched from. */
  cwd: string
  /** The user's task prompt — the new branch name is derived from this. */
  prompt: string
}

export interface CreateWorktreeResult {
  /** Absolute path of the new worktree directory (becomes the session cwd). */
  path: string
  /** The branch created and checked out in the worktree. */
  branch: string
}

export interface ReviveSessionArgs {
  localId: string
  cwd: string
  provider?: BackendProvider
  /** SDK session id to resume; if absent, a fresh session is started. */
  resumeSessionId?: string
  /**
   * A user message is being sent right now and is the reason for this revive
   * (vs. reviving on focus). The backend opens the session in 'connecting'
   * instead of 'idle' so the composer reads as working immediately, with no
   * idle flicker while the subprocess spins up.
   */
  pendingSend?: boolean
}

export interface SendArgs {
  localId: string
  text: string
  /** Images attached to this message (base64), sent to the model alongside text. */
  images?: UiImage[]
}

export interface AnswerPermissionArgs {
  localId: string
  requestId: string
  decision: PermissionDecision
}

export interface AnswerQuestionArgs {
  localId: string
  requestId: string
  answer: QuestionAnswer
}

/** A recently-captured screenshot the user can one-click attach to their message. */
export interface RecentScreenshot {
  /** Absolute path on disk — used by the renderer to de-dupe / remember dismissals. */
  path: string
  /** File name, shown on the suggestion chip. */
  name: string
  /** Capture time (file mtime) in epoch ms. */
  takenAt: number
  /** The image bytes, ready to attach to a message. */
  image: UiImage
}

export interface SessionSummary {
  sessionId: string
  summary: string
  lastModified: number
  firstPrompt?: string
  provider?: BackendProvider
}

/**
 * A recent conversation rendered as a "pick up where you left off" card on the
 * new-message screen. The title/description are AI-generated in the background;
 * until that completes, `description` is null, `pending` is true, and `title`
 * holds a plain-text snippet fallback.
 */
export interface SessionCard {
  sessionId: string
  /** AI-generated short title, or a snippet fallback while pending. */
  title: string
  /** AI-generated one-to-two sentence description; null until generated. */
  description: string | null
  lastModified: number
  firstPrompt?: string
  provider?: BackendProvider
  /** True while the AI title/description are still being generated. */
  pending: boolean
}

/**
 * Ask the main process to (re)generate a live conversation's AI description and
 * write it to the summary cache, so the "pick up where you left off" cards are
 * already warm. Fired on each task completion. The title is taken from `title`
 * (the tab's existing AI title) and kept stable; only the description is
 * regenerated from the latest assistant output.
 */
export interface SummarizeSessionArgs {
  sessionId: string
  cwd: string
  provider?: BackendProvider
  /** The tab's current title — stored alongside the regenerated description. */
  title: string
  /** First user message — anchors what the conversation is about. */
  firstPrompt: string
  /** Latest assistant output — what was just accomplished. */
  latestState: string
}

/** A background-completed card, pushed to the renderer to patch its list. */
export interface SessionCardUpdate {
  /** The repo the card belongs to — the renderer ignores updates for other cwds. */
  cwd: string
  provider: BackendProvider
  card: SessionCard
}

/* ─────────────────── The surface exposed on window.api ───────────────── */

export interface WorkspaceApi {
  getAuth(): Promise<AuthInfo>
  pickRepo(): Promise<string | null>
  startSession(args: StartSessionArgs): Promise<{ localId: string }>
  /** Create a git worktree (new branch) off a workspace repo; returns its path. */
  createWorktree(args: CreateWorktreeArgs): Promise<CreateWorktreeResult>
  /** Resume a suspended tab's session under its existing localId (--resume). */
  reviveSession(args: ReviveSessionArgs): Promise<void>
  send(args: SendArgs): Promise<void>
  interrupt(localId: string): Promise<void>
  closeSession(localId: string): Promise<void>
  answerPermission(args: AnswerPermissionArgs): Promise<void>
  answerQuestion(args: AnswerQuestionArgs): Promise<void>
  listSessions(cwd: string, provider?: BackendProvider): Promise<SessionSummary[]>
  /**
   * Recent conversations as cards (title + AI description) for the new-message
   * screen. Returns immediately with cached/fallback values; any card whose
   * description is still pending must be generated lazily, on demand, via
   * {@link generateSessionSummary}.
   */
  getSessionSummaries(cwd: string, provider?: BackendProvider): Promise<SessionCard[]>
  /**
   * Lazily generate (or serve from cache) a single recent conversation's AI
   * summary — the renderer calls this only for cards it actually shows, so the
   * model isn't spent up front on conversations the user never looks at. The
   * resolved card is returned and also pushed via onSessionSummaryUpdated.
   * Resolves to null if the session is gone or a generation is already in
   * flight (the in-flight one broadcasts the result).
   */
  generateSessionSummary(
    sessionId: string,
    cwd: string,
    provider?: BackendProvider
  ): Promise<SessionCard | null>
  loadHistory(args: {
    sessionId: string
    cwd: string
    provider?: BackendProvider
  }): Promise<TranscriptItem[]>
  /** Summarize the first user message into a short title; null on failure. */
  generateTitle(firstMessage: string): Promise<string | null>
  /**
   * Regenerate a live conversation's description and cache it (keyed by SDK
   * session id) so the "pick up" cards render the up-to-date summary instantly.
   * Returns the stored {title, description}, or null on failure.
   */
  summarizeSession(
    args: SummarizeSessionArgs
  ): Promise<{ title: string; description: string } | null>
  /**
   * Most recent screenshot captured within the last few minutes, or null if
   * none. Used to offer a one-click "add screenshot to context" chip.
   */
  getRecentScreenshot(): Promise<RecentScreenshot | null>
  /** Bring the app window to the foreground (used by notification clicks). */
  focusWindow(): Promise<void>
  /** Restart the entire app (main + renderer): closes all sessions, then relaunches. */
  restartApp(): Promise<void>
  /** Subscribe to streamed session events; returns an unsubscribe fn. */
  onSessionEvent(cb: (env: SessionEventEnvelope) => void): () => void
  /** Subscribe to background-completed session cards; returns an unsubscribe fn. */
  onSessionSummaryUpdated(cb: (update: SessionCardUpdate) => void): () => void
}

export type { CcEvent, SessionStatus, TranscriptItem }
