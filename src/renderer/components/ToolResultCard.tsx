import { useState } from 'react'
import type { UiImage, UiToolResult } from '../../shared/schema'
import { useScrollGate } from './scrollGate'

/** One-line preview of a tool result for collapsed headers. */
export function resultPreview(result: UiToolResult): string {
  const images = result.images ?? []
  if (images.length) return `${images.length} image${images.length > 1 ? 's' : ''}`
  const text = result.text.trim()
  if (!text) return '(no output)'
  return text.split('\n')[0].slice(0, 80)
}

/** The body of a tool result — output text + any images. Shared by the folded
 *  tool line (call + result in one block) and the standalone orphan result. */
export function ToolResultBody({ result }: { result: UiToolResult }) {
  const images = result.images ?? []
  const hasText = result.text.trim().length > 0
  const text = hasText ? result.text : images.length ? '' : '(no output)'
  const overflowY = useScrollGate('y')
  return (
    <>
      {(hasText || !images.length) && (
        <pre
          className={`text-[12px] leading-relaxed text-ink-300 font-mono whitespace-pre-wrap break-words max-h-80 ${overflowY}`}
        >
          {text}
        </pre>
      )}
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <ResultImage key={i} img={img} />
          ))}
        </div>
      )}
    </>
  )
}

/** A standalone result with no matching tool_use block in view, rendered as a
 *  plain text line that expands inline to the full output. */
export function ToolResultCard({ result }: { result: UiToolResult }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[12.5px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="block max-w-full text-left py-0.5 hover:text-ink-200 transition-colors"
      >
        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
          <span className="truncate min-w-0 text-ink-400 font-mono">{resultPreview(result)}</span>
          {result.isError && <span className="shrink-0 text-[#ff9492]">failed</span>}
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-3">
          <ToolResultBody result={result} />
        </div>
      )}
    </div>
  )
}

function ResultImage({ img }: { img: UiImage }) {
  const src = `data:${img.mediaType};base64,${img.data}`
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block">
      <img src={src} alt="tool output" className="max-h-72 max-w-full rounded object-contain" />
    </a>
  )
}
