import { useState } from 'react'
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
  /** Start a new chat inside an already-open workspace, no picker. */
  onNewInWorkspace: (cwd: string, provider: BackendProvider) => void
  /** Workspaces (by cwd) the user has hidden — moved to the Hidden section. */
  hiddenWorkspaces: string[]
  /** Hide a whole workspace (cwd) — drops it into the Hidden section. */
  onHideWorkspace: (cwd: string) => void
  /** Reopen a hidden workspace, restoring its non-archived sessions. */
  onOpenWorkspace: (cwd: string) => void
  width: number
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
  onNewInWorkspace,
  hiddenWorkspaces,
  onHideWorkspace,
  onOpenWorkspace,
  width
}: Props) {
  const [showArchived, setShowArchived] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const isHidden = (cwd: string): boolean => hiddenWorkspaces.includes(cwd)
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

  return (
    <div
      style={{ width }}
      className="shrink-0 flex flex-col border-r border-ink-800 bg-ink-900/60"
    >
      <div className="app-drag h-11 flex items-center px-3 border-b border-ink-800">
        <div className="w-16" />
        <button
          onClick={onNew}
          title="Open another workspace"
          className="no-drag ml-auto px-2.5 py-1 rounded-lg bg-accent hover:bg-[#5b97f5] text-ink-950 text-[12px] font-semibold transition-colors"
        >
          + Workspace
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {groups.map((g) => (
          <div key={g.cwd} className="space-y-1">
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
                onClick={() => onNewInWorkspace(g.cwd, g.provider)}
                title="New chat in this workspace"
                className="shrink-0 text-ink-400 hover:text-ink-100 px-1.5 leading-none text-[15px] rounded hover:bg-ink-800 transition-colors"
              >
                +
              </button>
              <button
                onClick={() => onHideWorkspace(g.cwd)}
                title="Hide this workspace"
                className="shrink-0 opacity-0 group-hover/ws:opacity-100 text-ink-400 hover:text-ink-100 px-1 leading-none text-[12px] rounded hover:bg-ink-800 transition-opacity"
              >
                ⊘
              </button>
            </div>
            {g.tabs.map((tab) => (
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
            ))}
          </div>
        ))}
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
