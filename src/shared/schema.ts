/**
 * THE schema module. Every piece of knowledge about the Claude Agent SDK's
 * streamed message shape lives here. If the SDK schema drifts between releases,
 * this is the single file to fix.
 *
 * Two layers:
 *   1. Loose "raw" types mirroring what the SDK emits (kept permissive on
 *      purpose — the SDK shape changes, so we never over-constrain).
 *   2. Normalized "Cc*" types our app actually renders. The renderer never sees
 *      a raw SDK message; it only consumes CcEvent.
 *
 * `SdkStreamTranslator` is the stateful bridge: feed it raw SDK messages, it
 * emits the normalized CcEvent stream by reconstructing assistant messages from
 * partial stream events (no ANSI, no terminal — pure structured data).
 */

/* ─────────────────────────── Raw SDK shapes ─────────────────────────── */

export interface RawSystemMessage {
  type: 'system'
  subtype?: string
  session_id?: string
  model?: string
  cwd?: string
  tools?: string[]
  data?: Record<string, unknown>
}

export interface RawAssistantMessage {
  type: 'assistant'
  message?: { id?: string; content?: RawContentBlock[]; model?: string }
  session_id?: string
  /** Set when this assistant turn is a subagent's internal work (delegated by
   *  a Task/Agent tool call). null/absent for the main agent. */
  parent_tool_use_id?: string | null
}

export interface RawUserMessage {
  type: 'user'
  message?: { role?: string; content?: RawContentBlock[] | string }
  session_id?: string
  /** Set when this carries a subagent's internal tool result. */
  parent_tool_use_id?: string | null
}

