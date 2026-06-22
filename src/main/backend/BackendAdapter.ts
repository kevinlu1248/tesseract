/**
 * BackendAdapter — the swappable transport boundary.
 *
 * The UI and SessionManager only ever talk to this interface, never to the SDK
 * directly. That makes the backend swappable: the Agent-SDK-headless adapter
 * today, a PTY-interactive adapter or a Codex adapter later, without touching
 * the renderer. This abstraction is required, not optional.
 */
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionOutboundEvent
} from '../../shared/ipc'
import type { UiImage } from '../../shared/schema'

export interface BackendStartOptions {
  cwd: string
  model?: string
  /** Resume a persisted SDK session by id. */
  resumeSessionId?: string
  /** Auto-approve every tool permission instead of prompting the user. */
  yolo?: boolean
  /**
   * A user message is queued to follow immediately, so open the session in
   * 'connecting' rather than 'idle' — avoids an idle flicker on resume-via-send.
   */
  pendingSend?: boolean
}

export interface BackendCallbacks {
  /** Every normalized event the adapter produces flows through here. */
  onEvent(event: SessionOutboundEvent): void
}

export interface BackendAdapter {
  /** Begin the session (spawns the underlying process / query). */
  start(opts: BackendStartOptions, cb: BackendCallbacks): Promise<void>
  /** Queue a user message (optionally with attached images) for the live session. */
  send(text: string, images?: UiImage[]): void
  /** Interrupt the in-flight turn. */
  interrupt(): Promise<void>
  /** Resolve a pending permission request raised via canUseTool. */
  answerPermission(requestId: string, decision: PermissionDecision): void
  /** Resolve a pending AskUserQuestion request with the user's selections. */
  answerQuestion(requestId: string, answer: QuestionAnswer): void
  /** Tear down the session and underlying process. */
  close(): Promise<void>
}
