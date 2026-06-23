/**
 * Renderer-side reducer: folds the normalized CcEvent / lifecycle stream into
 * the transcript view model. This is the only place stream events mutate state.
 */
import type {
  PermissionRequest,
  QuestionRequest,
  SessionOutboundEvent,
  SessionStatus
} from '../../shared/ipc'
import type {
  CcEvent,
  TranscriptItem,
  UiBlock,
  UiImage,
  UiMessage,
  UiToolUseBlock
} from '../../shared/schema'

export interface SessionState {
  items: TranscriptItem[]
  status: SessionStatus
  permissions: PermissionRequest[]
  /** Pending AskUserQuestion prompts awaiting the user's selection. */
  questions: QuestionRequest[]
  sdkSessionId?: string
  model?: string
  cwd?: string
  error?: { message: string; fatal: boolean }
  /**
   * True when a resume silently lost this conversation's context (the SDK
   * started a fresh session instead of continuing the prior one). Drives the
   * "memory not restored" banner; cleared once the transcript is re-fed into
   * the new session (or the user dismisses it).
   */
  contextLost?: boolean
  currentAssistantId?: string
  /** Tokens in the prompt last sent to the model (the live context-window fill). */
  contextTokens?: number
}

export const initialSessionState: SessionState = {
  items: [],
  status: 'starting',
  permissions: [],
  questions: []
}

export type SessionAction =
  | { t: 'event'; event: SessionOutboundEvent }
  | { t: 'user'; id: string; text: string; images?: UiImage[] }
  | { t: 'load'; items: TranscriptItem[]; status: SessionStatus }
  | { t: 'clearError' }
  /** Dismiss the "context not restored" banner (manual, or once re-fed). */
  | { t: 'clearContextLost' }
  /** Wipe the transcript back to a blank conversation, keeping cwd/model. */
  | { t: 'clear' }
  /**
   * Rewind the transcript: drop the item at `index` and everything after it
   * (the user message being edited and all subsequent turns), settling any
   * live-turn state. The edited message is re-appended separately via 'user'.
   */
  | { t: 'rewind'; index: number }

function mapMessage(
  items: TranscriptItem[],
  messageId: string,
  fn: (m: UiMessage) => UiMessage
): TranscriptItem[] {
  return items.map((it) =>
    it.kind === 'message' && it.message.id === messageId
      ? { kind: 'message', message: fn(it.message) }
      : it
  )
}

function mapBlock(
  items: TranscriptItem[],
  blockId: string,
  fn: (b: UiBlock) => UiBlock
): TranscriptItem[] {
  return items.map((it) => {
    if (it.kind !== 'message') return it
    if (!it.message.blocks.some((b) => b.id === blockId)) return it
    return {
      kind: 'message',
      message: {
        ...it.message,
        blocks: it.message.blocks.map((b) => (b.id === blockId ? fn(b) : b))
      }
    }
  })
}

/**
 * Settle a turn that's ending or being superseded. An interrupted or
 * superseded turn (the user sends a new message mid-stream, the interrupt
 * button is hit, or the backend reports idle/interrupted/error) never delivers
 * the trailing `block_stop` / `tool_result` events, so its tool and thinking
 * blocks would keep their spinners forever. Mark every still-streaming block
 * done, synthesize an "interrupted" result for any tool call that never got one
 * (so the tool/subagent card stops spinning — covers nested subagent steps
 * too), and drop assistant messages that never produced a block (their bare
 * "thinking…" placeholder would otherwise linger). Returns the original array
 * unchanged when there's nothing to settle, so the common (already-settled)
 * path is identity-stable and doesn't churn React.
 */
