import { useLayoutEffect, useRef } from 'react'
import type { TranscriptItem, UiToolResult } from '../../shared/schema'
import { MessageView } from './MessageView'
import { ToolResultCard } from './ToolResultCard'

// Auto-scroll sticks to the bottom only when the user is already within this
// many pixels of the bottom; scrolled up further than this, new content won't
// yank them back down.
const STICK_THRESHOLD = 120

export function Transcript({ items }: { items: TranscriptItem[] }) {
  const scroller = useRef<HTMLDivElement>(null)
  // The scroller's content height as of the previous commit. Comparing the
  // *live* scrollTop against the *old* height tells us whether the user was
  // near the bottom before the new content arrived — without depending on
  // scroll events, which fire asynchronously and would race the effect below.
  const prevHeight = useRef(0)

  // Every tool result is folded into its own tool card so each call + result
  // renders as a single collapsible block (first line + preview when collapsed,
  // full input + output when expanded). Map results by tool-use id, and track
  // which ids have a matching tool_use in view so those standalone result cards
  // are skipped below. Orphan results — a result with no tool_use in view — fall
  // through to a standalone card.
  const resultByToolUse = new Map<string, UiToolResult>()
  const foldedToolUseIds = new Set<string>()
  for (const it of items) {
    if (it.kind === 'tool_result') {
      if (it.result.toolUseId) resultByToolUse.set(it.result.toolUseId, it.result)
    } else {
      for (const b of it.message.blocks)
        if (b.kind === 'tool_use') foldedToolUseIds.add(b.toolUseId)
    }
  }

  // Auto-scroll to the true bottom (including the scroller's bottom padding)
  // when the content changes, but only if the user was near the bottom of the
  // *previous* content. We read the live scrollTop (which reflects any manual
  // scrolling) against the height before this update, so a fast stream of
  // updates can't fight the user as they scroll up. A layout effect runs before
  // paint, so the jump isn't visible.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const distanceFromOldBottom = prevHeight.current - el.scrollTop - el.clientHeight
    if (distanceFromOldBottom < STICK_THRESHOLD) el.scrollTop = el.scrollHeight
    prevHeight.current = el.scrollHeight
  }, [items])

  return (
    <div
      ref={scroller}
      className="flex-1 overflow-y-auto px-6 py-6"
    >
      <div className="max-w-3xl mx-auto space-y-5">
        {items.map((item, i) =>
          item.kind === 'message' ? (
            <MessageView key={item.message.id} message={item.message} results={resultByToolUse} />
          ) : foldedToolUseIds.has(item.result.toolUseId) ? null : (
            <ToolResultCard key={`tr-${i}`} result={item.result} />
          )
        )}
      </div>
    </div>
  )
}
