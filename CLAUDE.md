# CLAUDE.md

## What this project is

This is **Claude Workspace** — a desktop app (Electron + Vite + React) that is a
**custom frontend / GUI for Claude Code**. It runs Claude Code via the
`@anthropic-ai/claude-agent-sdk` and renders the agent's streamed events as
**HTML/React DOM** — not in a terminal emulator (no xterm.js, no PTY in the
display path).

**Important context for agents working here:** when the user talks about UI/UX
behavior — how tool calls render, collapsible blocks, what's shown on screen,
verbosity, click-to-expand, etc. — they are almost always describing a
**feature to build in THIS app's renderer**, NOT a setting in the Claude Code
CLI/harness. Treat such requests as frontend work in `src/renderer/`, not as
harness configuration. Do not reply that something "isn't configurable in
Claude Code" — we control the entire UI here.

## Where the UI lives

- `src/renderer/components/` — one component per transcript block kind:
  - `ToolUseCard.tsx` — renders a tool call
  - `ToolResultCard.tsx` — renders a tool result
  - `Disclosure.tsx` — collapsible/expand primitive
  - `Transcript.tsx`, `ConversationView.tsx`, `MessageView.tsx` — transcript layout
  - `ThinkingBlock.tsx`, `MarkdownText.tsx`, `CodeDiff.tsx`, `SubagentCard.tsx`,
    `PermissionPrompt.tsx`, `Composer.tsx`, `Sidebar.tsx`, etc.
- `src/renderer/state/` — reducer + hook driving the view model.
- `src/shared/schema.ts` — SDK message schema + view-model translator (the one
  file to update on an SDK version bump).
- `src/shared/ipc.ts` — IPC contract between main and renderer.
- `src/main/` — Electron main, `backend/` (BackendAdapter + SDK), `sessions/`,
  `auth.ts`.

## Example request → where it maps

> "Combine each tool call + its result into one collapsible block; show the
> first line + output, expand the rest on click."

That's a renderer change: pair/merge `ToolUseCard` + `ToolResultCard` (likely in
`Transcript.tsx`/`ConversationView.tsx`) into a single `Disclosure`-wrapped
block. It is **not** a Claude Code CLI setting.

## Dev / build

```bash
npm run dev          # Electron + Vite dev server (HMR); also serves renderer at http://localhost:5273
npm run build        # bundle main + preload + renderer into out/
npm run typecheck    # strict TS for node + web sides
```

`http://localhost:5273` in a normal browser uses a mock backend (scripted
streamed session) — useful for UI work without Electron.

See `README.md` and `architecture.md` for the full design.