function settleStreaming(items: TranscriptItem[]): TranscriptItem[] {
  const haveResult = new Set<string>()
  for (const it of items)
    if (it.kind === 'tool_result' && it.result.toolUseId) haveResult.add(it.result.toolUseId)

  const synthesized: TranscriptItem[] = []
  let dirty = false

  const settled = items
    .filter((it) => {
      const empty =
        it.kind === 'message' &&
        it.message.role === 'assistant' &&
        it.message.blocks.length === 0
      if (empty) dirty = true
      return !empty
    })
    .map((it) => {
      if (it.kind !== 'message') return it
      let changed = false
      const blocks = it.message.blocks.map((b) => {
        let nb = b
        if ((nb.kind === 'tool_use' || nb.kind === 'thinking') && !nb.done) {
          nb = { ...nb, done: true }
          changed = true
        }
        if (nb.kind === 'tool_use') {
          if (nb.nested?.some((n) => !n.result)) {
            nb = {
              ...nb,
              nested: nb.nested.map((n) =>
                n.result
                  ? n
                  : {
                      ...n,
                      result: {
                        toolUseId: n.toolUseId,
                        text: 'Interrupted',
                        isError: false,
                        parentToolUseId: (nb as UiToolUseBlock).toolUseId
                      }
                    }
              )
            }
            changed = true
          }
          const tuid = (nb as UiToolUseBlock).toolUseId
          if (!haveResult.has(tuid)) {
            haveResult.add(tuid)
            synthesized.push({
              kind: 'tool_result',
              result: { toolUseId: tuid, text: 'Interrupted', isError: false }
            })
          }
        }
        return nb
      })
      if (!changed) return it
      return { kind: 'message' as const, message: { ...it.message, blocks } }
    })

  if (synthesized.length) dirty = true
  if (!dirty) return items
  return [...settled, ...synthesized]
}

/** Map the (unique) tool_use block whose toolUseId matches — used to fold a
 *  subagent's nested calls/results into its parent Task/Agent block. */
function mapToolUseBlock(
  items: TranscriptItem[],
  toolUseId: string,
  fn: (b: UiToolUseBlock) => UiToolUseBlock
): TranscriptItem[] {
  return items.map((it) => {
    if (it.kind !== 'message') return it
    if (!it.message.blocks.some((b) => b.kind === 'tool_use' && b.toolUseId === toolUseId))
      return it
    return {
      kind: 'message',
      message: {
        ...it.message,
        blocks: it.message.blocks.map((b) =>
          b.kind === 'tool_use' && b.toolUseId === toolUseId ? fn(b) : b
        )
      }
    }
  })
}

