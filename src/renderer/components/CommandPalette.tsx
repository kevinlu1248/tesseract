import { useEffect, useMemo, useRef, useState } from 'react'

/** A single actionable entry in the command palette. */
export interface Command {
  id: string
  title: string
  /** Secondary line shown under the title (e.g. a cwd or hint). */
  subtitle?: string
  /** Group heading the command is bucketed under in the list. */
  group?: string
  /** Extra terms (not displayed) that the query also matches against. */
  keywords?: string
  /** Right-aligned shortcut hint, e.g. "⌘B". */
  shortcut?: string
  /** Whether the command is currently actionable; disabled ones are hidden. */
  enabled?: boolean
  run: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  commands: Command[]
}

/**
 * Subsequence fuzzy match: every character of `query` must appear in `text` in
 * order. Returns a score (higher = better; contiguous + early matches win) or
 * -1 when there's no match. Empty queries match everything with score 0.
 */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let prevMatch = -1
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    // Reward adjacency to the previous matched char and matches near the start.
    if (found === prevMatch + 1) score += 5
    if (found === 0) score += 3
    score += Math.max(0, 3 - (found - ti))
    prevMatch = found
    ti = found + 1
  }
  return score
}

/**
 * Global command palette (⌘K / ⌘⇧P). Filters a flat command list with a fuzzy
 * matcher, groups results, and supports full keyboard control: ↑/↓ to move,
 * Enter to run, Esc to dismiss. Selecting a command closes the palette.
 */
export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset query + selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      // Focus after paint so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Rank enabled commands by fuzzy score against title/subtitle/keywords.
  const results = useMemo(() => {
    const matchable = commands.filter((c) => c.enabled !== false)
    const scored = matchable
      .map((c) => {
        const hay = [c.title, c.subtitle, c.keywords, c.group].filter(Boolean).join(' ')
        return { command: c, score: fuzzyScore(query, hay) }
      })
      .filter((r) => r.score >= 0)
    // Stable-ish sort: by score desc, original order preserved for ties.
    if (query) scored.sort((a, b) => b.score - a.score)
    return scored.map((r) => r.command)
  }, [commands, query])

  // Clamp selection whenever the result set shrinks.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)))
  }, [results.length])

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, open])

  if (!open) return null

  const runAt = (index: number): void => {
    const cmd = results[index]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => (results.length ? (s + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => (results.length ? (s - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(selected)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Render with running group headings, tracking each row's flat index so
  // keyboard selection and click share one coordinate space.
  let flatIndex = -1
  let lastGroup: string | undefined

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/40"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl mx-4 rounded-xl border border-ink-700 bg-ink-900 shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          className="w-full bg-transparent px-4 py-3.5 text-[14px] text-ink-100 placeholder:text-ink-500 border-b border-ink-700 focus:outline-none"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-ink-500">No commands found</div>
          ) : (
            results.map((cmd) => {
              flatIndex += 1
              const index = flatIndex
              const showGroup = cmd.group && cmd.group !== lastGroup
              lastGroup = cmd.group
              const on = index === selected
              return (
                <div key={cmd.id}>
                  {showGroup && (
                    <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-ink-500">
                      {cmd.group}
                    </div>
                  )}
                  <button
                    data-index={index}
                    onMouseMove={() => setSelected(index)}
                    onClick={() => runAt(index)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                      on ? 'bg-accent/15' : 'hover:bg-ink-850'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-ink-100 truncate">{cmd.title}</div>
                      {cmd.subtitle && (
                        <div className="text-[11.5px] text-ink-500 truncate">{cmd.subtitle}</div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <span className="shrink-0 text-[11px] font-mono text-ink-500">
                        {cmd.shortcut}
                      </span>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
