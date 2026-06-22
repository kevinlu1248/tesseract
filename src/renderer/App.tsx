import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthInfo, BackendProvider, SessionStatus } from '../shared/ipc'
import { ConversationView } from './components/ConversationView'
import { Pane } from './components/Pane'
import { PaneTree } from './components/PaneTree'
import { Sidebar } from './components/Sidebar'
import { StartScreen } from './components/StartScreen'
import { useWorkspace } from './state/useWorkspace'
import { paneIds, pruneTree } from './state/workspaceStore'

export function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null)
  // Showing the repo picker to open an additional tab (vs. the active session).
  const [picking, setPicking] = useState(false)
  const ws = useWorkspace()
  const { state } = ws

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

  // Opening a workspace re-opens all of its previous non-archived sessions
  // (and starts a fresh one if it has none) — see useWorkspace.openWorkspace.
  const startNew = useCallback(
    (cwd: string, yolo: boolean, provider: BackendProvider) => {
      setPicking(false)
      ws.openWorkspace(cwd, yolo, provider)
    },
    [ws]
  )

  // New chat in an already-open workspace: skip the picker entirely and begin
  // immediately in that cwd (yolo on by default, matching ws.begin).
  const startNewInWorkspace = useCallback(
    (cwd: string, provider: BackendProvider = 'claude') => {
      setPicking(false)
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
      setPicking(false)
      const items = await window.api
        .loadHistory({ sessionId, cwd, provider })
        .catch(() => [])
      void ws.begin({ cwd, provider, resumeSessionId: sessionId, yolo }, items)
    },
    [ws]
  )

  // Esc interrupts the focused session.
  // Cmd/Ctrl+T opens a new chat in the active session's workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state.activeId) ws.interrupt(state.activeId)
      if ((e.metaKey || e.ctrlKey) && (e.key === 't' || e.key === 'T')) {
        const tab = state.tabs.find((t) => t.localId === state.activeId)
        if (tab) {
          e.preventDefault()
          startNewInWorkspace(tab.cwd, tab.provider)
        }
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.activeId, state.tabs, ws, startNewInWorkspace, toggleSidebar])

  // No sessions yet → full-screen launcher.
  if (state.tabs.length === 0) {
    return <StartScreen onNew={startNew} onResume={resume} />
  }

  const statuses: Record<string, SessionStatus> = {}
  for (const [id, s] of Object.entries(state.sessions)) statuses[id] = s.status

  return (
    <div className="h-full flex">
      <Sidebar
        tabs={state.tabs}
        statuses={statuses}
        activeId={state.activeId}
        onSelect={ws.setActive}
        onUnarchive={ws.unarchive}
        onClose={ws.closeTab}
        onDelete={ws.deleteTab}
        onNew={() => setPicking(true)}
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
        {picking ? (
          <StartScreen onNew={startNew} onResume={resume} onCancel={() => setPicking(false)} />
        ) : liveTree ? (
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
