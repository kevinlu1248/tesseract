import { useState } from 'react'
import type { Side } from '../state/workspaceStore'

/**
 * The drag payload used when a sidebar tab is dragged into the main area. The
 * value is the tab's `localId`. Kept as a custom MIME type so panes only accept
 * our own drags (not files, text selections, etc.).
 */
export const TAB_DND_MIME = 'application/x-cw-tab'

interface Props {
  /** Whether this pane is the focused one (only ringed while in a split). */
  focused: boolean
  /** True when more than one pane is visible (enables the focus ring). */
  split: boolean
  onFocus: () => void
  /** Insert/move the dragged session next to this pane on the given side. */
  onDropTab: (draggedId: string, side: Side) => void
  children: React.ReactNode
}

function carriesTab(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TAB_DND_MIME)
}

/**
 * A single split-pane cell. Wraps one ConversationView, marks itself focused on
 * pointer-down, and acts as a drop target: dragging a sidebar tab toward any of
 * its four edges shows a drop indicator and drops insert the session on that
 * side — left/right tile side by side, top/bottom stack vertically.
 */
export function Pane({ focused, split, onFocus, onDropTab, children }: Props) {
  const [over, setOver] = useState<Side | null>(null)

  // Pick the nearest edge: whichever of the four normalized distances is
  // smallest decides the side, so the outer quarter of each edge drops there.
  const sideFor = (e: React.DragEvent): Side => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    const dist: Record<Side, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y }
    return (Object.keys(dist) as Side[]).reduce((a, b) => (dist[b] < dist[a] ? b : a), 'left')
  }

  return (
    <div
      onMouseDownCapture={onFocus}
      onDragOver={(e) => {
        if (!carriesTab(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(sideFor(e))
      }}
      onDragLeave={(e) => {
        // Ignore leaves that just cross into a child element.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
      }}
      onDrop={(e) => {
        if (!carriesTab(e)) return
        e.preventDefault()
        const id = e.dataTransfer.getData(TAB_DND_MIME)
        const side = sideFor(e)
        setOver(null)
        if (id) onDropTab(id, side)
      }}
      className={`relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden ${
        split
          ? focused
            ? 'z-10 ring-1 ring-inset ring-accent/50'
            : 'ring-1 ring-inset ring-accent/15'
          : ''
      }`}
    >
      {children}

      {/* Drop indicator: highlights the half where the session will be inserted. */}
      {over && (
        <div
          className={`pointer-events-none absolute bg-accent/10 border-accent ${
            over === 'left'
              ? 'inset-y-0 left-0 w-1/2 border-l-2'
              : over === 'right'
                ? 'inset-y-0 right-0 w-1/2 border-r-2'
                : over === 'top'
                  ? 'inset-x-0 top-0 h-1/2 border-t-2'
                  : 'inset-x-0 bottom-0 h-1/2 border-b-2'
          }`}
        />
      )}
    </div>
  )
}
