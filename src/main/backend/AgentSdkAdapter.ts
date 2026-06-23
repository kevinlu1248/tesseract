/**
 * AgentSdkAdapter — drives Claude Code via the Agent SDK in streaming-input
 * mode: one long-lived query() per session, fed user messages through an async
 * queue. Consumes STRUCTURED events (includePartialMessages) and translates
 * them with SdkStreamTranslator. Never parses ANSI.
 */
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type {
  BackendAdapter,
  BackendCallbacks,
  BackendStartOptions
} from './BackendAdapter'
import type {
  PermissionDecision,
  QuestionAnswer,
  QuestionItem,
  QuestionRequest,
  SessionOutboundEvent
} from '../../shared/ipc'
import { SdkStreamTranslator, type RawSdkMessage, type UiImage } from '../../shared/schema'
import { subscriptionOnlyEnv } from '../subscriptionAuth'
import { loadSdk } from './sdk'

/** Minimal async queue exposing an AsyncIterable for streaming-input mode. */
class MessageQueue {
  private items: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private done = false

  push(item: SDKUserMessage): void {
    if (this.done) return
    const w = this.waiting.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    this.done = true
    let w: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
    while ((w = this.waiting.shift()))
      w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.done) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
}

interface PendingQuestion {
  resolve: (r: PermissionResult) => void
  request: QuestionRequest
}

/** The tool name the model uses to ask the user a multiple-choice question. */
const ASK_USER_QUESTION = 'AskUserQuestion'

/** Normalize the AskUserQuestion tool input into our QuestionRequest shape.
 *  Returns null if the input isn't a well-formed question set. */
function parseQuestions(requestId: string, input: unknown): QuestionRequest | null {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: QuestionItem[] = []
  for (const q of raw) {
    const question = typeof q?.question === 'string' ? q.question : ''
    const opts = Array.isArray(q?.options) ? q.options : []
    if (!question || opts.length === 0) continue
    questions.push({
      question,
      header: typeof q?.header === 'string' ? q.header : '',
      multiSelect: Boolean(q?.multiSelect),
      options: opts
        .filter((o: unknown) => typeof (o as { label?: unknown })?.label === 'string')
        .map((o: { label: string; description?: unknown }) => ({
          label: o.label,
          description: typeof o.description === 'string' ? o.description : undefined
        }))
    })
  }
  return questions.length ? { requestId, questions } : null
}

/** Render the user's selections as a tool result the model can act on. */
function formatAnswer(request: QuestionRequest, answer: QuestionAnswer): string {
  const lines = request.questions.map((q, i) => {
    const picks = answer.answers[i] ?? []
    const chosen = picks.length ? picks.join(', ') : '(no answer)'
    const tag = q.header ? `[${q.header}] ` : ''
    return `${tag}${q.question}\n→ ${chosen}`
  })
  return `The user answered your question(s):\n\n${lines.join('\n\n')}\n\nProceed using the user's choices above.`
}

export class AgentSdkAdapter implements BackendAdapter {
  private queue = new MessageQueue()
  private query: Query | null = null
  private translator = new SdkStreamTranslator()
  private cb: BackendCallbacks | null = null
  private pending = new Map<string, PendingPermission>()
  private pendingQuestions = new Map<string, PendingQuestion>()
  private permSeq = 0
  private closed = false
  // True between resuming a session and its first user message. During this
  // window the SDK may replay the prior transcript (emitting assistant_start
  // events), which must NOT flip the restored tab to 'running' — the prior
  // turn is already complete and the session is idle until the user sends.
  private awaitingFirstSend = false

  // True between a resume-triggered-by-send and that send actually registering.
  // The renderer is already showing the optimistic 'connecting' state, so the
  // system_init idle below must not fire and flicker the composer back to idle.
  private pendingSend = false

  // The session id we asked the SDK to resume, retained until the first
  // system_init confirms whether the resume actually continued that session.
  // A successful resume reports the SAME id back (forkSession is off); a
  // different id means the resume silently started a fresh, context-less
  // session — which we surface as `resume_failed` so the renderer can recover.
  private requestedResumeId?: string

  private emit(event: SessionOutboundEvent): void {
    this.cb?.onEvent(event)
  }

