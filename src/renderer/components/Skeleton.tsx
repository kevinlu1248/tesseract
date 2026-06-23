/**
 * Skeleton — a low-key shimmering placeholder for content that's still loading.
 *
 * Used in place of spinner text (e.g. the recent-conversation cards while their
 * AI summary is being generated). Render one or more bars sized to roughly
 * match the real content so the layout doesn't jump when it arrives.
 */
interface SkeletonProps {
  /** Tailwind width class (e.g. "w-3/4", "w-full"). Defaults to full width. */
  className?: string
}

export function Skeleton({ className = 'w-full' }: SkeletonProps): JSX.Element {
  return (
    <span
      aria-hidden
      className={`block h-3 rounded bg-ink-700/70 animate-pulse ${className}`}
    />
  )
}

/** A two-line text-block skeleton sized for the card description area. */
export function SkeletonLines(): JSX.Element {
  return (
    <span className="flex flex-col gap-1.5 py-0.5" aria-hidden>
      <Skeleton className="w-full" />
      <Skeleton className="w-2/3" />
    </span>
  )
}
