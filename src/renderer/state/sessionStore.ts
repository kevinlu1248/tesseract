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
      return {
        ...state,
        currentAssistantId: e.messageId,
        items: [...state.items, { kind: 'message', message }]
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
    case 'load':
      return { ...initialSessionState, items: action.items, status: action.status }
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
        items: [...state.items, { kind: 'message', message }]
      }
    }
    case 'event': {
      const e = action.event
      switch (e.kind) {
        case 'cc':
          return applyCc(state, e.event)
        case 'status':
          return { ...state, status: e.status }
        case 'error':
          return { ...state, error: { message: e.message, fatal: e.fatal } }
        case 'sdk_session':
          return { ...state, sdkSessionId: e.sdkSessionId }
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
