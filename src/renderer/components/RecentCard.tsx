import { useEffect, useRef } from 'react'
import type { SessionCard } from '../../shared/ipc'
import { SkeletonLines } from './Skeleton'

/**
 * A single "pick up from a previous conversation" card on the new-message
 * screen. The AI title/description are generated lazily: while the card is
 * pending AND actually on screen, it asks the main process (once) to generate
 * its summary, showing a skeleton in the meantime. Cards that are never shown
 * (e.g. a docked session whose cards are hidden) never spend a model call.
 */
interface Props {
  card: SessionCard
  /** True while the recent-conversation cards are actually presented (centered). */
  active: boolean
  onResume: (sessionId: string) => void
  /** Request lazy summary generation; the parent de-dupes repeat calls. */
  onVisible: (sessionId: string) => void
}

function clamp(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export function RecentCard({ card, active, onResume, onVisible }: Props): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Only request a summary while the cards are genuinely visible to the user
    // (active = centered state) and this one still needs one. An
    // IntersectionObserver keeps cards scrolled out of view from generating
    // until they're actually revealed.
    if (!active || !card.pending) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible(card.sessionId)
          io.disconnect()
        }
      },
      { threshold: 0.1 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [active, card.pending, card.sessionId, onVisible])

  return (
    <button
      ref={ref}
      onClick={() => onResume(card.sessionId)}
      title={card.description ?? card.title}
      className="group text-left px-3.5 py-2.5 rounded-xl border border-ink-700 bg-ink-850 hover:border-accent/70 hover:bg-ink-800 transition-colors"
    >
      <div className="text-[13px] font-medium text-ink-100 truncate group-hover:text-white">
        {clamp(card.title, 60)}
      </div>
      <div className="mt-0.5 text-[12px] text-ink-400 line-clamp-2 min-h-[2.25em]">
        {card.description ? (
          card.description
        ) : card.pending ? (
          <SkeletonLines />
        ) : (
          <span className="italic text-ink-500">No description</span>
        )}
      </div>
    </button>
  )
}
