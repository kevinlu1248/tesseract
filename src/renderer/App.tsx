import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthInfo, BackendProvider, SessionStatus } from '../shared/ipc'
import { CommandPalette, type Command } from './components/CommandPalette'
import { ConversationView } from './components/ConversationView'
import { Pane } from './components/Pane'
import { PaneTree } from './components/PaneTree'
import { Sidebar } from './components/Sidebar'
import { StartScreen } from './components/StartScreen'
import { useWorkspace } from './state/useWorkspace'
import { paneIds, pruneTree } from './state/workspaceStore'

export function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null)
  // Command palette overlay (⌘K / ⌘⇧P).
  const [paletteOpen, setPaletteOpen] = useState(false)
  const ws = useWorkspace()
  const { state, restoring } = ws

  // The layout tree to render, pruned to leaves whose tab+session still exist —
  // so a closed/deleted session never leaves a blank pane. Splits collapse
  // automatically as leaves drop out (see pruneTree).
  const liveTree = pruneTree(
    state.panes,
    (id) => state.tabs.some((t) => t.localId === id) && Boolean(state.sessions[id])
  )
  const liveIds = paneIds(liveTree)
  const multiPane = liveIds.length > 1
  const firstPaneId = liveIds[0]

  // Sidebar width (px), drag the divider to resize; persisted across reloads.
  const MIN_SIDEBAR = 180
  const MAX_SIDEBAR = 560
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sidebarWidth'))
    return Number.isFinite(saved) && saved > 0
      ? Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, saved))
      : 256
  })
  // Collapsed sidebar shrinks to a thin rail; persisted across reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === '1'
  )
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v
      localStorage.setItem('sidebarCollapsed', next ? '1' : '0')
      return next
    })
  }, [])
  const resizing = useRef(false)

  useEffect(() => {
    window.api.getAuth().then(setAuth).catch(() => undefined)
  }, [])

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      if (!resizing.current) return
      const w = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, ev.clientX))
      setSidebarWidth(w)
    }
    const onUp = (): void => {
      resizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSidebarWidth((w) => {
        localStorage.setItem('sidebarWidth', String(w))
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Opening a workspace surfaces all of its recent conversations as lazy tabs
  // (and starts a fresh one if it has none) — see useWorkspace.openWorkspace.
  const startNew = useCallback(
    (cwd: string, yolo: boolean, provider: BackendProvider) => {
      void ws.openWorkspace(cwd, yolo, provider)
    },
    [ws]
  )

  // Pick a repo folder and open it directly — no prompt. The workspace's recent
  // conversations are surfaced automatically by openWorkspace.
  const pickAndOpen = useCallback(async () => {
    const dir = await window.api.pickRepo()
    if (dir) void ws.openWorkspace(dir)
  }, [ws])

  // New chat in an already-open workspace: skip the picker entirely and begin
  // immediately in that cwd (yolo on by default, matching ws.begin).
  const startNewInWorkspace = useCallback(
    (cwd: string, provider: BackendProvider = 'claude') => {
      void ws.begin({ cwd, provider, yolo: true })
    },
    [ws]
  )

  // Create a git worktree off a workspace and open a session seeded with the
  // task prompt. Surfaces failures (not a git repo, git missing) to the user.
  const createWorktree = useCallback(
    async (cwd: string, prompt: string, provider: BackendProvider = 'claude') => {
      try {
        await ws.createWorktree(cwd, prompt, provider)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        window.alert(`Couldn't create worktree:\n\n${message}`)
      }
    },
    [ws]
  )

  const resume = useCallback(
    async (cwd: string, sessionId: string, yolo: boolean, provider: BackendProvider) => {
      const items = await window.api
        .loadHistory({ sessionId, cwd, provider })
        .catch(() => [])
      void ws.begin({ cwd, provider, resumeSessionId: sessionId, yolo }, items)
    },
    [ws]
  )

  // Esc interrupts the focused session.
  // Cmd/Ctrl+T opens a new pane in the active session's workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // ⌘K or ⌘⇧P toggles the command palette.
      if (
        (e.metaKey || e.ctrlKey) &&
        ((e.key === 'k' || e.key === 'K') || (e.shiftKey && (e.key === 'p' || e.key === 'P')))
      ) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // While the palette is open it owns the keyboard (Esc/↑/↓/Enter).
      if (paletteOpen) return
      if (e.key === 'Escape' && state.activeId) ws.interrupt(state.activeId)
      if ((e.metaKey || e.ctrlKey) && (e.key === 't' || e.key === 'T')) {
        const tab = state.tabs.find((t) => t.localId === state.activeId)
        if (tab) {
          e.preventDefault()
          ws.newPane(tab.cwd, tab.provider)
        }
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.activeId, state.tabs, ws, toggleSidebar, paletteOpen])

  // ⌘W closes the focused pane; when it's the last remaining one, closes the
  // tab instead — never the whole app. The native window-close shortcut is
  // intercepted in the main process (it would otherwise quit before any
  // renderer keydown fires) and forwarded here as a request.
  useEffect(() => {
    return window.api.onClosePaneRequest(() => {
      if (!state.activeId) return
      if (multiPane) ws.closePane(state.activeId)
      else ws.closeTab(state.activeId)
    })
  }, [state.activeId, multiPane, ws])

  // Commands surfaced in the ⌘K / ⌘⇧P palette. Built from the active tab and
  // the list of open sessions; entries disable themselves when not applicable.
  const commands = useMemo<Command[]>(() => {
    const activeTab = state.tabs.find((t) => t.localId === state.activeId)
    const hasActive = Boolean(activeTab && state.activeId)
    const list: Command[] = [
      {
        id: 'new-chat',
        title: 'New Chat in Workspace',
        subtitle: activeTab?.cwd,
        group: 'General',
        keywords: 'create session tab pane',
        shortcut: '⌘T',
        enabled: hasActive,
        run: () => activeTab && ws.newPane(activeTab.cwd, activeTab.provider)
      },
      {
        id: 'add-pane-right',
        title: 'Add Pane Right',
        subtitle: activeTab?.cwd,
        group: 'Panes',
        keywords: 'split new session beside east horizontal',
        enabled: hasActive,
        run: () => activeTab && ws.newPane(activeTab.cwd, activeTab.provider, 'right')
      },
      {
        id: 'add-pane-left',
        title: 'Add Pane Left',
        subtitle: activeTab?.cwd,
        group: 'Panes',
        keywords: 'split new session beside west horizontal',
        enabled: hasActive,
        run: () => activeTab && ws.newPane(activeTab.cwd, activeTab.provider, 'left')
      },
      {
        id: 'add-pane-down',
        title: 'Add Pane Down',
        subtitle: activeTab?.cwd,
        group: 'Panes',
        keywords: 'split new session below bottom vertical stack',
        enabled: hasActive,
        run: () => activeTab && ws.newPane(activeTab.cwd, activeTab.provider, 'bottom')
      },
      {
        id: 'add-pane-up',
        title: 'Add Pane Up',
        subtitle: activeTab?.cwd,
        group: 'Panes',
        keywords: 'split new session above top vertical stack',
        enabled: hasActive,
        run: () => activeTab && ws.newPane(activeTab.cwd, activeTab.provider, 'top')
      },
      {
        id: 'open-workspace',
        title: 'Open Workspace…',
        group: 'General',
        keywords: 'pick repo folder directory new project',
        run: () => void pickAndOpen()
      },
      {
        id: 'create-worktree',
        title: 'Create Git Worktree…',
        subtitle: activeTab?.cwd,
        group: 'General',
        keywords: 'branch git parallel',
        enabled: hasActive,
        run: () => {
          if (!activeTab) return
          const prompt = window.prompt('Task for the new worktree session:')
          if (prompt && prompt.trim()) {
            void createWorktree(activeTab.cwd, prompt.trim(), activeTab.provider)
          }
        }
      },
      {
        id: 'toggle-sidebar',
        title: sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar',
        group: 'General',
        keywords: 'collapse expand panel',
        shortcut: '⌘B',
        run: toggleSidebar
      },
      {
        id: 'interrupt',
        title: 'Interrupt Session',
        group: 'Session',
        keywords: 'stop cancel escape abort',
        shortcut: '⎋',
        enabled: hasActive,
        run: () => state.activeId && ws.interrupt(state.activeId)
      },
      {
        id: 'clear-session',
        title: 'Clear Session',
        group: 'Session',
        keywords: 'reset wipe transcript fresh new',
        enabled: hasActive,
        run: () => state.activeId && ws.clearSession(state.activeId)
      },
      {
        id: 'archive-tab',
        title: 'Archive Tab',
        group: 'Session',
        keywords: 'hide tuck',
        enabled: hasActive,
        run: () => state.activeId && ws.archive(state.activeId)
      },
      {
        id: 'close-tab',
        title: 'Close Tab',
        group: 'Session',
        keywords: 'remove quit',
        enabled: hasActive,
        run: () => state.activeId && ws.closeTab(state.activeId)
      },
      {
        id: 'restart-app',
        title: 'Restart App',
        group: 'App',
        keywords: 'reload relaunch',
        run: () => window.api.restartApp()
      }
    ]
    // One "Switch to…" entry per non-archived tab that isn't already active.
    for (const t of state.tabs) {
      if (t.archived || t.localId === state.activeId) continue
      list.push({
        id: `switch-${t.localId}`,
        title: `Switch to: ${t.title}`,
        subtitle: t.cwd,
        group: 'Switch to session',
        keywords: 'tab session focus go to',
        run: () => ws.setActive(t.localId)
      })
    }
    return list
  }, [state.tabs, state.activeId, ws, sidebarCollapsed, toggleSidebar, createWorktree, pickAndOpen])

  // Startup restore is still bringing saved tabs back — show a quiet loading
  // state rather than flashing the launcher (which would look like a "new /
  // resume session" prompt on every restart).
  if (restoring && state.tabs.length === 0) {
    return (
      <div className="h-full grid place-items-center text-ink-500 text-sm">
        Restoring your workspace…
      </div>
    )
  }

  // No sessions to restore → full-screen launcher.
  if (state.tabs.length === 0) {
    return <StartScreen onNew={startNew} onResume={resume} />
  }

  const statuses: Record<string, SessionStatus> = {}
  for (const [id, s] of Object.entries(state.sessions)) statuses[id] = s.status

  return (
    <div className="h-full flex">
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <Sidebar
        tabs={state.tabs}
        statuses={statuses}
        activeId={state.activeId}
        onSelect={ws.setActive}
        onUnarchive={ws.unarchive}
        onClose={ws.closeTab}
        onDelete={ws.deleteTab}
        onNew={() => void pickAndOpen()}
        onRestart={() => window.api.restartApp()}
        onNewInWorkspace={startNewInWorkspace}
        onCreateWorktree={createWorktree}
        hiddenWorkspaces={state.hiddenWorkspaces}
        onHideWorkspace={ws.hideWorkspace}
        onOpenWorkspace={ws.openWorkspace}
        paneGroup={multiPane ? liveIds : []}
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />

      {!sidebarCollapsed && (
        <div
          onMouseDown={startResize}
          title="Drag to resize sidebar"
          className="w-1 shrink-0 cursor-col-resize bg-ink-800 hover:bg-accent transition-colors"
        />
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {liveTree ? (
          <div className="flex-1 min-h-0 flex">
            <PaneTree
              node={liveTree}
              onResize={ws.resizePane}
              renderLeaf={(id) => {
                const tab = state.tabs.find((t) => t.localId === id)
                const session = state.sessions[id]
                if (!tab || !session) return null
                return (
                  <Pane
                    key={id}
                    focused={id === state.activeId}
                    split={multiPane}
                    onFocus={() => {
                      if (id !== state.activeId) ws.setActive(id)
                    }}
                    onDropTab={(draggedId, side) => ws.splitPane(draggedId, id, side)}
                  >
                    <ConversationView
                      auth={auth}
                      session={session}
                      tab={tab}
                      onSend={(text, images) => ws.send(id, text, images)}
                      onEditMessage={(messageId, text, images) =>
                        void ws.editAndRewind(id, messageId, text, images)
                      }
                      onDraftChange={(text, images) => ws.setDraft(id, text, images)}
                      onInterrupt={() => ws.interrupt(id)}
                      onUnqueue={(index) => ws.unqueue(id, index)}
                      onClose={() => ws.closeTab(id)}
                      onClosePane={multiPane ? () => ws.closePane(id) : undefined}
                      onNewPane={() => ws.newPane(tab.cwd, tab.provider)}
                      onClear={() => ws.clearSession(id)}
                      onResumeConversation={(sessionId) =>
                        resume(tab.cwd, sessionId, true, tab.provider)
                      }
                      onClearError={() => ws.clearError(id)}
                      onDismissContextLost={() => ws.dismissContextLost(id)}
                      onAnswerPermission={(requestId, decision) =>
                        ws.answerPermission(id, requestId, decision)
                      }
                      onAnswerQuestion={(requestId, answer) =>
                        ws.answerQuestion(id, requestId, answer)
                      }
                      onShowSidebar={
                        sidebarCollapsed && id === firstPaneId ? toggleSidebar : undefined
                      }
                    />
                  </Pane>
                )
              }}
            />
          </div>
        ) : (
          <div className="flex-1 grid place-items-center text-ink-500 text-sm">
            Select a session from the sidebar.
          </div>
        )}
      </div>
    </div>
  )
}