export interface RawResultMessage {
  type: 'result'
  subtype?: string
  result?: string
  session_id?: string
  total_cost_usd?: number
  is_error?: boolean
  raw_usage?: { input_tokens?: number; output_tokens?: number }
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface RawStreamEventMessage {
  type: 'stream_event'
  event: RawStreamEvent
  session_id?: string
  uuid?: string
  parent_tool_use_id?: string | null
}

export type RawContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | {
      type: 'tool_result'
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }
  | { type: 'image'; source?: { type?: string; media_type?: string; data?: string } }

export interface RawStreamEvent {
  type: string // message_start | content_block_start | content_block_delta | content_block_stop | message_delta | message_stop
  index?: number
  message?: {
    id?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  content_block?: {
    type?: string
    id?: string
    name?: string
    input?: unknown
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
}

export type RawSdkMessage =
  | RawSystemMessage
  | RawAssistantMessage
  | RawUserMessage
  | RawResultMessage
  | RawStreamEventMessage
  | { type: string; [k: string]: unknown }

/* ─────────────────────── Normalized view model ──────────────────────── */

export type BlockKind = 'text' | 'thinking' | 'tool_use' | 'image'

export interface UiTextBlock {
  kind: 'text'
  id: string
  text: string
}
export interface UiThinkingBlock {
  kind: 'thinking'
  id: string
  text: string
  /** False while the model is still streaming this thinking block. */
  done: boolean
}
export interface UiToolUseBlock {
  kind: 'tool_use'
  id: string
  toolUseId: string
  name: string
  /** Raw streamed JSON fragment, parsed lazily for display. */
  inputJson: string
  done: boolean
  /** For a subagent (Task/Agent) call: the subagent's internal tool calls and
   *  their results, captured so they render nested inside the SubagentCard
   *  instead of flooding the top-level transcript as orphan results. */
  nested?: UiNestedActivity[]
}

/** One step of a subagent's internal work: a tool call and (once it arrives)
 *  its result. Grouped under the parent Task/Agent block. */
export interface UiNestedActivity {
  toolUseId: string
  name: string
  /** Raw JSON input for the nested tool call. */
  inputJson: string
  result?: UiToolResult
}
/** An image attached to a message (e.g. a user-pasted screenshot). */
export interface UiImageBlock {
  kind: 'image'
  id: string
  image: UiImage
}
export type UiBlock = UiTextBlock | UiThinkingBlock | UiToolUseBlock | UiImageBlock

export interface UiMessage {
  id: string
  role: 'assistant' | 'user' | 'system'
  blocks: UiBlock[]
  ts: number
}

export interface UiImage {
  /** e.g. "image/png" */
  mediaType: string
  /** base64-encoded image bytes */
  data: string
}

export interface UiToolResult {
  toolUseId: string
  /** Already flattened to a display string. */
  text: string
  isError: boolean
  /** Images returned by the tool (e.g. screenshots), if any. */
  images?: UiImage[]
  /** Set when this result belongs to a subagent's internal tool call — the
   *  Task/Agent tool-use id that owns it. Such results are grouped under that
   *  subagent rather than rendered as a standalone top-level result. */
  parentToolUseId?: string
}

/** A linear transcript entry — what the renderer keeps in order of arrival. */
export type TranscriptItem =
  | { kind: 'message'; message: UiMessage }
  | { kind: 'tool_result'; result: UiToolResult }

/* ──────────────────────── Normalized event stream ───────────────────── */

export type SessionStatus =
  | 'starting'
  | 'idle'
  // Message sent; the SDK is spinning up the turn but the model hasn't begun
  // streaming yet. Flips to 'running' on the first live assistant_start.
  | 'connecting'
  | 'running'
  | 'awaiting-permission'
  | 'interrupted'
  | 'error'
  | 'exited'
  // Backend subprocess intentionally killed to free resources (idle too long or
  // archived). The transcript is kept; the session resumes via --resume on use.
  | 'suspended'

export type CcEvent =
  | {
      type: 'system_init'
      sessionId: string
      model?: string
      cwd?: string
      tools?: string[]
    }
  | { type: 'assistant_start'; messageId: string; ts: number }
  | {
      type: 'block_start'
      messageId: string
      blockId: string
      kind: BlockKind
      toolName?: string
      toolUseId?: string
    }
  | { type: 'text_delta'; blockId: string; text: string }
  | { type: 'thinking_delta'; blockId: string; text: string }
  | { type: 'tool_input_delta'; blockId: string; partialJson: string }
  | { type: 'block_stop'; blockId: string }
  | { type: 'assistant_stop'; messageId: string }
  | { type: 'tool_result'; result: UiToolResult }
  // A subagent's internal tool call, captured from its (otherwise ignored)
  // nested assistant turn so it can render grouped under the Task/Agent block.
  | {
      type: 'nested_tool_use'
      parentToolUseId: string
      toolUseId: string
      name: string
      inputJson: string
    }
  | {
      type: 'result'
      subtype?: string
      costUsd?: number
      inputTokens?: number
      outputTokens?: number
    }
  // Emitted at the start of each assistant turn: the size of the prompt that was
  // actually sent to the model (uncached input + cache read + cache creation).
  // This is the live "how full is the context window" signal.
  | { type: 'context'; tokens: number }

/* ───────────────────────────── Translator ───────────────────────────── */

function extractImage(obj: Record<string, unknown>): UiImage | null {
  if (obj.type !== 'image') return null
  const src = obj.source as Record<string, unknown> | undefined
  if (src && typeof src.data === 'string') {
    return {
      mediaType: typeof src.media_type === 'string' ? src.media_type : 'image/png',
      data: src.data
    }
  }
  return null
}

function flattenContent(content: unknown): {
  text: string
  isError: boolean
  images: UiImage[]
} {
  if (typeof content === 'string') return { text: content, isError: false, images: [] }
  if (Array.isArray(content)) {
    const parts: string[] = []
    const images: UiImage[] = []
    for (const c of content) {
      if (typeof c === 'string') parts.push(c)
      else if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>
        const img = extractImage(obj)
        if (img) images.push(img)
        else if (typeof obj.text === 'string') parts.push(obj.text)
        else parts.push(JSON.stringify(obj))
      }
    }
    return { text: parts.join('\n'), isError: false, images }
  }
  if (content == null) return { text: '', isError: false, images: [] }
  return { text: JSON.stringify(content), isError: false, images: [] }
}

/**
 * Stateful: tracks the current assistant message id so content-block deltas
 * (which carry only an index) can be tied to a stable, unique blockId.
 */
export class SdkStreamTranslator {
  private currentMessageId: string | null = null
  private seq = 0

  private blockId(index: number): string {
    return `${this.currentMessageId ?? 'msg'}#${index}`
  }

  handle(msg: RawSdkMessage, nowTs: number): CcEvent[] {
    switch (msg.type) {
      case 'system':
        return this.handleSystem(msg as RawSystemMessage)
      case 'stream_event':
        return this.handleStream((msg as RawStreamEventMessage).event, nowTs)
      case 'user':
        return this.handleUser(msg as RawUserMessage)
      case 'result':
        return this.handleResult(msg as RawResultMessage)
      // Full 'assistant' messages from the MAIN agent are intentionally ignored:
      // its content is reconstructed from stream_event deltas for smooth token
      // rendering. A subagent's nested turns, however, arrive ONLY as full
      // assistant messages (parent_tool_use_id set) with no stream deltas — so
      // we mine those for the subagent's internal tool calls.
      case 'assistant': {
        const am = msg as RawAssistantMessage
        return am.parent_tool_use_id ? this.handleNestedAssistant(am, am.parent_tool_use_id) : []
      }
      default:
        return []
    }
  }

