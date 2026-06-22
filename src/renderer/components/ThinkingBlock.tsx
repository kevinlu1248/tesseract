import { useState } from 'react'
import type { UiThinkingBlock } from '../../shared/schema'

export function ThinkingBlock({ block }: { block: UiThinkingBlock }) {
  const thinking = !block.done
  const [open, setOpen] = useState(false)
  // A finished thinking block with no text (e.g. redacted/signature-only) has
  // nothing to show — hide it rather than render a bare "Thought" / "…".
  if (!thinking && !block.text) return null
  return (
    <div className="text-[12.5px] leading-relaxed">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`text-ink-400 hover:text-ink-300 transition-colors ${thinking ? 'pulse' : ''}`}
      >
        {thinking ? 'Thinking…' : 'Thought'}
      </button>
      {open && (
        <div className="mt-1 text-ink-500 italic whitespace-pre-wrap break-words">
          {block.text || '…'}
        </div>
      )}
    </div>
  )
}
