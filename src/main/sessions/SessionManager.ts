/**
 * SessionManager — owns the per-session backend adapters and routes their
 * events to the renderer (keyed by a stable localId). Also serves session
 * listing and JSONL history reconstruction via the SDK's session APIs.
 *
 * Phase 1: each session runs in the repo's working directory. Phase 2 will give
 * each session its own git worktree here without changing the adapter or UI.
 */
import { randomUUID } from 'node:crypto'
import type {
  AnswerPermissionArgs,
  AnswerQuestionArgs,
  SendArgs,
  SessionEventEnvelope,
  SessionSummary,
  StartSessionArgs,
  BackendProvider
} from '../../shared/ipc'
import { historyToItems, type PersistedMessage, type TranscriptItem } from '../../shared/schema'
import { AgentSdkAdapter } from '../backend/AgentSdkAdapter'
import type { BackendAdapter } from '../backend/BackendAdapter'
import { CodexCliAdapter } from '../backend/CodexCliAdapter'
import { listCodexSessions, loadCodexHistory } from '../backend/codexHistory'
import { generateTitle } from '../backend/generateTitle'
import { loadSdk } from '../backend/sdk'

interface SessionRecord {
  localId: string
  adapter: BackendAdapter
  provider: BackendProvider
  cwd: string
  sdkSessionId?: string
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>()

  constructor(private readonly emit: (env: SessionEventEnvelope) => void) {}

  /** Spawn an adapter under a specific localId and wire its events to the UI. */
  private async startAdapter(
    localId: string,
    opts: {
      cwd: string
      provider?: BackendProvider
      model?: string
      resumeSessionId?: string
      yolo?: boolean
      pendingSend?: boolean
    }
  ): Promise<void> {
    const provider = opts.provider ?? 'claude'
    const adapter = provider === 'codex' ? new CodexCliAdapter() : new AgentSdkAdapter()
    const record: SessionRecord = {
      localId,
      adapter,
      provider,
      cwd: opts.cwd,
      sdkSessionId: opts.resumeSessionId
    }
    this.sessions.set(localId, record)
    await adapter.start(opts, {
      onEvent: (event) => {
        if (event.kind === 'sdk_session') record.sdkSessionId = event.sdkSessionId
        this.emit({ localId, event })
      }
    })
  }

  async start(args: StartSessionArgs): Promise<{ localId: string }> {
    const localId = randomUUID()
    await this.startAdapter(localId, {
      cwd: args.cwd,
      provider: args.provider,
      model: args.model,
      resumeSessionId: args.resumeSessionId,
      yolo: args.yolo ?? true
    })
    return { localId }
  }

  /**
   * Revive a suspended tab under its existing localId — spins a fresh subprocess
   * and resumes the prior SDK session (`--resume`). No-op if already live.
   */
  async revive(args: {
    localId: string
    cwd: string
    provider?: BackendProvider
    resumeSessionId?: string
    pendingSend?: boolean
  }): Promise<void> {
    if (this.sessions.has(args.localId)) return
    await this.startAdapter(args.localId, {
      cwd: args.cwd,
      provider: args.provider,
      resumeSessionId: args.resumeSessionId,
      yolo: true,
      pendingSend: args.pendingSend
    })
  }

  send(args: SendArgs): void {
    this.sessions.get(args.localId)?.adapter.send(args.text, args.images)
  }

  async interrupt(localId: string): Promise<void> {
    await this.sessions.get(localId)?.adapter.interrupt()
  }

  answerPermission(args: AnswerPermissionArgs): void {
    this.sessions.get(args.localId)?.adapter.answerPermission(args.requestId, args.decision)
  }

  answerQuestion(args: AnswerQuestionArgs): void {
    this.sessions.get(args.localId)?.adapter.answerQuestion(args.requestId, args.answer)
  }

  async close(localId: string): Promise<void> {
    const record = this.sessions.get(localId)
    if (!record) return
    await record.adapter.close()
    this.sessions.delete(localId)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  async listSessions(cwd: string, provider: BackendProvider = 'claude'): Promise<SessionSummary[]> {
    if (provider === 'codex') return listCodexSessions(cwd)
    const sdk = await loadSdk()
    const sessions = await sdk.listSessions({ dir: cwd, limit: 50 })
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      summary: s.summary,
      lastModified: s.lastModified,
      firstPrompt: s.firstPrompt,
      provider: 'claude'
    }))
  }

  /**
   * Summarize a conversation's first user message into a short title via a
   * throwaway one-shot model call. Returns null on failure (the caller keeps
   * its placeholder title). Stateless — no session record is involved.
   */
  generateTitle(firstMessage: string): Promise<string | null> {
    return generateTitle(firstMessage)
  }

  async loadHistory(args: {
    sessionId: string
    cwd: string
    provider?: BackendProvider
  }): Promise<TranscriptItem[]> {
    if (args.provider === 'codex') return loadCodexHistory(args)
    const sdk = await loadSdk()
    const messages = await sdk.getSessionMessages(args.sessionId, {
      dir: args.cwd,
      includeSystemMessages: false
    })
    return historyToItems(messages as unknown as PersistedMessage[])
  }
}
