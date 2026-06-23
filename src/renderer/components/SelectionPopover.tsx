import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A small floating "Talk about this" button that appears just above whatever
 * text the user has selected inside the transcript. Clicking it hands the
 * selected text to `onQuote` (which prepends it to the composer as a markdown
 * blockquote) so the user can ask Claude about that exact passage.
 *
 * Selections are scoped to the element tagged `data-transcript-root` (the
 * transcript scroller) so selecting UI chrome — status bar, composer, etc. —
 * never triggers the button. Textarea selections live outside the document
 * selection API, so the composer is naturally excluded too.
 */

interface Anchor {
  text: string
  // Viewport coordinates (the button is position:fixed).
  left: number
  top: number
}

// How far above the selection's top edge the button floats, in pixels.
const GAP = 8

function selectionWithinTranscript(): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const text = sel.toString().trim()
  if (!text) return null

  const range = sel.getRangeAt(0)
  // The common ancestor can be a text node; climb to an element to query.
  const node = range.commonAncestorContainer
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  if (!el || !el.closest('[data-transcript-root]')) return null

  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { text, rect }
}

export function SelectionPopover({ onQuote }: { onQuote: (text: string) => void }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  // Hold the latest callback in a ref so the listeners can stay mount-stable.
  const quoteRef = useRef(onQuote)
  quoteRef.current = onQuote

  const refresh = useCallback(() => {
    const hit = selectionWithinTranscript()
    if (!hit) {
      setAnchor(null)
      return
    }
    setAnchor({
      text: hit.text,
      left: hit.rect.left + hit.rect.width / 2,
      top: hit.rect.top - GAP
    })
  }, [])

  useEffect(() => {
    // mouseup catches the end of a drag-select; selectionchange catches
    // keyboard selection and clears the button when the selection collapses.
    const onMouseUp = (): void => {
      // Defer so the selection is finalized before we read it.
      requestAnimationFrame(refresh)
    }
    const onSelectionChange = (): void => {
      if (!window.getSelection()?.toString().trim()) setAnchor(null)
    }
    // Reposition/hide while scrolling so the button doesn't detach from text.
    const onScroll = (): void => setAnchor(null)

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [refresh])

  if (!anchor) return null

  return (
    <button
      type="button"
      // Keep the mousedown from collapsing the selection before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        quoteRef.current(anchor.text)
        window.getSelection()?.removeAllRanges()
        setAnchor(null)
      }}
      style={{ left: anchor.left, top: anchor.top }}
      className="fixed z-40 -translate-x-1/2 -translate-y-full flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[12px] font-medium text-ink-100 shadow-lg shadow-black/40 hover:bg-ink-700 hover:border-accent/70 transition-colors"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Talk about this
    </button>
  )
}