  async start(opts: BackendStartOptions, cb: BackendCallbacks): Promise<void> {
    this.cb = cb
    // A freshly opened session — new or resumed — is idle and ready for input;
    // sends are buffered by the MessageQueue until the subprocess materializes.
    // Materialization is deferred (no init/result event arrives until the first
    // message), so emitting 'starting' here would leave the tab stuck showing
    // the working dot indefinitely. Open idle; the first send flips to running.
    this.awaitingFirstSend = Boolean(opts.resumeSessionId)
    this.pendingSend = Boolean(opts.pendingSend)
    this.requestedResumeId = opts.resumeSessionId
    // A resume triggered by an outgoing message opens 'connecting' to match the
    // renderer's optimistic state — otherwise this 'idle' would land mid-resume
    // and flicker the composer back to idle before the send registers.
    this.emit({ kind: 'status', status: opts.pendingSend ? 'connecting' : 'idle' })

    const sdk = await loadSdk()

    const canUseTool: CanUseTool = (toolName, input, { signal }) => {
      // AskUserQuestion is a deliberate ask FOR the user — surface it as an
      // interactive picker even under yolo (yolo auto-approves tool *actions*,
      // not the user's own decisions). The chosen answer is fed back as the
      // tool result, so the turn continues with the user's choices.
      if (toolName === ASK_USER_QUESTION) {
        const request = parseQuestions(`q-${(this.permSeq += 1)}`, input)
        if (request) {
          return new Promise<PermissionResult>((resolve) => {
            this.pendingQuestions.set(request.requestId, { resolve, request })
            this.emit({ kind: 'status', status: 'awaiting-permission' })
            this.emit({ kind: 'question', request })
            signal.addEventListener('abort', () => {
              if (this.pendingQuestions.delete(request.requestId))
                resolve({ behavior: 'deny', message: 'Interrupted' })
            })
          })
        }
        // Malformed question set — fall through to normal handling below.
      }
      // Yolo mode: never block the turn — approve with the input unchanged.
      if (opts.yolo) return Promise.resolve({ behavior: 'allow', updatedInput: input })
      return new Promise<PermissionResult>((resolve) => {
        const requestId = `perm-${(this.permSeq += 1)}`
        this.pending.set(requestId, { resolve, input })
        this.emit({ kind: 'status', status: 'awaiting-permission' })
        this.emit({ kind: 'permission', request: { requestId, toolName, input } })
        signal.addEventListener('abort', () => {
          if (this.pending.delete(requestId))
            resolve({ behavior: 'deny', message: 'Interrupted' })
        })
      })
    }

    const options: Options = {
      cwd: opts.cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      canUseTool,
      // Subscription-only: the subprocess env is REPLACED (not merged), so we
      // hand it a copy of process.env with every API-billing vector removed.
      // The only auth path left is the logged-in `claude` CLI subscription.
      env: subscriptionOnlyEnv(),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {})
    }

    try {
      this.query = sdk.query({ prompt: this.queue, options })
    } catch (err) {
      this.fail(err)
      return
    }

