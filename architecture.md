# Tesseract — Architecture

A desktop app for running Claude Code where **agent output is rendered as
HTML/React DOM, never a terminal emulator**. There is no xterm.js and no PTY in
the display path. Structured agent events map to React components, and user
input is a real DOM `<textarea>` (so `ctrl+A`, `option+arrow`, word-delete, etc.
work natively).

> Status: **Phase 1 complete** (single session, end to end). Phases 2–3 below
> are designed-for but not yet built.

---

## 1. Process model & module layout

Electron, two processes, a hard presentation/logic split:

- **Main process** — drives Claude Code via the Agent SDK, owns all session
  state and the process lifecycle. Never renders anything.
- **Renderer** — pure React presentation. Never imports the SDK, never touches
  Node. It only knows the typed IPC contract and the view model.

```
src/
├── shared/                  # imported by BOTH processes — the typed contracts
│   ├── schema.ts            # ← THE schema module (see §4). Raw SDK shapes,
│   │                        #   normalized view model, SdkStreamTranslator,
│   │                        #   history reconstruction. One file to fix on drift.
│   └── ipc.ts               # IPC channels + payload types + window.api surface
│
├── main/                    # CommonJS bundle
│   ├── index.ts             # app/window lifecycle
│   ├── ipc.ts               # registers ipcMain handlers; broadcasts events
│   ├── auth.ts              # subscription-vs-API-key detection
│   ├── sessions/
│   │   └── SessionManager.ts# per-session adapters, routing, list/history
│   └── backend/
│       ├── BackendAdapter.ts# ← the swappable transport interface (§3)
│       ├── AgentSdkAdapter.ts# Agent-SDK implementation (streaming-input mode)
│       └── sdk.ts           # runtime ESM dynamic-import of the SDK (§6)
│
├── preload/
│   └── index.ts             # contextBridge → window.api (typed by ipc.ts)
│
└── renderer/                # ESM bundle (Vite + React + Tailwind)
    ├── main.tsx             # mount; installs dev mock when no preload (§7)
    ├── App.tsx              # start screen ↔ active session
    ├── state/
    │   ├── sessionStore.ts  # reducer: CcEvent stream → transcript view model
    │   └── useSession.ts    # owns one session; subscribes to events; actions
    └── components/          # one component per block kind (§4 mapping)
```

---

## 2. The IPC event contract (`src/shared/ipc.ts`)

The renderer↔main boundary is one explicit typed contract. Channels live in the
`IPC` const; every payload has a type.

**Renderer → main (request/response, `ipcRenderer.invoke`):**

| Channel | Args | Returns |
|---|---|---|
| `auth:get` | — | `AuthInfo` |
| `dialog:pick-repo` | — | `string \| null` |
| `session:start` | `StartSessionArgs` | `{ localId }` |
| `session:send` | `SendArgs` | — |
| `session:interrupt` | `localId` | — |
| `session:close` | `localId` | — |
| `permission:answer` | `AnswerPermissionArgs` | — |
| `session:list` | `cwd` | `SessionSummary[]` |
| `session:load-history` | `{ sessionId, cwd }` | `TranscriptItem[]` |

**Main → renderer (push, `webContents.send` on `session:event`):**

```ts
SessionEventEnvelope = { localId: string; event: SessionOutboundEvent }

SessionOutboundEvent =
  | { kind: 'cc';          event: CcEvent }            // normalized stream
  | { kind: 'status';      status: SessionStatus }     // running/idle/awaiting…
  | { kind: 'error';       message: string; fatal: boolean }
  | { kind: 'sdk_session'; sdkSessionId: string }      // for resume
  | { kind: 'permission';  request: PermissionRequest }
  | { kind: 'permission_resolved'; requestId: string }
```

Every session is keyed by a `localId` (a UUID minted in main on `start`). The
real SDK `session_id` is learned later (from the `system/init` message) and
surfaced via `sdk_session` — that is what's used to resume.

`window.api` (exposed by preload, typed as `WorkspaceApi`) is the only global
the renderer touches.

---

## 3. The BackendAdapter interface (`src/main/backend/BackendAdapter.ts`)

The UI and `SessionManager` talk **only** to this interface, never to the SDK
directly. This is what makes the transport swappable — SDK-headless today; a
PTY-interactive adapter or a Codex adapter later — without touching the UI.

```ts
interface BackendAdapter {
  start(opts: BackendStartOptions, cb: BackendCallbacks): Promise<void>
  send(text: string): void
  interrupt(): Promise<void>
  answerPermission(requestId: string, decision: PermissionDecision): void
  close(): Promise<void>
}
```

`AgentSdkAdapter` implements it using the Agent SDK in **streaming-input mode**:
one long-lived `query({ prompt: asyncIterable, options })` per session, fed user
messages through an internal async queue. This keeps a single session/subprocess
across turns and makes `interrupt()` and the `canUseTool` permission callback
work naturally.

