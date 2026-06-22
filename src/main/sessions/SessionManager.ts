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
  SessionCard,
  SessionCardUpdate,
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
import { generateSummary } from '../backend/generateSummary'
import { generateTitle } from '../backend/generateTitle'
import { loadSdk } from '../backend/sdk'
import { SummaryCache } from './summaryCache'

/** How many recent conversations the new-message screen shows as cards. */
const MAX_CARDS = 6

/** Collapse a raw summary/prompt into a single-line snippet title fallback. */
function snippet(s: SessionSummary, max = 60): string {
  const text = (s.firstPrompt || s.summary || s.sessionId).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

interface SessionRecord {
  localId: string
  adapter: BackendAdapter
  provider: BackendProvider
  cwd: string
  sdkSessionId?: string
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>()
  private summaryCache = new SummaryCache()
  /** Session ids whose summary is currently being generated (de-dupes work). */
  private generating = new Set<string>()

  constructor(
    private readonly emit: (env: SessionEventEnvelope) => void,
    /** Push a background-completed card to the renderer (optional in tests). */
    private readonly emitSummary?: (update: SessionCardUpdate) => void
  ) {}

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

  /**
   * Regenerate a live conversation's AI description from its latest state and
   * cache it (keyed by SDK session id), so the "pick up where you left off"
   * cards are already warm. Called on every task completion: the title is taken
   * from the tab (kept stable across turns) and only the description is
   * refreshed. The cache is tagged with the conversation's current lastModified
   * so a later getSessionSummaries() lookup hits it instead of regenerating, and
   * the result is broadcast so any open new-session screen patches live.
   *
   * Returns the stored {title, description}, or null if generation failed (the
   * caller keeps whatever it had).
   */
  async summarizeSession(args: {
    sessionId: string
    cwd: string
    provider?: BackendProvider
    title: string
    firstPrompt: string
    latestState: string
  }): Promise<{ title: string; description: string } | null> {
    const provider = args.provider ?? 'claude'
    const generated = await generateSummary(args.firstPrompt, args.latestState)
    if (!generated) return null
    // Keep the tab's existing title; only the description is regenerated. Fall
    // back to the generated title if the tab never got a real one.
    const title = args.title.trim() || generated.title
    const description = generated.description
    // Tag the cache entry with the conversation's current mtime so a later
    // getSessionSummaries() considers it fresh (exact-match) and skips work.
    const sessions = await this.listSessions(args.cwd, provider)
    const match = sessions.find((s) => s.sessionId === args.sessionId)
    const lastModified = match?.lastModified ?? Date.now()
    await this.summaryCache.set(args.sessionId, { title, description, lastModified })
    this.emitSummary?.({
      cwd: args.cwd,
      provider,
      card: {
        sessionId: args.sessionId,
        title,
        description,
        lastModified,
        firstPrompt: args.firstPrompt,
        provider,
        pending: false
      }
    })
    return { title, description }
  }

  /**
   * Recent conversations as cards for the new-message screen. Returns
   * immediately with cached AI summaries where available and snippet fallbacks
   * elsewhere. Cards missing their AI summary come back with `pending: true`;
   * the renderer requests generation lazily (only for cards it actually shows)
   * via {@link generateSessionSummary} rather than this method eagerly
   * spending model calls on every recent conversation up front.
   */
  async getSessionSummaries(
    cwd: string,
    provider: BackendProvider = 'claude'
  ): Promise<SessionCard[]> {
    const summaries = (await this.listSessions(cwd, provider)).slice(0, MAX_CARDS)
    const cards: SessionCard[] = []
    for (const s of summaries) {
      const cached = await this.summaryCache.getFresh(s.sessionId, s.lastModified)
      cards.push({
        sessionId: s.sessionId,
        title: cached ? cached.title : snippet(s),
        description: cached ? cached.description : null,
        lastModified: s.lastModified,
        firstPrompt: s.firstPrompt,
        provider,
        pending: !cached
      })
    }
    return cards
  }

  /**
   * Lazily generate (or serve from cache) a single recent conversation's AI
   * summary, on demand — the renderer calls this only for cards it actually
   * displays. Returns the resolved card and broadcasts it via {@link emitSummary}
   * so any open new-session screen patches in place. De-dupes concurrent
   * requests for the same session id and returns null if the session is no
   * longer listed.
   */
  async generateSessionSummary(
    cwd: string,
    provider: BackendProvider = 'claude',
    sessionId: string
  ): Promise<SessionCard | null> {
    const summaries = await this.listSessions(cwd, provider)
    const s = summaries.find((it) => it.sessionId === sessionId)
    if (!s) return null

    // Serve a fresh cache hit without spending a model call.
    const cached = await this.summaryCache.getFresh(s.sessionId, s.lastModified)
    if (cached) {
      return {
        sessionId: s.sessionId,
        title: cached.title,
        description: cached.description,
        lastModified: s.lastModified,
        firstPrompt: s.firstPrompt,
        provider,
        pending: false
      }
    }

    // De-dupe: if a generation for this session is already in flight, skip —
    // the in-flight one will broadcast the result to every listener.
    if (this.generating.has(s.sessionId)) return null
    this.generating.add(s.sessionId)
    try {
      const result = await generateSummary(s.firstPrompt ?? '', s.summary ?? '')
      if (result) {
        await this.summaryCache.set(s.sessionId, {
          title: result.title,
          description: result.description,
          lastModified: s.lastModified
        })
      }
      const card: SessionCard = {
        sessionId: s.sessionId,
        title: result ? result.title : snippet(s),
        description: result ? result.description : null,
        lastModified: s.lastModified,
        firstPrompt: s.firstPrompt,
        provider,
        pending: false
      }
      this.emitSummary?.({ cwd, provider, card })
      return card
    } finally {
      this.generating.delete(s.sessionId)
    }
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
