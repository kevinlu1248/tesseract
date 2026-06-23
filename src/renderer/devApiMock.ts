/**
 * Dev-only mock of window.api. Installed ONLY when the real preload bridge is
 * absent — i.e. when the renderer is opened in a plain browser (e.g. for UI
 * testing via Chrome) rather than inside Electron. Inside Electron, window.api
 * is provided by the preload and this module does nothing.
 *
 * It scripts a realistic streamed session so every component (text, thinking,
 * tool_use, tool_result, permission prompt) can be exercised without a backend.
 */
import type {
  AnswerPermissionArgs,
  SendArgs,
  SessionCard,
  SessionCardUpdate,
  SessionEventEnvelope,
  StartSessionArgs,
  WorkspaceApi
} from '../shared/ipc'
import type { TranscriptItem } from '../shared/schema'

function install(): void {
  const listeners = new Set<(e: SessionEventEnvelope) => void>()
  const summaryListeners = new Set<(u: SessionCardUpdate) => void>()
  const localId = 'mock-session'
  // The question set shared by the AskUserQuestion tool_use block, the
  // interactive picker, and the formatted answer fed back as the tool result.
  const askQuestions = [
    {
      question: 'Which package manager should this project use?',
      header: 'Pkg mgr',
      multiSelect: false,
      options: [
        { label: 'npm', description: 'Ships with Node; simplest, widely supported.' },
        { label: 'pnpm', description: 'Fast, disk-efficient via a content-addressable store.' },
        { label: 'yarn', description: 'Mature alternative with workspaces support.' }
      ]
    },
    {
      question: 'Which checks should run in CI?',
      header: 'CI checks',
      multiSelect: true,
      options: [
        { label: 'Typecheck', description: 'Run tsc in strict mode.' },
        { label: 'Lint', description: 'Run ESLint over the source.' },
        { label: 'Tests', description: 'Run the unit test suite.' }
      ]
    }
  ]
  const emit = (event: SessionEventEnvelope['event']): void =>
    listeners.forEach((cb) => cb({ localId, event }))
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const streamText = async (messageId: string, blockId: string, text: string): Promise<void> => {
    emit({ kind: 'cc', event: { type: 'block_start', messageId, blockId, kind: 'text' } })
    for (const word of text.split(' ')) {
      emit({ kind: 'cc', event: { type: 'text_delta', blockId, text: word + ' ' } })
      await wait(18)
    }
    emit({ kind: 'cc', event: { type: 'block_stop', blockId } })
  }

  const runScript = async (): Promise<void> => {
    emit({
      kind: 'cc',
      event: {
        type: 'system_init',
        sessionId: 'demo-uuid-1234',
        model: 'claude-opus-4-8',
        cwd: '/Users/you/demo-repo'
      }
    })
    emit({ kind: 'sdk_session', sdkSessionId: 'demo-uuid-1234' })
    await wait(200)

    const m1 = 'msg-1'
    emit({ kind: 'cc', event: { type: 'assistant_start', messageId: m1, ts: Date.now() } })
    emit({ kind: 'cc', event: { type: 'context', tokens: 48230 } })
    emit({ kind: 'status', status: 'running' })

    emit({ kind: 'cc', event: { type: 'block_start', messageId: m1, blockId: 'b-think', kind: 'thinking' } })
    for (const t of ['Let me ', 'inspect ', 'the repo ', 'structure first.']) {
      emit({ kind: 'cc', event: { type: 'thinking_delta', blockId: 'b-think', text: t } })
      await wait(60)
    }
    emit({ kind: 'cc', event: { type: 'block_stop', blockId: 'b-think' } })

    await streamText(
      m1,
      'b-text',
      "I'll start by listing the project files. Here's the plan:\n\n1. Read `package.json`\n2. Run the test suite\n\n```bash\nls -la\n```"
    )

    // Compact read (renders as an inline "read filename" line).
    emit({
      kind: 'cc',
      event: { type: 'block_start', messageId: m1, blockId: 'b-read', kind: 'tool_use', toolName: 'Read', toolUseId: 'tool-read' }
    })
    emit({ kind: 'cc', event: { type: 'tool_input_delta', blockId: 'b-read', partialJson: '{"file_path":"/Users/you/demo-repo/src/index.ts"}' } })
    emit({ kind: 'cc', event: { type: 'block_stop', blockId: 'b-read' } })

    // Edit (renders as a syntax-highlighted red/green diff card).
    emit({
      kind: 'cc',
      event: { type: 'block_start', messageId: m1, blockId: 'b-edit', kind: 'tool_use', toolName: 'Edit', toolUseId: 'tool-edit' }
    })
    emit({
      kind: 'cc',
      event: {
        type: 'tool_input_delta',
        blockId: 'b-edit',
        partialJson: JSON.stringify({
          file_path: '/Users/you/demo-repo/src/index.ts',
          old_string: 'const port = 3000\nconst host = "localhost"\napp.listen(port)',
          new_string: 'const port = Number(process.env.PORT) || 3000\nconst host = "0.0.0.0"\napp.listen(port, host)'
        })
      }
    })
    emit({ kind: 'cc', event: { type: 'block_stop', blockId: 'b-edit' } })

    // An image tool result (e.g. a screenshot).
    emit({
      kind: 'cc',
      event: {
        type: 'tool_result',
        result: {
          toolUseId: 'tool-edit',
          text: 'Captured screenshot',
          isError: false,
          images: [
            {
              mediaType: 'image/png',
              data:
                'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAOklEQVR4nO3OMQ0AIAwAsIWZf8tYIEEEC1q1z3aSdcsBAAAAAAAAAAAAAAAAAAAAAAAAAAB44wBhFAFhKxQqfgAAAABJRU5ErkJggg=='
            }
          ]
        }
      }
    })
    await wait(150)

    // A subagent (Agent) delegation — renders as the SubagentCard, with its
    // internal tool calls folded in as a nested activity feed.
    emit({
      kind: 'cc',
      event: { type: 'block_start', messageId: m1, blockId: 'b-task', kind: 'tool_use', toolName: 'Agent', toolUseId: 'tool-task' }
    })
    emit({
      kind: 'cc',
      event: {
        type: 'tool_input_delta',
        blockId: 'b-task',
        partialJson: JSON.stringify({
          subagent_type: 'Explore',
          description: 'Audit auth module',
          prompt:
            'Search the codebase for every place the auth module is imported and used. List the files, the exported symbols each one consumes, and flag any usages that bypass the new token-refresh path. This is a deliberately long prompt so we can see how the card truncates the subtitle on one line while keeping the full text in the expanded prompt panel.'
        })
      }
    })
    emit({ kind: 'cc', event: { type: 'block_stop', blockId: 'b-task' } })
    await wait(300)

    // The subagent's internal tool calls stream in as nested activity — these
    // fold under the SubagentCard instead of flooding the top-level transcript.
    emit({
      kind: 'cc',
      event: {
        type: 'nested_tool_use',
        parentToolUseId: 'tool-task',
        toolUseId: 'sub-1',
        name: 'Grep',
        inputJson: JSON.stringify({ pattern: "from '.*auth'" })
      }
    })
    await wait(250)
    emit({
      kind: 'cc',
      event: {
        type: 'tool_result',
        result: {
          toolUseId: 'sub-1',
          parentToolUseId: 'tool-task',
          isError: false,
          text: 'src/main/auth.ts\nsrc/main/ipc.ts\nsrc/renderer/state/useWorkspace.ts'
        }
      }
    })
    await wait(200)
    emit({
      kind: 'cc',
      event: {
        type: 'nested_tool_use',
        parentToolUseId: 'tool-task',
        toolUseId: 'sub-2',
        name: 'Read',
        inputJson: JSON.stringify({ file_path: 'src/main/auth.ts' })
      }
    })
    await wait(250)
    emit({
      kind: 'cc',
      event: {
        type: 'tool_result',
        result: {
          toolUseId: 'sub-2',
          parentToolUseId: 'tool-task',
          isError: false,
          text: 'export function login() {}\nexport function logout() {}\nexport function getAuth() {}'
        }
      }
    })
    await wait(300)
    emit({
      kind: 'cc',
      event: {
        type: 'tool_result',
        result: {
          toolUseId: 'tool-task',
          isError: false,
          text: 'The auth module is imported in **7 files**:\n\n- `src/main/auth.ts` — defines `login`, `logout`, `getAuth`\n- `src/main/ipc.ts` — calls `getAuth()` on startup\n- `src/renderer/state/useWorkspace.ts` — reads auth mode\n\nNo usages bypass the token-refresh path. ✅'
        }
      }
    })
    await wait(150)

    // A tool call that needs permission.
    emit({
      kind: 'cc',
      event: {
        type: 'block_start',
        messageId: m1,
        blockId: 'b-tool',
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'tool-1'
      }
    })
    for (const frag of ['{"command":', ' "ls -la",', ' "description":', ' "list files"}']) {
      emit({ kind: 'cc', event: { type: 'tool_input_delta', blockId: 'b-tool', partialJson: frag } })
      await wait(40)
    }
    emit({ kind: 'cc', event: { type: 'block_stop', blockId: 'b-tool' } })

    emit({
      kind: 'permission',
      request: { requestId: 'perm-1', toolName: 'Bash', input: { command: 'ls -la' } }
    })

    // The model also issues the AskUserQuestion tool call. Emit its tool_use
    // block so the transcript shows a durable record of the question — mirroring
    // the real backend, where the SDK streams this block before the picker is
    // answered. The interactive picker (the `question` event below) is how the
    // user actually answers it.
    emit({
      kind: 'cc',
      event: {
        type: 'block_start',
        messageId: m1,
        blockId: 'b-ask',
        kind: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-q1'
      }
    })
    emit({
      kind: 'cc',
      event: {
        type: 'tool_input_delta',
        blockId: 'b-ask',
        partialJson: JSON.stringify({ questions: askQuestions })
      }
    })
    emit({ kind: 'cc', event: { type: 'block_stop', blockId: 'b-ask' } })

    // Demonstrate the interactive AskUserQuestion picker alongside the prompt.
    emit({ kind: 'question', request: { requestId: 'q-1', questions: askQuestions } })
  }

  const api: WorkspaceApi = {
    getAuth: async () => ({
      mode: 'subscription',
      apiKeyEnvSet: false,
      detail: '[browser mock] Using subscription auth.'
    }),
    pickRepo: async () => '/Users/you/demo-repo',
    startSession: async (_args: StartSessionArgs) => {
      void runScript()
      return { localId }
    },
    createWorktree: async (args) => ({
      path: `${args.cwd}/.worktrees/mock-branch`,
      branch: 'mock-branch'
    }),
    reviveSession: async () => {
      emit({ kind: 'status', status: 'idle' })
    },
    send: async (_args: SendArgs) => {
      const m = `msg-${Date.now()}`
      emit({ kind: 'status', status: 'running' })
      emit({ kind: 'cc', event: { type: 'assistant_start', messageId: m, ts: Date.now() } })
      await streamText(m, `${m}#t`, 'Got it — that is the mocked reply in the browser preview.')
      emit({ kind: 'cc', event: { type: 'result' } })
      emit({ kind: 'status', status: 'idle' })
    },
    rewind: async () => ({ sessionId: null }),
    interrupt: async () => emit({ kind: 'status', status: 'interrupted' }),
    closeSession: async () => undefined,
    answerPermission: async (args: AnswerPermissionArgs) => {
      emit({ kind: 'permission_resolved', requestId: args.requestId })
      emit({ kind: 'status', status: 'running' })
      emit({ kind: 'cc', event: { type: 'assistant_start', messageId: 'msg-2', ts: Date.now() } })
      if (args.decision.behavior === 'allow') {
        emit({
          kind: 'cc',
          event: {
            type: 'tool_result',
            result: {
              toolUseId: 'tool-1',
              text: 'total 24\ndrwxr-xr-x  package.json\ndrwxr-xr-x  src\n-rw-r--r--  README.md',
              isError: false
            }
          }
        })
        await streamText('msg-2', 'b-final', 'Done — the repo has a standard layout. What would you like next?')
      } else {
        await streamText('msg-2', 'b-final', 'Understood, I will not run that command.')
      }
      emit({ kind: 'cc', event: { type: 'result' } })
      emit({ kind: 'status', status: 'idle' })
    },
    answerQuestion: async (args) => {
      emit({ kind: 'question_resolved', requestId: args.requestId })
      emit({ kind: 'status', status: 'running' })
      // Mirror the real backend: the answer is delivered to the model by
      // resolving the SDK permission as a deny, so the tool_result comes back
      // flagged as an error with the user's picks as its text. The transcript
      // card must render this as the answered question, NOT as "failed".
      const lines = askQuestions.map((q, i) => {
        const picks = args.answer.answers[i] ?? []
        const chosen = picks.length ? picks.join(', ') : '(no answer)'
        return `[${q.header}] ${q.question}\n→ ${chosen}`
      })
      emit({
        kind: 'cc',
        event: {
          type: 'tool_result',
          result: {
            toolUseId: 'tool-q1',
            isError: true,
            text: `The user answered your question(s):\n\n${lines.join('\n\n')}\n\nProceed using the user's choices above.`
          }
        }
      })
      emit({ kind: 'status', status: 'idle' })
    },
    listSessions: async () => [
      { sessionId: 's-1', summary: 'Refactor the auth module', lastModified: Date.now() - 3600_000, firstPrompt: 'Refactor auth' },
      { sessionId: 's-2', summary: 'Fix failing CI tests', lastModified: Date.now() - 86400_000 }
    ],
    getSessionSummaries: async (): Promise<SessionCard[]> => {
      const provider = 'claude' as const
      // Return pending cards only; generation happens lazily on demand via
      // generateSessionSummary when the renderer actually shows a card.
      return [
        {
          sessionId: 's-1',
          title: 'Refactor auth',
          description: null,
          lastModified: Date.now() - 3600_000,
          firstPrompt: 'Refactor the auth module',
          provider,
          pending: true
        },
        {
          sessionId: 's-2',
          title: 'Fix failing CI tests',
          description: null,
          lastModified: Date.now() - 86400_000,
          provider,
          pending: true
        }
      ]
    },
    generateSessionSummary: async (
      sessionId: string,
      cwd: string
    ): Promise<SessionCard | null> => {
      const provider = 'claude' as const
      // Simulate the model call latency for the skeleton loading state.
      await wait(900)
      const lookup: Record<string, SessionCard> = {
        's-1': {
          sessionId: 's-1',
          title: 'Auth module refactor',
          description:
            'Restructured the auth module into smaller services and tightened token handling.',
          lastModified: Date.now() - 3600_000,
          firstPrompt: 'Refactor the auth module',
          provider,
          pending: false
        },
        's-2': {
          sessionId: 's-2',
          title: 'Green up CI',
          description:
            'Diagnosed and fixed the flaky CI test suite so the pipeline passes reliably.',
          lastModified: Date.now() - 86400_000,
          provider,
          pending: false
        }
      }
      const card = lookup[sessionId]
      if (!card) return null
      summaryListeners.forEach((cb) => cb({ cwd, provider, card }))
      return card
    },
    generateTitle: async (firstMessage: string): Promise<string | null> => {
      await wait(400)
      const words = firstMessage.trim().split(/\s+/).slice(0, 5).join(' ')
      return words ? `Mock: ${words}` : null
    },
    summarizeSession: async (args): Promise<{ title: string; description: string }> => {
      await wait(400)
      const words = args.firstPrompt.trim().split(/\s+/).slice(0, 5).join(' ')
      return {
        title: args.title || (words ? `Mock: ${words}` : 'Mock conversation'),
        description: `Mock summary updated after a completed task (${args.latestState.length} chars of output).`
      }
    },
    loadHistory: async (): Promise<TranscriptItem[]> => [
      {
        kind: 'message',
        message: {
          id: 'h1',
          role: 'user',
          blocks: [{ kind: 'text', id: 'h1#0', text: 'Refactor the auth module' }],
          ts: 1
        }
      },
      {
        kind: 'message',
        message: {
          id: 'h2',
          role: 'assistant',
          blocks: [{ kind: 'text', id: 'h2#0', text: 'Sure — this conversation was **re-rendered from JSONL history**.' }],
          ts: 2
        }
      }
    ],
    getRecentScreenshot: async () => null,
    focusWindow: async (): Promise<void> => {
      window.focus()
    },
    showNotification: () => {
      // No OS notifications in the browser preview.
    },
    onNotificationClicked: () => () => undefined,
    onClosePaneRequest: () => () => undefined,
    restartApp: async (): Promise<void> => {
      // No Electron process to relaunch in the browser preview — reload the page.
      window.location.reload()
    },
    onSessionEvent: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onSessionSummaryUpdated: (cb) => {
      summaryListeners.add(cb)
      return () => summaryListeners.delete(cb)
    }
  }

  ;(window as unknown as { api: WorkspaceApi }).api = api
  // eslint-disable-next-line no-console
  console.log('[tesseract] installed browser mock window.api (no Electron preload detected)')
}

if (typeof window !== 'undefined' && !(window as unknown as { api?: unknown }).api) {
  install()
}
