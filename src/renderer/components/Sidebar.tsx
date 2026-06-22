import { useState } from 'react'
import { LuGitBranch, LuRotateCw } from 'react-icons/lu'
import type { BackendProvider, SessionStatus } from '../../shared/ipc'
import { dotFor, type DotState, type Tab } from '../state/workspaceStore'
import { TAB_DND_MIME } from './Pane'

interface Props {
  tabs: Tab[]
  statuses: Record<string, SessionStatus>
  activeId: string | null
  onSelect: (localId: string) => void
  onUnarchive: (localId: string) => void
  /** Close a live tab — tucks it into the collapsed Archived section. */
  onClose: (localId: string) => void
  /** Permanently remove an archived tab (tears down its session). */
  onDelete: (localId: string) => void
  /** Open the picker to add a brand-new workspace (repo). */
  onNew: () => void
  /** Restart the whole app — frontend + backend. */
  onRestart: () => void
  /** Start a new chat inside an already-open workspace, no picker. */
  onNewInWorkspace: (cwd: string, provider: BackendProvider) => void
  /** Create a git worktree off a workspace and open a session in it. */
  onCreateWorktree: (cwd: string, prompt: string, provider: BackendProvider) => void
  /** Workspaces (by cwd) the user has hidden — moved to the Hidden section. */
  hiddenWorkspaces: string[]
  /** Hide a whole workspace (cwd) — drops it into the Hidden section. */
  onHideWorkspace: (cwd: string) => void
  /** Reopen a hidden workspace, restoring its non-archived sessions. */
  onOpenWorkspace: (cwd: string) => void
  /**
   * The localIds currently combined into the split view, in pane order. When
   * two or more, the sidebar pulls them out of their workspace groups and shows
   * them together as a single "folder" reflecting the active split.
   */
  paneGroup: string[]
  width: number
  /** When true, the sidebar collapses to a thin rail with just an expand button. */
  collapsed: boolean
  /** Toggle the collapsed state. */
  onToggleCollapse: () => void
}

