import { useState } from 'react'
import type { UiImage, UiMessage, UiToolResult } from '../../shared/schema'
import { MarkdownText } from './MarkdownText'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolUseCard } from './ToolUseCard'

function MessageImage({ image }: { image: UiImage }) {
  const src = `data:${image.mediaType};base64,${image.data}`
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block">
      <img
        src={src}
        alt="attachment"
        className="max-h-72 max-w-full rounded-lg object-contain"
      />
    </a>
  )
}

/**
 * A user message bubble. On hover it offers an "edit" affordance; editing
 * rewinds the conversation to this point (discarding this turn and everything
 * after) and re-runs from the edited text — see useWorkspace.editAndRewind.
 */
function UserMessage({
  message,
  onEdit
}: {
  message: UiMessage
  onEdit?: (messageId: string, text: string, images: UiImage[]) => void
}) {
  const text = message.blocks
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join('\n')
    .trim()
  const imageBlocks = message.blocks.filter((b) => b.kind === 'image')
  const images = imageBlocks.map((b) => b.image)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)

  const begin = (): void => {
    setDraft(text)
    setEditing(true)
  }
  const save = (): void => {
    const next = draft.trim()
    if (!next && images.length === 0) return
    setEditing(false)
    onEdit?.(message.id, next, images)
  }
  const cancel = (): void => {
    setEditing(false)
    setDraft(text)
  }

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] space-y-2 rounded-2xl rounded-br-sm border border-accent-soft bg-accent-soft/60 px-4 py-2.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                save()
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            className="w-full resize-none rounded-lg border border-accent-soft/60 bg-ink-950/40 px-3 py-2 text-[13px] text-ink-100 outline-none focus:border-accent/60"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-400">
              Editing rewinds the conversation to here.
            </span>
            <div className="flex gap-2">
              <button
                onClick={cancel}
                className="rounded-md px-2.5 py-1 text-[12px] text-ink-300 hover:text-ink-100"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:bg-accent/90"
              >
                Save &amp; rewind
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex items-start justify-end gap-1.5">
      {onEdit && (
        <button
          onClick={begin}
          title="Edit message & rewind"
          aria-label="Edit message and rewind the conversation to here"
          className="mt-1 shrink-0 rounded-md p-1 text-ink-500 opacity-0 transition-opacity hover:text-ink-200 group-hover:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-sm bg-accent-soft/60 border border-accent-soft px-4 py-2.5">
        {imageBlocks.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {imageBlocks.map((b) => (
              <MessageImage key={b.id} image={b.image} />
            ))}
          </div>
        )}
        {text && <MarkdownText text={text} />}
      </div>
    </div>
  )
}

export function MessageView({
  message,
  results,
  onEdit
}: {
  message: UiMessage
  results?: Map<string, UiToolResult>
  /** Edit this (user) message, rewinding the conversation to this point. */
  onEdit?: (messageId: string, text: string, images: UiImage[]) => void
}) {
  if (message.role === 'user') {
    return <UserMessage message={message} onEdit={onEdit} />
  }

  // Whether a block will actually render anything. Mirrors the per-block guards
  // below (empty text blocks and finished textless thinking blocks render null).
  const isVisible = (b: (typeof message.blocks)[number]) =>
    b.kind === 'text' ? !!b.text : b.kind === 'thinking' ? !b.done || !!b.text : true

  // A message with blocks but nothing visible (e.g. only a redacted thinking
  // block) would render an empty wrapper that still picks up the transcript's
  // vertical spacing — a phantom gap. Suppress it entirely.
  if (message.blocks.length > 0 && !message.blocks.some(isVisible)) return null

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 space-y-1">
        {message.blocks.length === 0 && (
          <div className="text-ink-400 text-sm pulse">thinking…</div>
        )}
        {message.blocks.map((block) => {
          if (block.kind === 'text')
            return block.text ? <MarkdownText key={block.id} text={block.text} /> : null
          if (block.kind === 'thinking')
            return <ThinkingBlock key={block.id} block={block} />
          if (block.kind === 'image')
            return <MessageImage key={block.id} image={block.image} />
          return (
            <ToolUseCard key={block.id} block={block} result={results?.get(block.toolUseId)} />
          )
        })}
      </div>
    </div>
  )
}
