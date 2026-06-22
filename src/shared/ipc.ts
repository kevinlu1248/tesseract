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
  sessionRevive: 'session:revive',
  sessionSend: 'session:send',
  sessionInterrupt: 'session:interrupt',
  sessionClose: 'session:close',
  permissionAnswer: 'permission:answer',
  questionAnswer: 'question:answer',
  sessionList: 'session:list',
  sessionLoadHistory: 'session:load-history',
  sessionGenerateTitle: 'session:generate-title',
  /** Look up the most recently captured screenshot (for the "add to context" chip). */
  screenshotRecent: 'screenshot:recent',
  /** Bring the app window to the foreground (e.g. from a notification click). */
  windowFocus: 'window:focus',
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

/* ─────────────────── The surface exposed on window.api ───────────────── */

export interface WorkspaceApi {
  getAuth(): Promise<AuthInfo>
  pickRepo(): Promise<string | null>
  startSession(args: StartSessionArgs): Promise<{ localId: string }>
  /** Resume a suspended tab's session under its existing localId (--resume). */
  reviveSession(args: ReviveSessionArgs): Promise<void>
  send(args: SendArgs): Promise<void>
  interrupt(localId: string): Promise<void>
  closeSession(localId: string): Promise<void>
  answerPermission(args: AnswerPermissionArgs): Promise<void>
  answerQuestion(args: AnswerQuestionArgs): Promise<void>
  listSessions(cwd: string, provider?: BackendProvider): Promise<SessionSummary[]>
  loadHistory(args: {
    sessionId: string
    cwd: string
    provider?: BackendProvider
  }): Promise<TranscriptItem[]>
  /** Summarize the first user message into a short title; null on failure. */
  generateTitle(firstMessage: string): Promise<string | null>
  /**
   * Most recent screenshot captured within the last few minutes, or null if
   * none. Used to offer a one-click "add screenshot to context" chip.
   */
  getRecentScreenshot(): Promise<RecentScreenshot | null>
  /** Bring the app window to the foreground (used by notification clicks). */
  focusWindow(): Promise<void>
  /** Subscribe to streamed session events; returns an unsubscribe fn. */
  onSessionEvent(cb: (env: SessionEventEnvelope) => void): () => void
}

export type { CcEvent, SessionStatus, TranscriptItem }
