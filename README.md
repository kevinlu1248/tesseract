# Tesseract

A desktop GUI for running **Claude Code**, in the spirit of Superset — with
one defining difference: **agent output is rendered as HTML/React DOM, never in a
terminal emulator**. No xterm.js, no PTY in the display path. Structured agent
events map to React components, and the prompt is a real DOM `<textarea>` so all
native text editing (`ctrl+A`, `option+arrow`, word-delete, …) works for free.

![phase](https://img.shields.io/badge/phase-1%20complete-brightgreen)

## Quick start

```bash
git clone https://github.com/kevinlu1248/tesseract.git
cd tesseract
npm install          # first time only
npm run dev          # start the app (launches Electron + Vite dev server)
```

Make sure the `claude` CLI is logged in first (`claude` in a terminal, sign in
with your subscription). To use the Codex backend, log in with `codex login`.
See [Requirements](#requirements).

## Features

- Open a repo, start a Claude Code or Codex session, send a prompt from a DOM
  textarea.
- Streaming React transcript: **markdown** (syntax-highlighted code), **tool_use**
  as collapsible cards, **tool_result** cards, and **thinking** blocks — all fed
  by partial-token deltas, never blocking the UI.
- **AskUserQuestion** rendered as a collapsible card showing each question, its
  options, and the answer you picked.
- Inline **permission** approve/deny prompts wired to the SDK's `canUseTool`.
- **Interrupt** a running turn (Esc or Stop).
- **Clear conversation** in place — wipe a tab's transcript and start a fresh
  thread without losing the pane.
- **Persistence**: list prior sessions for a repo and reopen one — the
  conversation is re-rendered from its JSONL history and resumes. Recent-session
  cards show AI-generated summaries, loaded lazily as you scroll.
- **Codex backend**: choose Codex from the launcher to run `codex exec --json`;
  Codex threads are listed from `~/.codex/sessions` and resume by thread id.
- **Subscription-only (enforced)**: never uses API-key billing. All API-billing
  env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock/Vertex toggles)
  are stripped from the Claude Code subprocess, so the only auth path is your
  logged-in `claude` subscription. If a key is present it's shown as ignored.

### Multi-pane workspace

- **Split panes**: drag a session tab from the sidebar to a pane's edge (left,
  right, top, bottom) to tile it alongside the current one. Panes nest
  arbitrarily into rows and columns, are resizable by dragging the divider, and
  the layout persists across restarts.
- The focused pane shows an accent ring; click any pane to focus it. The sidebar
  groups sessions that are currently shown together as panes.
- A recent-screenshot suggestion added or dismissed in one pane disappears across
  all panes at once.

### Worktree-backed sessions

- Click the git-branch icon (⎇) next to a workspace, describe a task, and the app
  creates a new branch (slugified from the task), checks it out in a git worktree
  under `.worktrees/<branch>`, and opens a fresh session there seeded with your
  task — so independent features run in parallel without touching your main
  working tree.

### Keyboard shortcuts

- **Esc** — interrupt the focused session.
- **Cmd/Ctrl+T** — new chat in the focused pane's workspace.
- **Cmd/Ctrl+B** — toggle the sidebar.

See [`architecture.md`](./architecture.md) for the full design.

## Requirements

- **Node** 18+ (developed on 22).
- **Claude Code CLI** logged in (`claude`). Run `claude` once in a terminal and
  sign in with your subscription. The app uses that session and is
  **subscription-only** — it never reads `ANTHROPIC_API_KEY` (any such key is
  stripped before the subprocess starts).
- **Codex CLI** logged in (`codex login`) for Codex sessions.

## Pinned versions

| Dependency | Version |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | `0.3.183` |
| `claude` CLI (tested) | `2.1.183` |
| `codex` CLI (tested) | `0.141.0` |
| Electron | `^31.3.0` |
| electron-vite | `^2.3.0` |
| React | `^18.3.1` |

The SDK message schema drifts between releases — it is pinned exactly, and all
parsing is centralized in `src/shared/schema.ts` (the one file to update on a
version bump).

## Develop

```bash
npm install
npm run dev          # launches Electron + Vite dev server with HMR
```

## Build

```bash
npm run build        # bundles main, preload, and renderer into out/
npm run preview      # run the production build
npm run typecheck    # strict TS for both the node and web sides
```

## Browser UI preview (no backend)

`npm run dev` also serves the renderer at `http://localhost:5273` (the port is
pinned). Opening that URL in a normal browser installs a mock backend that scripts
a realistic streamed session — handy for working on the UI without Electron.
Inside Electron the real backend is always used.

## Project layout

```
src/shared/   schema.ts (SDK schema + view model + translator), ipc.ts (contract)
src/main/     index.ts, ipc.ts, auth.ts, sessions/, backend/ (BackendAdapter + SDK)
src/preload/  contextBridge → window.api
src/renderer/ App, state/ (reducer + hook), components/ (one per block kind)
```

## Notes

- The backend lives behind a `BackendAdapter` interface, so the transport
  (Agent SDK today) is swappable without touching the UI.
- Errors — Claude Code crash, auth expiry, rate-limit / credit exhaustion — are
  classified and surfaced in the UI rather than hanging.
