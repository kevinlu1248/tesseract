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

export function MessageView({
  message,
  results
}: {
  message: UiMessage
  results?: Map<string, UiToolResult>
}) {
  if (message.role === 'user') {
    const text = message.blocks
      .map((b) => (b.kind === 'text' ? b.text : ''))
      .join('\n')
      .trim()
    const imageBlocks = message.blocks.filter((b) => b.kind === 'image')
    return (
      <div className="flex justify-end">
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