const DOT_COLOR: Record<Exclude<DotState, 'none'>, string> = {
  running: '#f0b429', // yellow — actively streaming
  unread: '#7ee787' // green — done with unread output
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function Dot({ state }: { state: DotState }) {
  if (state === 'none') return <span className="inline-block w-2 h-2 shrink-0" />
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${state === 'running' ? 'pulse' : ''}`}
      style={{ background: DOT_COLOR[state] }}
      title={state === 'running' ? 'Running' : 'Done · unread'}
    />
  )
}

function TabRow({
  tab,
  status,
  active,
  onSelect,
  onUnarchive,
  onClose,
  onDelete,
  archived,
  showCwd
}: {
  tab: Tab
  status: SessionStatus
  active: boolean
  archived: boolean
  /** Archived rows live outside their workspace group, so they show the cwd. */
  showCwd: boolean
  onSelect: (id: string) => void
  onUnarchive: (id: string) => void
  onClose: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div
      onClick={() => onSelect(tab.localId)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_DND_MIME, tab.localId)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title="Drag into the conversation area to open a split pane"
      className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
        active ? 'bg-ink-700' : 'hover:bg-ink-800'
      }`}
    >
      <Dot state={dotFor(status, tab.unread)} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-ink-100 truncate">{tab.title}</div>
        {(showCwd || tab.queued.length > 0) && (
          <div className="text-[11px] text-ink-500 truncate font-mono">
            {showCwd && basename(tab.cwd)}
            {tab.queued.length > 0 && (
              <span className="text-accent">
                {showCwd ? ' · ' : ''}
                {tab.queued.length} queued
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
        {archived && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onUnarchive(tab.localId)
            }}
            title="Restore"
            className="text-ink-400 hover:text-ink-100 px-1.5 py-0.5 text-[12px]"
          >
            ↥
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            archived ? onDelete(tab.localId) : onClose(tab.localId)
          }}
          title={archived ? 'Delete permanently' : 'Close (move to Archived)'}
          className="text-ink-400 hover:text-red-300 px-1.5 py-0.5 text-[12px]"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/**
 * Inline prompt shown under a workspace header when the user clicks the
 * worktree button. They describe the task; the branch name is derived from it
 * server-side and a session opens in the new worktree, seeded with the prompt.
 */
function WorktreeComposer({
  onSubmit,
  onCancel
}: {
  onSubmit: (prompt: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const submit = (): void => {
    const value = text.trim()
    if (value) onSubmit(value)
  }
  return (
    <div className="px-1.5 pb-1">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        rows={2}
        placeholder="Describe the task — a worktree + branch are created from it…"
        className="w-full resize-none rounded-md bg-ink-800 border border-ink-700 px-2 py-1.5 text-[12px] text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-accent"
      />
      <div className="flex items-center gap-1.5 mt-1">
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="px-2 py-0.5 rounded-md bg-accent/90 hover:bg-accent text-ink-950 text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Create worktree
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-0.5 rounded-md text-ink-400 hover:text-ink-100 text-[11px] transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

interface WorkspaceGroup {
  cwd: string
  provider: BackendProvider
  tabs: Tab[]
  /** Highest seq among the group's tabs — used to float active workspaces up. */
  recent: number
}

/** Group live tabs by workspace (cwd), most-recently-used workspace first. */
function groupByWorkspace(tabs: Tab[]): WorkspaceGroup[] {
  const map = new Map<string, Tab[]>()
  for (const t of tabs) {
    const key = `${t.provider}:${t.cwd}`
    const arr = map.get(key)
    if (arr) arr.push(t)
    else map.set(key, [t])
  }
  return [...map.values()]
    .map((ts) => ({
      cwd: ts[0].cwd,
      provider: ts[0].provider,
      tabs: ts.slice().sort((a, b) => a.seq - b.seq),
      recent: Math.max(...ts.map((t) => t.seq))
    }))
    .sort((a, b) => b.recent - a.recent)
}

export function Sidebar({
  tabs,
  statuses,
  activeId,
  onSelect,
  onUnarchive,
  onClose,
  onDelete,
  onNew,
  onRestart,
  onNewInWorkspace,
  onCreateWorktree,
  hiddenWorkspaces,
  onHideWorkspace,
  onOpenWorkspace,
  paneGroup,
  width,
  collapsed,
  onToggleCollapse
}: Props) {
  const [showArchived, setShowArchived] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  // The workspace group (keyed by `provider:cwd`) whose worktree prompt is open.
  const [worktreeFor, setWorktreeFor] = useState<string | null>(null)
  const isHidden = (cwd: string): boolean => hiddenWorkspaces.includes(cwd)
  // Sessions currently combined into the split (2+ panes) stay in their normal
  // workspace group but are clustered together with an accent bar — see the
  // group render below. A single pane is just the normal full view, not a group.
  const grouped = paneGroup.length > 1
  const paneSet = new Set(paneGroup)
  // Pane (visual) order, so the cluster lists its members left→right / top→bottom.
  const paneOrder = new Map(paneGroup.map((id, i) => [id, i]))
  // Hidden workspaces (and everything in them) drop out of the visible groups
  // and the Archived list — they live only in the Hidden section below.
  const groups = groupByWorkspace(tabs.filter((t) => !t.archived && !isHidden(t.cwd)))
  const archived = tabs
    .filter((t) => t.archived && !isHidden(t.cwd))
    .sort((a, b) => b.seq - a.seq)
  // One entry per hidden workspace, with a count of its non-archived sessions.
  const hidden = hiddenWorkspaces.map((cwd) => ({
    cwd,
    count: tabs.filter((t) => t.cwd === cwd && !t.archived).length
  }))

  // Hidden: render nothing — App shows a floating reveal button instead.
  if (collapsed) return null

  return (
    <div
      style={{ width }}
      className="shrink-0 flex flex-col border-r border-ink-800 bg-ink-900/60"
    >
      <div className="app-drag h-11 flex items-center gap-2 px-3 border-b border-ink-800">
        <img src="/icon.svg" alt="Tesseract" className="w-5 h-5 rounded-md shrink-0" />
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar (⌘B)"
          className="no-drag text-ink-400 hover:text-ink-100 px-1.5 py-1 rounded-lg hover:bg-ink-800 text-[15px] leading-none transition-colors"
        >
          «
        </button>
        <button
          onClick={() => {
            if (window.confirm('Restart Tesseract? This closes all running sessions.')) onRestart()
          }}
          title="Restart the app (frontend + backend)"
          className="no-drag ml-auto grid place-items-center px-1.5 py-1 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-800 transition-colors"
        >
          <LuRotateCw size={14} aria-hidden />
        </button>
        <button
          onClick={onNew}
          title="Open another workspace"
          className="no-drag ml-1.5 px-2.5 py-1 rounded-lg bg-ink-700 hover:bg-ink-600 text-ink-100 text-[12px] font-semibold transition-colors"
        >
          + Workspace
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {groups.map((g) => {
          const groupKey = `${g.provider}:${g.cwd}`
          // Within a workspace, the sessions that are part of the current split
          // cluster together (in pane order) under an accent bar; the rest stay
          // as normal rows below them.
          const combined = grouped
            ? g.tabs
                .filter((t) => paneSet.has(t.localId))
                .sort((a, b) => (paneOrder.get(a.localId) ?? 0) - (paneOrder.get(b.localId) ?? 0))
            : []
          const rest = grouped ? g.tabs.filter((t) => !paneSet.has(t.localId)) : g.tabs
          const renderRow = (tab: Tab): JSX.Element => (
            <TabRow
              key={tab.localId}
              tab={tab}
              status={statuses[tab.localId] ?? 'idle'}
              active={tab.localId === activeId}
              archived={false}
              showCwd={false}
              onSelect={onSelect}
              onUnarchive={onUnarchive}
              onClose={onClose}
              onDelete={onDelete}
            />
          )
          return (
          <div key={groupKey} className="space-y-1">
            <div className="group/ws flex items-center gap-2 px-1.5 pt-1">
              <span
                className="flex-1 min-w-0 truncate text-[11px] uppercase tracking-wide text-ink-500 font-mono"
                title={g.cwd}
              >
                {basename(g.cwd)}
                <span className="ml-2 normal-case tracking-normal text-ink-600">
                  {g.provider === 'claude' ? 'Claude' : 'Codex'}
                </span>
              </span>
              <button
                onClick={() => setWorktreeFor((k) => (k === groupKey ? null : groupKey))}
                title="New worktree (branch off this workspace)"
                className={`shrink-0 px-1 grid place-items-center rounded hover:bg-ink-800 transition-colors ${
                  worktreeFor === groupKey ? 'text-accent' : 'text-ink-400 hover:text-ink-100'
                }`}
              >
                <LuGitBranch size={13} aria-hidden />
              </button>
              <button
                onClick={() => onNewInWorkspace(g.cwd, g.provider)}
                title="New chat in this workspace"
                className="shrink-0 text-ink-400 hover:text-ink-100 px-1.5 leading-none text-[15px] rounded hover:bg-ink-800 transition-colors"
              >
                +
              </button>
              <button
                onClick={() => onHideWorkspace(g.cwd)}
                title="Hide this workspace"
                className="shrink-0 text-ink-400 hover:text-ink-100 px-1 leading-none text-[13px] rounded hover:bg-ink-800 transition-colors"
              >
                ×
              </button>
            </div>
            {worktreeFor === groupKey && (
              <WorktreeComposer
                onSubmit={(prompt) => {
                  setWorktreeFor(null)
                  onCreateWorktree(g.cwd, prompt, g.provider)
                }}
                onCancel={() => setWorktreeFor(null)}
              />
            )}
            {combined.length > 0 && (
              <div
                className="ml-0.5 pl-2 border-l-2 border-accent/40 space-y-1"
                title="Combined in the split view"
              >
                {combined.map(renderRow)}
              </div>
            )}
            {rest.map(renderRow)}
          </div>
          )
        })}
        {groups.length === 0 && (
          <div className="text-[12px] text-ink-500 italic px-2 py-3">No active sessions.</div>
        )}
      </div>

      {archived.length > 0 && (
        <div className="border-t border-ink-800 p-2">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full text-left text-[11px] uppercase tracking-wide text-ink-500 hover:text-ink-300 px-1.5 py-1"
          >
            {showArchived ? '▾' : '▸'} Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="space-y-1 mt-1">
              {archived.map((tab) => (
                <TabRow
                  key={tab.localId}
                  tab={tab}
                  status={statuses[tab.localId] ?? 'idle'}
                  active={tab.localId === activeId}
                  archived
                  showCwd
                  onSelect={onSelect}
                  onUnarchive={onUnarchive}
                  onClose={onClose}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {hidden.length > 0 && (
        <div className="border-t border-ink-800 p-2">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="w-full text-left text-[11px] uppercase tracking-wide text-ink-500 hover:text-ink-300 px-1.5 py-1"
          >
            {showHidden ? '▾' : '▸'} Hidden ({hidden.length})
          </button>
          {showHidden && (
            <div className="space-y-1 mt-1">
              {hidden.map((h) => (
                <div
                  key={h.cwd}
                  onClick={() => onOpenWorkspace(h.cwd)}
                  title={`Reopen ${h.cwd}`}
                  className="group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer hover:bg-ink-800 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-ink-100 truncate font-mono">
                      {basename(h.cwd)}
                    </div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {h.count} session{h.count === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenWorkspace(h.cwd)
                    }}
                    title="Reopen workspace"
                    className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-ink-100 px-1.5 py-0.5 text-[12px] transition-opacity"
                  >
                    ↥
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
