import { useCallback, useLayoutEffect, useRef } from 'react'
import type { TranscriptItem, UiImage, UiToolResult } from '../../shared/schema'
import { MessageView } from './MessageView'
import { ToolResultCard } from './ToolResultCard'

// Auto-scroll sticks to the bottom only when the user is already within this
// many pixels of the bottom; scrolled up further than this, new content won't
// yank them back down.
const STICK_THRESHOLD = 120

// How close to the true bottom counts as "all the way down" for hiding the
// fade-out gradient above the composer. Tighter than STICK_THRESHOLD so the
// fade only disappears once there's genuinely nothing left to scroll into.
const BOTTOM_EPSILON = 8

export function Transcript({
  items,
  onAtBottomChange,
  onEditMessage,
}: {
  items: TranscriptItem[]
  onAtBottomChange?: (atBottom: boolean) => void
  /** Edit an earlier user message, rewinding the conversation to that point. */
  onEditMessage?: (messageId: string, text: string, images: UiImage[]) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)

  // Report whether the scroller is parked at (or within a hair of) the bottom,
  // so the parent can hide the soft fade when there's nothing more below.
  const reportAtBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    onAtBottomChange?.(distanceFromBottom <= BOTTOM_EPSILON)
  }, [onAtBottomChange])
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
    reportAtBottom()
  }, [items, reportAtBottom])

  return (
    <div
      ref={scroller}
      onScroll={reportAtBottom}
      // Marks the transcript content region so the selection popover only offers
      // "Talk about this" for text selected here (not the composer/status bar).
      data-transcript-root
      className="flex-1 overflow-y-auto px-6 pt-6 pb-20"
    >
      <div className="max-w-3xl mx-auto space-y-5">
        {items.map((item, i) =>
          item.kind === 'message' ? (
            <MessageView
              key={item.message.id}
              message={item.message}
              results={resultByToolUse}
              onEdit={onEditMessage}
            />
          ) : foldedToolUseIds.has(item.result.toolUseId) ? null : (
            <ToolResultCard key={`tr-${i}`} result={item.result} />
          )
        )}
      </div>
    </div>
  )
}
