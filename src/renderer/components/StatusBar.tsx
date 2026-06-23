import type { AuthInfo, SessionStatus } from '../../shared/ipc'
import { contextWindowFor, formatTokens } from '../../shared/schema'
import { TAB_DND_MIME } from './Pane'

const STATUS_META: Record<SessionStatus, { label: string; color: string; pulse?: boolean }> = {
  starting: { label: 'Starting', color: '#7b8699', pulse: true },
  idle: { label: 'Idle', color: '#7ee787' },
  connecting: { label: 'Connecting', color: '#6ea8fe', pulse: true },
  running: { label: 'Running', color: '#6ea8fe', pulse: true },
  'awaiting-permission': { label: 'Awaiting permission', color: '#f0b429', pulse: true },
  interrupted: { label: 'Interrupted', color: '#f0883e' },
  error: { label: 'Error', color: '#ff9492' },
  exited: { label: 'Exited', color: '#7b8699' },
  suspended: { label: 'Suspended', color: '#566175' }
}

interface Props {
  status: SessionStatus
  auth: AuthInfo | null
  model?: string
  cwd?: string
  contextTokens?: number
  onClose: () => void
  /** When set, this pane is part of a split — show a "remove from split" button. */
  onClosePane?: () => void
  /** Open a new session beside this pane as a split. */
  onNewPane?: () => void
  /** Wipe this pane's conversation and replace it with a fresh, blank one. */
  onClear?: () => void
  /** Present only on the leftmost pane while the sidebar is hidden — reveals it. */
  onShowSidebar?: () => void
  /**
   * When set (i.e. this pane is part of a split), the status bar becomes a drag
   * handle for repositioning the pane: dragging it onto another pane's left/right
   * half moves this session there. The value is the pane's session `localId`.
   */
  reorderId?: string
}

// macOS uses an inset title bar (hiddenInset), so when the sidebar is hidden the
// leftmost status bar must leave room for the traffic lights at the top-left.
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

// Warm/red as the window fills; calm gray-blue while there's headroom.
function gaugeColor(pct: number): string {
  if (pct >= 90) return '#ff9492'
  if (pct >= 70) return '#f0b429'
  return '#6ea8fe'
}

function ContextGauge({ tokens, model }: { tokens: number; model?: string }) {
  const window = contextWindowFor(model)
  const pct = Math.min(100, (tokens / window) * 100)
  const color = gaugeColor(pct)
  return (
    <span
      className="no-drag flex items-center gap-1.5 text-ink-400 font-mono"
      title={`Context: ${formatTokens(tokens)} / ${formatTokens(window)} tokens (${pct.toFixed(
        pct < 10 ? 1 : 0
      )}%)`}
    >
      <span className="relative inline-block w-14 h-1.5 rounded-full bg-ink-800 overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${Math.max(pct, 2)}%`, background: color }}
        />
      </span>
      <span style={{ color }}>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
    </span>
  )
}

export function StatusBar({
  status,
  model,
  cwd,
  contextTokens,
  onClose,
  onClosePane,
  onNewPane,
  onClear,
  onShowSidebar,
  reorderId
}: Props) {
  const meta = STATUS_META[status]
  const reorderable = reorderId != null
  return (
    <div
      // While split, the bar is a pane-reorder drag source (and thus `no-drag`,
      // since `-webkit-app-region: drag` would otherwise swallow the HTML5 drag);
      // a lone pane keeps `app-drag` so the bar still moves the OS window.
      draggable={reorderable}
      onDragStart={
        reorderable
          ? (e) => {
              e.dataTransfer.setData(TAB_DND_MIME, reorderId)
              e.dataTransfer.effectAllowed = 'move'
            }
          : undefined
      }
      title={reorderable ? 'Drag to reposition this pane' : undefined}
      className={`${
        reorderable ? 'no-drag cursor-grab active:cursor-grabbing' : 'app-drag'
      } flex items-center gap-3 px-4 h-11 border-b border-ink-800 bg-ink-900/90 text-[12px] select-none`}
      style={onShowSidebar && IS_MAC ? { paddingLeft: 76 } : undefined}
    >
      {onShowSidebar && (
        <button
          onClick={onShowSidebar}
          title="Show sidebar (⌘B)"
          className="no-drag -ml-1 text-ink-400 hover:text-ink-100 px-1.5 py-1 rounded-lg hover:bg-ink-800 text-[15px] leading-none transition-colors"
        >
          »
        </button>
      )}
      <div className="flex items-center gap-2 no-drag">
        <span
          className={`inline-block w-2 h-2 rounded-full ${meta.pulse ? 'pulse' : ''}`}
          style={{ background: meta.color }}
        />
        <span className="text-ink-300 font-medium">{meta.label}</span>
      </div>
      {cwd && (
        <span className="text-ink-500 truncate max-w-[280px] font-mono no-drag" title={cwd}>
          {cwd}
        </span>
      )}
      <div className="flex-1" />
      {contextTokens != null && contextTokens > 0 && (
        <ContextGauge tokens={contextTokens} model={model} />
      )}
      {model && (
        <span
          className="text-ink-400 font-mono no-drag truncate min-w-0 max-w-[180px] shrink"
          title={model}
        >
          {model}
        </span>
      )}
      {onClear && (
        <button
          onClick={onClear}
          className="no-drag text-ink-400 hover:text-ink-200 px-2 py-1 rounded hover:bg-ink-800"
          title="Clear conversation (start a fresh, blank one)"
        >
          ⌫
        </button>
      )}
      {onNewPane && (
        <button
          onClick={onNewPane}
          className="no-drag text-ink-400 hover:text-ink-200 px-2 py-1 rounded hover:bg-ink-800"
          title="Open a new pane beside this one"
        >
          ＋
        </button>
      )}
      {onClosePane && (
        <button
          onClick={onClosePane}
          className="no-drag text-ink-400 hover:text-ink-200 px-2 py-1 rounded hover:bg-ink-800"
          title="Remove from split (keeps the session open)"
        >
          ⊟
        </button>
      )}
      <button
        onClick={onClose}
        className="no-drag text-ink-400 hover:text-ink-200 px-2 py-1 rounded hover:bg-ink-800"
        title="Close session"
      >
        ✕
      </button>
    </div>
  )
}