    // Drive the stream in the background; surface any failure to the UI.
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (!this.query) return
    try {
      for await (const message of this.query as AsyncIterable<SDKMessage>) {
        this.onMessage(message as unknown as RawSdkMessage)
      }
      if (!this.closed) this.emit({ kind: 'status', status: 'exited' })
    } catch (err) {
      this.fail(err)
    }
  }

  private onMessage(message: RawSdkMessage): void {
    if (process.env.CCW_DEBUG_RAW) {
      const m = message as RawSdkMessage & {
        parent_tool_use_id?: unknown
        event?: { type?: string; parent_tool_use_id?: unknown }
        message?: { content?: unknown }
      }
      const content = (m.message?.content ?? m.event) as unknown
      const blocks = Array.isArray(content)
        ? content.map((b) => (b as { type?: string }).type)
        : typeof content === 'object' && content
          ? (content as { type?: string }).type
          : undefined
      // eslint-disable-next-line no-console
      console.error(
        '[RAW]',
        m.type,
        'parent_tool_use_id=',
        JSON.stringify(m.parent_tool_use_id ?? m.event?.parent_tool_use_id ?? null),
        'blocks=',
        JSON.stringify(blocks)
      )
    }
    const events = this.translator.handle(message, Date.now())
    for (const event of events) {
      this.emit({ kind: 'cc', event })
      if (event.type === 'system_init') {
        if (event.sessionId) {
          this.emit({ kind: 'sdk_session', sdkSessionId: event.sessionId })
          // First init after a resume request: did the resume actually continue
          // the session? A matching id means yes; a different id means the SDK
          // started fresh and the prior transcript is NOT in context. Either way
          // this check is one-shot — clear the requested id so later inits (e.g.
          // after a compaction) never re-trigger it.
          if (this.requestedResumeId) {
            const requested = this.requestedResumeId
            this.requestedResumeId = undefined
            if (event.sessionId !== requested)
              this.emit({
                kind: 'resume_failed',
                requestedSessionId: requested,
                newSessionId: event.sessionId
              })
          }
        }
        // The SDK has booted and is waiting for input — the session is ready,
        // not working. Report idle so a fresh tab stops showing the "running"
        // dot and the first user message sends immediately instead of queuing.
        // BUT a new session only materializes (firing system_init) *after* its
        // first send, so emitting idle here would stomp the optimistic
        // 'connecting' state back to "Ready" until the model streams. Only
        // report idle while genuinely waiting for the first live send (a resume
        // replaying its transcript) and no send is already in flight.
        if (this.awaitingFirstSend && !this.pendingSend)
          this.emit({ kind: 'status', status: 'idle' })
      }
      if (event.type === 'result') this.emit({ kind: 'status', status: 'idle' })
      // Ignore assistant_start while replaying a resumed transcript before the
      // first send — those are historical turns, not live work.
      if (event.type === 'assistant_start' && !this.awaitingFirstSend)
        this.emit({ kind: 'status', status: 'running' })
    }
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const fatal = !isInterrupt(message)
    this.emit({ kind: 'error', message: describeError(message), fatal })
    this.emit({ kind: 'status', status: fatal ? 'error' : 'interrupted' })
  }

  send(text: string, images?: UiImage[]): void {
    if (this.closed) return
    // The user is driving the session now: real work follows, so subsequent
    // assistant_start events are live and should report 'running'.
    this.awaitingFirstSend = false
    this.pendingSend = false
    // With attachments the message becomes structured content blocks (images
    // first, then the text); plain text stays a bare string. The Anthropic
    // media_type is a string-literal union — our UiImage carries a plain string,
    // so the cast narrows it without changing the value.
    const content =
      images && images.length
        ? [
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType as 'image/png',
                data: img.data
              }
            })),
            ...(text ? [{ type: 'text' as const, text }] : [])
          ]
        : text
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null
    }
    // Not 'running' yet — the SDK has to spin up the turn before the model
    // streams anything. The assistant_start handler flips this to 'running'
    // once real output begins, giving a "connecting…" → "working…" progression.
    this.emit({ kind: 'status', status: 'connecting' })
    this.queue.push(userMessage)
  }

  async interrupt(): Promise<void> {
    try {
      await this.query?.interrupt()
      this.emit({ kind: 'status', status: 'interrupted' })
    } catch {
      /* interrupt is best-effort */
    }
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (decision.behavior === 'allow') {
      p.resolve({ behavior: 'allow', updatedInput: p.input })
    } else {
      p.resolve({ behavior: 'deny', message: decision.message ?? 'Denied by user' })
    }
    this.emit({ kind: 'permission_resolved', requestId })
    this.emit({ kind: 'status', status: 'running' })
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): void {
    const q = this.pendingQuestions.get(requestId)
    if (!q) return
    this.pendingQuestions.delete(requestId)
    // Resolve as a deny whose message carries the user's selections — the SDK
    // feeds that back as the tool result, so the model continues the turn with
    // the answer rather than executing AskUserQuestion itself.
    q.resolve({ behavior: 'deny', message: formatAnswer(q.request, answer) })
    this.emit({ kind: 'question_resolved', requestId })
    this.emit({ kind: 'status', status: 'running' })
  }

  async close(): Promise<void> {
    this.closed = true
    // Reject any outstanding permission prompts so the query can unwind.
    for (const [, p] of this.pending)
      p.resolve({ behavior: 'deny', message: 'Session closed' })
    this.pending.clear()
    // Same for any unanswered questions.
    for (const [, q] of this.pendingQuestions)
      q.resolve({ behavior: 'deny', message: 'Session closed' })
    this.pendingQuestions.clear()
    this.queue.end()
    try {
      this.query?.close?.()
    } catch {
      /* ignore */
    }
  }
}

function isInterrupt(message: string): boolean {
  return /interrupt|abort|cancell?ed/i.test(message)
}

/** Map common failure modes to actionable messages (never hang silently). */
function describeError(message: string): string {
  if (/rate.?limit|429|too many requests/i.test(message))
    return `Rate limited by Anthropic. ${message}`
  if (/credit|quota|insufficient|payment|billing/i.test(message))
    return `Subscription/credit limit reached. ${message}`
  if (/401|403|unauthor|auth|login|expired/i.test(message))
    return `Authentication problem — your Claude login may have expired. Run \`claude\` in a terminal to re-auth. (${message})`
  if (/ENOENT|spawn|not found|executable/i.test(message))
    return `Could not launch the Claude Code executable. Is the \`claude\` CLI installed? (${message})`
  return message
}
