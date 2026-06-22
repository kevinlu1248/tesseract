import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BackendAdapter,
  BackendCallbacks,
  BackendStartOptions
} from './BackendAdapter'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionOutboundEvent
} from '../../shared/ipc'
import type { UiImage } from '../../shared/schema'

type CodexJsonEvent =
  | { type: 'thread.started'; thread_id?: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'item.started'; item?: CodexItem }
  | { type: 'item.completed'; item?: CodexItem }
  | { type: string; [k: string]: unknown }

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
}

type CodexItem =
  | { id?: string; type: 'agent_message'; text?: string }
  | {
      id?: string
      type: 'command_execution'
      command?: string
      aggregated_output?: string
      exit_code?: number | null
      status?: string
    }
  | { id?: string; type: string; [k: string]: unknown }

interface QueuedTurn {
  text: string
  images?: UiImage[]
}

export class CodexCliAdapter implements BackendAdapter {
  private cb: BackendCallbacks | null = null
  private cwd = ''
  private model: string | undefined
  private threadId: string | undefined
  private current: ChildProcessWithoutNullStreams | null = null
  private queue: QueuedTurn[] = []
  private running = false
  private closed = false
  private assistantSeq = 0
  private toolSeq = 0

  private emit(event: SessionOutboundEvent): void {
    this.cb?.onEvent(event)
  }

  async start(opts: BackendStartOptions, cb: BackendCallbacks): Promise<void> {
    this.cb = cb
    this.cwd = opts.cwd
    this.model = opts.model
    this.threadId = opts.resumeSessionId
    this.emit({ kind: 'status', status: opts.pendingSend ? 'connecting' : 'idle' })
    if (this.threadId) this.emit({ kind: 'sdk_session', sdkSessionId: this.threadId })
  }