  private handleSystem(msg: RawSystemMessage): CcEvent[] {
    if (msg.subtype && msg.subtype !== 'init') return []
    return [
      {
        type: 'system_init',
        sessionId: msg.session_id ?? '',
        model: msg.model ?? (msg.data?.model as string | undefined),
        cwd: msg.cwd ?? (msg.data?.cwd as string | undefined),
        tools: msg.tools
      }
    ]
  }

  private handleUser(msg: RawUserMessage): CcEvent[] {
    const content = msg.message?.content
    if (!Array.isArray(content)) return []
    const parent = msg.parent_tool_use_id ?? undefined
    const out: CcEvent[] = []
    for (const block of content) {
      if (block && (block as RawContentBlock).type === 'tool_result') {
        const b = block as Extract<RawContentBlock, { type: 'tool_result' }>
        const { text, images } = flattenContent(b.content)
        out.push({
          type: 'tool_result',
          result: {
            toolUseId: b.tool_use_id ?? '',
            text,
            isError: Boolean(b.is_error),
            ...(images.length ? { images } : {}),
            ...(parent ? { parentToolUseId: parent } : {})
          }
        })
      }
    }
    return out
  }

  /** A subagent's nested assistant turn: surface its internal tool calls so the
   *  UI can list them under the parent Task/Agent block. Text/thinking from the
   *  subagent is dropped — only the tool activity is kept. */
  private handleNestedAssistant(msg: RawAssistantMessage, parentToolUseId: string): CcEvent[] {
    const content = msg.message?.content
    if (!Array.isArray(content)) return []
    const out: CcEvent[] = []
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        const b = block as Extract<RawContentBlock, { type: 'tool_use' }>
        out.push({
          type: 'nested_tool_use',
          parentToolUseId,
          toolUseId: b.id ?? '',
          name: b.name ?? 'tool',
          inputJson: JSON.stringify(b.input ?? {})
        })
      }
    }
    return out
  }

  private handleResult(msg: RawResultMessage): CcEvent[] {
    const usage = msg.raw_usage ?? msg.usage
    return [
      {
        type: 'result',
        subtype: msg.subtype,
        costUsd: msg.total_cost_usd,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens
      }
    ]
  }

  private handleStream(event: RawStreamEvent, nowTs: number): CcEvent[] {
    switch (event.type) {
      case 'message_start': {
        this.currentMessageId =
          event.message?.id ?? `msg-${(this.seq += 1)}`
        const out: CcEvent[] = [
          { type: 'assistant_start', messageId: this.currentMessageId, ts: nowTs }
        ]
        const u = event.message?.usage
        if (u) {
          const tokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0)
          if (tokens > 0) out.push({ type: 'context', tokens })
        }
        return out
      }
      case 'content_block_start': {
        const index = event.index ?? 0
        const cb = event.content_block ?? {}
        const blockId = this.blockId(index)
        if (cb.type === 'tool_use') {
          return [
            {
              type: 'block_start',
              messageId: this.currentMessageId ?? '',
              blockId,
              kind: 'tool_use',
              toolName: cb.name ?? 'tool',
              toolUseId: cb.id ?? blockId
            }
          ]
        }
        const kind: BlockKind = cb.type === 'thinking' ? 'thinking' : 'text'
        return [
          {
            type: 'block_start',
            messageId: this.currentMessageId ?? '',
            blockId,
            kind
          }
        ]
      }
      case 'content_block_delta': {
        const blockId = this.blockId(event.index ?? 0)
        const d = event.delta ?? {}
        if (d.type === 'text_delta' && typeof d.text === 'string')
          return [{ type: 'text_delta', blockId, text: d.text }]
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string')
          return [{ type: 'thinking_delta', blockId, text: d.thinking }]
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string')
          return [{ type: 'tool_input_delta', blockId, partialJson: d.partial_json }]
        return []
      }
      case 'content_block_stop':
        return [{ type: 'block_stop', blockId: this.blockId(event.index ?? 0) }]
      case 'message_stop':
        return this.currentMessageId
          ? [{ type: 'assistant_stop', messageId: this.currentMessageId }]
          : []
      default:
        return []
    }
  }
}

/* ───────────────────── History (JSONL) reconstruction ───────────────── */

