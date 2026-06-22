import { useState } from 'react'

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
  onDropTab: (draggedId: string, side: 'left' | 'right') => void
  children: React.ReactNode
}

function carriesTab(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TAB_DND_MIME)
}

/**
 * A single split-pane cell. Wraps one ConversationView, marks itself focused on
 * pointer-down, and acts as a drop target: dragging a sidebar tab over its left
 * or right half shows a drop indicator and drops insert the session on that side.
 */
export function Pane({ focused, split, onFocus, onDropTab, children }: Props) {
  const [over, setOver] = useState<'left' | 'right' | null>(null)

  const sideFor = (e: React.DragEvent): 'left' | 'right' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? 'left' : 'right'
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
      className={`relative flex-1 min-w-0 flex flex-col overflow-hidden ${
        split ? 'border-l border-ink-800 first:border-l-0' : ''
      } ${
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
          className={`pointer-events-none absolute inset-y-0 w-1/2 bg-accent/10 ${
            over === 'left' ? 'left-0 border-l-2' : 'right-0 border-r-2'
          } border-accent`}
        />
      )}
    </div>
  )
}