- `includePartialMessages: true` → we consume structured `stream_event`s.
- `canUseTool` → returns a Promise that resolves when the renderer answers a
  permission prompt (stored by `requestId`).
- `permissionMode: 'default'`, no API key injected → stays on subscription auth.
- Errors (rate-limit, credit, auth-expiry, missing CLI) are classified into
  actionable messages and surfaced as `error` events — never a silent hang.

---

## 4. Message schema → component mapping (`src/shared/schema.ts`)

All knowledge of the SDK wire format lives in `schema.ts`. It has two layers and
a translator:

1. **Raw SDK shapes** (`Raw*`) — permissive mirrors of what the SDK emits.
2. **Normalized view model** (`Ui*`, `CcEvent`) — what the renderer renders.
3. **`SdkStreamTranslator`** — stateful bridge: feed it raw SDK messages, it
   reconstructs assistant messages from partial `stream_event` deltas and emits
   the normalized `CcEvent` stream. (Full `assistant` messages are ignored on
   purpose — content is rebuilt from deltas for smooth token streaming.)

```
SDK message            CcEvent(s)                  Renderer component
─────────────────────  ──────────────────────────  ──────────────────────────
system/init            system_init                 → status bar (model, cwd)
stream_event           assistant_start             → new assistant message row
  message_start
  content_block_start  block_start (text)          → MarkdownText
                       block_start (thinking)      → ThinkingBlock (collapsible)
                       block_start (tool_use)      → ToolUseCard (collapsible)
  content_block_delta  text_delta / thinking_delta → streamed into the block
                       tool_input_delta            → accumulated JSON in card
  content_block_stop   block_stop                  → marks tool card "done"
user (tool_result)     tool_result                 → ToolResultCard (collapsible)
result                 result + status:idle        → composer returns to idle
canUseTool callback    (permission lifecycle)      → PermissionPrompt (approve/deny)
```

The renderer reducer (`sessionStore.ts`) folds `CcEvent`s into an ordered
`TranscriptItem[]`. `block_id = \`${messageId}#${index}\`` ties index-only deltas
to a stable, unique block.

---

## 5. Session persistence & history

The SDK persists each session as JSONL under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. We never parse those files
by hand:

- `SessionManager.listSessions(cwd)` → `sdk.listSessions({ dir })`.
- `SessionManager.loadHistory({ sessionId, cwd })` → `sdk.getSessionMessages()`,
  then `historyToItems()` rebuilds the same `TranscriptItem[]` view model.

Reopening a session loads its history (re-rendered from JSONL) and starts a new
adapter with `resume: sessionId`, so the conversation continues seamlessly.

---

## 6. ESM/CJS bridge (a real constraint, solved)

The Agent SDK ships **ESM-only** (`sdk.mjs`). The Electron main bundle is
CommonJS. `src/main/backend/sdk.ts` loads it with a genuine runtime dynamic
import hidden from esbuild:

```ts
const dynamicImport = new Function('s', 'return import(s)')
```

Without the `new Function` wrapper, esbuild rewrites `import()` into a `require()`
helper and crashes on the ESM-only package. The SDK is `externalize`d in
`electron.vite.config.ts` so it resolves from `node_modules` at runtime. Verified:
`query`, `listSessions`, `getSessionMessages` all load in the CJS runtime.

---

## 7. Auth — subscription-only (enforced)

This app **does not support API-key billing**. `src/main/subscriptionAuth.ts`
defines the billing vectors (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) and `subscriptionOnlyEnv()`
returns a copy of `process.env` with all of them removed.

The adapter passes that via the SDK's `env` option, which **replaces the
subprocess environment entirely** — so the Claude Code subprocess literally
cannot see an API key, and the only auth path left is the logged-in `claude` CLI
subscription. There is no setting to turn this off.

`detectAuth()` always reports `subscription`; if any billing var was present in
the environment, the status bar badge shows `✓ subscription · key ignored` and
the detail explains it's being stripped. Verified empirically: with no key set,
the SDK's init message reports `apiKeySource: none` (subscription), never
`user`/`org`/`temporary` (API key).

---

## 8. Dev / browser testing aid (`devApiMock.ts`)

When the renderer is opened in a plain browser (no Electron preload), a mock
`window.api` is installed that scripts a realistic streamed session (text,
thinking, tool_use, permission, tool_result). This makes the React/DOM rendering
testable in Chrome without a backend. Inside Electron the preload provides the
real `window.api` and the mock is inert.

---

## 9. Roadmap

- **Phase 2** — session sidebar; multiple concurrent sessions, each in its own
  git worktree (created in `SessionManager.start`, cleaned up on close);
  per-session status + attention indicators. The adapter and IPC contract
  already key everything by `localId`, so this is additive.
- **Phase 3** — rich diff viewer, slash commands, @-file autocomplete, image
  paste, worktree review/merge flow, full history browser.