/** A persisted session message, as returned by the SDK's getSessionMessages(). */
export interface PersistedMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id?: string | null
}

/**
 * Rebuild a renderable transcript from persisted session messages. This is how
 * a closed session re-renders on reopen — same view model, no live stream.
 */
export function historyToItems(messages: PersistedMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let order = 0
  // Every top-level tool_use block, keyed by its tool-use id, so a subagent's
  // nested calls/results (messages carrying parent_tool_use_id) can be folded
  // into the parent Task/Agent block instead of appearing as loose items.
  const blockByToolUseId = new Map<string, UiToolUseBlock>()

  for (const m of messages) {
    if (m.type === 'system') continue
    const inner = (m.message ?? {}) as { role?: string; content?: unknown }
    const content = inner.content
    const parent = m.parent_tool_use_id ?? undefined

    // A subagent's internal turn: fold its tool calls + results into the parent
    // Task/Agent block rather than emitting top-level items.
    if (parent) {
      const host = blockByToolUseId.get(parent)
      if (host && Array.isArray(content)) {
        const nested = (host.nested ??= [])
        for (const raw of content) {
          const c = raw as RawContentBlock
          if (c.type === 'tool_use')
            nested.push({
              toolUseId: c.id ?? '',
              name: c.name ?? 'tool',
              inputJson: JSON.stringify(c.input ?? {})
            })
          else if (c.type === 'tool_result') {
            const { text, images } = flattenContent(c.content)
            const result: UiToolResult = {
              toolUseId: c.tool_use_id ?? '',
              text,
              isError: Boolean(c.is_error),
              ...(images.length ? { images } : {}),
              parentToolUseId: parent
            }
            const entry = nested.find((n) => n.toolUseId === result.toolUseId && !n.result)
            if (entry) entry.result = result
            else nested.push({ toolUseId: result.toolUseId, name: 'tool', inputJson: '', result })
          }
        }
      }
      continue
    }

    const blocks: UiBlock[] = []

    if (typeof content === 'string') {
      if (content.length) blocks.push({ kind: 'text', id: `${m.uuid}#0`, text: content })
    } else if (Array.isArray(content)) {
      content.forEach((raw, i) => {
        const c = raw as RawContentBlock
        const id = `${m.uuid}#${i}`
        if (c.type === 'text' && typeof c.text === 'string')
          blocks.push({ kind: 'text', id, text: c.text })
        else if (c.type === 'image') {
          const img = extractImage(c as unknown as Record<string, unknown>)
          if (img) blocks.push({ kind: 'image', id, image: img })
        } else if (c.type === 'thinking' && typeof c.thinking === 'string')
          blocks.push({ kind: 'thinking', id, text: c.thinking, done: true })
        else if (c.type === 'tool_use') {
          const block: UiToolUseBlock = {
            kind: 'tool_use',
            id,
            toolUseId: c.id ?? id,
            name: c.name ?? 'tool',
            inputJson: JSON.stringify(c.input ?? {}),
            done: true
          }
          blockByToolUseId.set(block.toolUseId, block)
          blocks.push(block)
        } else if (c.type === 'tool_result') {
          const { text, images } = flattenContent(c.content)
          items.push({
            kind: 'tool_result',
            result: {
              toolUseId: c.tool_use_id ?? '',
              text,
              isError: Boolean(c.is_error),
              ...(images.length ? { images } : {})
            }
          })
        }
      })
    }

    if (blocks.length) {
      const role = m.type === 'assistant' ? 'assistant' : 'user'
      items.push({
        kind: 'message',
        message: { id: m.uuid || `h-${(order += 1)}`, role, blocks, ts: order }
      })
    }
  }
  return items
}

/** Best-effort pretty-print of a (possibly partial) streamed JSON fragment. */
export function formatToolInput(inputJson: string): string {
  const trimmed = inputJson.trim()
  if (!trimmed) return ''
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return trimmed
  }
}

/** Best-effort parse of a (possibly still-streaming) tool input JSON blob. */
export function parseToolInput(inputJson: string): Record<string, unknown> | null {
  const trimmed = inputJson.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The context window (in tokens) for a given model. Claude models are 200K by
 * default; the 1M-context beta is surfaced with a `[1m]` marker on the model id.
 * Falls back to 200K for unknown models.
 */
export function contextWindowFor(model?: string): number {
  if (model && /\[1m\]|1m-context/i.test(model)) return 1_000_000
  return 200_000
}

/** Compact token count for status display: 1234 → "1.2k", 200000 → "200k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