function applyCc(state: SessionState, e: CcEvent): SessionState {
  switch (e.type) {
    case 'system_init':
      return {
        ...state,
        model: e.model ?? state.model,
        cwd: e.cwd ?? state.cwd,
        sdkSessionId: e.sessionId || state.sdkSessionId
      }
    case 'assistant_start': {
      const message: UiMessage = { id: e.messageId, role: 'assistant', blocks: [], ts: e.ts }
      // A new turn supersedes any prior one — settle its dangling spinners
      // before appending the fresh (empty) assistant message.
      return {
        ...state,
        currentAssistantId: e.messageId,
        items: [...settleStreaming(state.items), { kind: 'message', message }]
      }
    }
    case 'block_start': {
      let block: UiBlock
      if (e.kind === 'tool_use')
        block = {
          kind: 'tool_use',
          id: e.blockId,
          toolUseId: e.toolUseId ?? e.blockId,
          name: e.toolName ?? 'tool',
          inputJson: '',
          done: false
        }
      else if (e.kind === 'thinking')
        block = { kind: 'thinking', id: e.blockId, text: '', done: false }
      else block = { kind: 'text', id: e.blockId, text: '' }
      return {
        ...state,
        items: mapMessage(state.items, e.messageId, (m) => ({
          ...m,
          blocks: [...m.blocks, block]
        }))
      }
    }
    case 'text_delta':
      return {
        ...state,
        items: mapBlock(state.items, e.blockId, (b) =>
          b.kind === 'text' ? { ...b, text: b.text + e.text } : b
        )
      }
    case 'thinking_delta':
      return {
        ...state,
        items: mapBlock(state.items, e.blockId, (b) =>
          b.kind === 'thinking' ? { ...b, text: b.text + e.text } : b
        )
      }
    case 'tool_input_delta':
      return {
        ...state,
        items: mapBlock(state.items, e.blockId, (b) =>
          b.kind === 'tool_use' ? { ...b, inputJson: b.inputJson + e.partialJson } : b
        )
      }
    case 'block_stop':
      return {
        ...state,
        items: mapBlock(state.items, e.blockId, (b) =>
          b.kind === 'tool_use' || b.kind === 'thinking' ? { ...b, done: true } : b
        )
      }
    case 'nested_tool_use':
      // A subagent's internal tool call — append it to the parent Task/Agent
      // block's activity list rather than the top-level transcript.
      return {
        ...state,
        items: mapToolUseBlock(state.items, e.parentToolUseId, (b) => ({
          ...b,
          nested: [
            ...(b.nested ?? []),
            { toolUseId: e.toolUseId, name: e.name, inputJson: e.inputJson }
          ]
        }))
      }
    case 'tool_result': {
      const parent = e.result.parentToolUseId
      // A nested (subagent) result folds into its parent's activity list, pairing
      // with the matching call. It never appears as a standalone top-level item.
      if (parent) {
        return {
          ...state,
          items: mapToolUseBlock(state.items, parent, (b) => {
            const nested = b.nested ?? []
            const i = nested.findIndex((n) => n.toolUseId === e.result.toolUseId && !n.result)
            const next =
              i >= 0
                ? nested.map((n, j) => (j === i ? { ...n, result: e.result } : n))
                : [
                    ...nested,
                    {
                      toolUseId: e.result.toolUseId,
                      name: 'tool',
                      inputJson: '',
                      result: e.result
                    }
                  ]
            return { ...b, nested: next }
          })
        }
      }
      return {
        ...state,
        items: [...state.items, { kind: 'tool_result', result: e.result }]
      }
    }
    case 'context':
      return { ...state, contextTokens: e.tokens }
    case 'assistant_stop':
    case 'result':
      return state
  }
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.t) {
    case 'clearError':
      return { ...state, error: undefined }
    case 'clearContextLost':
      return { ...state, contextLost: false }
    case 'clear':
      // Drop the whole transcript (and any pending prompts / live-turn state)
      // back to a blank, idle conversation. cwd/model are preserved so the
      // status bar stays populated until the fresh session re-reports them.
      return { ...initialSessionState, status: 'idle', cwd: state.cwd, model: state.model }
    case 'load':
      return { ...initialSessionState, items: action.items, status: action.status }
    case 'rewind':
      // Truncate to everything before the edited message and clear transient
      // turn state (pending prompts, the in-flight assistant id, banners). The
      // session is rebased onto a forked/fresh backend that resumes on the next
      // send, so it sits idle until then.
      return {
        ...state,
        items: state.items.slice(0, action.index),
        status: 'idle',
        permissions: [],
        questions: [],
        error: undefined,
        contextLost: false,
        currentAssistantId: undefined
      }
    case 'user': {
      const blocks: UiBlock[] = (action.images ?? []).map((image, i) => ({
        kind: 'image',
        id: `${action.id}#img${i}`,
        image
      }))
      if (action.text) blocks.push({ kind: 'text', id: `${action.id}#0`, text: action.text })
      const message: UiMessage = {
        id: action.id,
        role: 'user',
        blocks,
        ts: Date.now()
      }
      return {
        ...state,
        // Optimistic: the turn is being established. The backend confirms with
        // 'connecting', then flips to 'running' once the model starts streaming.
        status: 'connecting',
        // Sending a new message ends whatever turn was in flight — settle any
        // spinners left behind by an interrupted/superseded turn so they don't
        // keep spinning above the new message.
        items: [...settleStreaming(state.items), { kind: 'message', message }]
      }
    }
    case 'event': {
      const e = action.event
      switch (e.kind) {
        case 'cc':
          return applyCc(state, e.event)
        case 'status': {
          // When the turn is no longer actively streaming, settle any blocks
          // the stream left mid-flight (an interrupt or error skips their
          // trailing block_stop / tool_result events).
          const settledStatuses: SessionStatus[] = ['idle', 'interrupted', 'error', 'exited']
          const items = settledStatuses.includes(e.status)
            ? settleStreaming(state.items)
            : state.items
          return { ...state, status: e.status, items }
        }
        case 'error':
          return { ...state, error: { message: e.message, fatal: e.fatal } }
        case 'sdk_session':
          return { ...state, sdkSessionId: e.sdkSessionId }
        case 'resume_failed':
          // The resume started a fresh session — the transcript shown above is
          // NOT in the model's context. Flag it so the UI warns and the next
          // send re-feeds the prior history.
          return { ...state, contextLost: true }
        case 'permission':
          return { ...state, permissions: [...state.permissions, e.request] }
        case 'permission_resolved':
          return {
            ...state,
            permissions: state.permissions.filter((p) => p.requestId !== e.requestId)
          }
        case 'question':
          return { ...state, questions: [...state.questions, e.request] }
        case 'question_resolved':
          return {
            ...state,
            questions: state.questions.filter((q) => q.requestId !== e.requestId)
          }
      }
    }
  }
}