  send(text: string, images?: UiImage[]): void {
    if (this.closed) return
    this.queue.push({ text, images })
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running || this.closed) return
    const turn = this.queue.shift()
    if (!turn) return
    this.running = true
    this.emit({ kind: 'status', status: 'connecting' })
    try {
      await this.runTurn(turn)
      if (!this.closed) this.emit({ kind: 'status', status: 'idle' })
    } catch (err) {
      if (!this.closed) this.fail(err)
    } finally {
      this.running = false
      if (!this.closed && this.queue.length) void this.drain()
    }
  }

  private async runTurn(turn: QueuedTurn): Promise<void> {
    const tmp = turn.images?.length ? await mkdtemp(join(tmpdir(), 'cw-codex-')) : null
    try {
      const imageArgs: string[] = []
      if (tmp && turn.images) {
        for (const [i, img] of turn.images.entries()) {
          const ext = extensionFor(img.mediaType)
          const file = join(tmp, `image-${i}.${ext}`)
          await writeFile(file, Buffer.from(img.data, 'base64'))
          imageArgs.push('-i', file)
        }
      }

      const args = [
        '-a',
        'never',
        'exec',
        '--json',
        '--cd',
        this.cwd,
        '--skip-git-repo-check',
        '--sandbox',
        'danger-full-access',
        ...(this.model ? ['-m', this.model] : []),
        ...imageArgs
      ]
      if (this.threadId) args.push('resume', this.threadId, turn.text || '-')
      else args.push(turn.text || '-')

      await new Promise<void>((resolve, reject) => {
        const child = spawn('codex', args, {
          cwd: this.cwd,
          env: process.env
        })
        this.current = child
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
          const lines = stdout.split(/\r?\n/)
          stdout = lines.pop() ?? ''
          for (const line of lines) this.handleLine(line)
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.stdin.end()
        child.on('error', reject)
        child.on('close', (code, signal) => {
          this.current = null
          if (stdout.trim()) this.handleLine(stdout)
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || `Codex exited with ${signal ?? code}`))
        })
      })
    } finally {
      if (tmp) void rm(tmp, { recursive: true, force: true })
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: CodexJsonEvent
    try {
      event = JSON.parse(trimmed) as CodexJsonEvent
    } catch {
      return
    }
    if (event.type === 'thread.started') {
      const threadId = typeof event.thread_id === 'string' ? event.thread_id : undefined
      this.threadId = threadId
      if (threadId) {
        this.emit({ kind: 'sdk_session', sdkSessionId: threadId })
        this.emit({
          kind: 'cc',
          event: {
            type: 'system_init',
            sessionId: threadId,
            model: this.model ?? 'codex',
            cwd: this.cwd
          }
        })
      }
      return
    }
    if (event.type === 'turn.started') {
      this.emit({ kind: 'status', status: 'running' })
      return
    }
    if (event.type === 'item.started' || event.type === 'item.completed') {
      this.handleItem((event as { item?: CodexItem }).item, event.type === 'item.completed')
      return
    }
    if (event.type === 'turn.completed') {
      const usage = (event as { usage?: CodexUsage }).usage
      const inputTokens = usage
        ? (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0)
        : undefined
      if (inputTokens) this.emit({ kind: 'cc', event: { type: 'context', tokens: inputTokens } })
      this.emit({
        kind: 'cc',
        event: {
          type: 'result',
          inputTokens,
          outputTokens: usage?.output_tokens
        }
      })
    }
  }

  private handleItem(item: CodexItem | undefined, completed: boolean): void {
    if (!item) return
    if (item.type === 'agent_message' && completed && typeof item.text === 'string') {
      const messageId = `codex-msg-${(this.assistantSeq += 1)}`
      const blockId = `${messageId}#0`
      const ts = Date.now()
      this.emit({ kind: 'cc', event: { type: 'assistant_start', messageId, ts } })
      this.emit({
        kind: 'cc',
        event: { type: 'block_start', messageId, blockId, kind: 'text' }
      })
      this.emit({ kind: 'cc', event: { type: 'text_delta', blockId, text: item.text } })
      this.emit({ kind: 'cc', event: { type: 'block_stop', blockId } })
      this.emit({ kind: 'cc', event: { type: 'assistant_stop', messageId } })
      return
    }
    if (item.type === 'command_execution') {
      const toolUseId = item.id || `codex-tool-${(this.toolSeq += 1)}`
      const blockId = `codex-tool-block-${toolUseId}`
      const messageId = `codex-tool-msg-${toolUseId}`
      if (!completed) {
        this.emit({
          kind: 'cc',
          event: { type: 'assistant_start', messageId, ts: Date.now() }
        })
        this.emit({
          kind: 'cc',
          event: {
            type: 'block_start',
            messageId,
            blockId,
            kind: 'tool_use',
            toolName: 'exec_command',
            toolUseId
          }
        })
        this.emit({
          kind: 'cc',
          event: {
            type: 'tool_input_delta',
            blockId,
            partialJson: JSON.stringify({ cmd: item.command ?? '' })
          }
        })
        this.emit({ kind: 'cc', event: { type: 'block_stop', blockId } })
        this.emit({ kind: 'cc', event: { type: 'assistant_stop', messageId } })
      } else {
        const exit = typeof item.exit_code === 'number' ? `\n\nExit code: ${item.exit_code}` : ''
        this.emit({
          kind: 'cc',
          event: {
            type: 'tool_result',
            result: {
              toolUseId,
              text: `${item.aggregated_output ?? ''}${exit}`,
              isError: typeof item.exit_code === 'number' && item.exit_code !== 0
            }
          }
        })
      }
    }
  }

  async interrupt(): Promise<void> {
    this.current?.kill('SIGINT')
    this.emit({ kind: 'status', status: 'interrupted' })
  }

  answerPermission(_requestId: string, _decision: PermissionDecision): void {
    // Codex runs with -a never from this adapter, so permission prompts are not surfaced.
  }

  answerQuestion(_requestId: string, _answer: QuestionAnswer): void {
    // Codex CLI has no AskUserQuestion equivalent in the JSON exec path.
  }

  async close(): Promise<void> {
    this.closed = true
    this.queue = []
    this.current?.kill('SIGTERM')
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const fatal = !/interrupt|abort|cancell?ed|SIGINT/i.test(message)
    this.emit({ kind: 'error', message: describeError(message), fatal })
    this.emit({ kind: 'status', status: fatal ? 'error' : 'interrupted' })
  }
}

function extensionFor(mediaType: string): string {
  if (/jpe?g/i.test(mediaType)) return 'jpg'
  if (/webp/i.test(mediaType)) return 'webp'
  return 'png'
}

function describeError(message: string): string {
  if (/ENOENT|spawn|not found|executable/i.test(message))
    return `Could not launch the Codex executable. Is the \`codex\` CLI installed? (${message})`
  if (/login|auth|unauthor|401|403/i.test(message))
    return `Authentication problem - run \`codex login\` in a terminal. (${message})`
  return message
}
