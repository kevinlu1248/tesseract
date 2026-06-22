import { useState } from 'react'
import {
  parseToolInput,
  type UiNestedActivity,
  type UiToolResult,
  type UiToolUseBlock
} from '../../shared/schema'
import { summarizeTool } from '../lib/toolMeta'
import { MarkdownText } from './MarkdownText'
import { ToolResultBody, resultPreview } from './ToolResultCard'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/**
 * The subagent-delegation tool (named "Task" or "Agent"), rendered as a plain
 * clickable "Subagent <type> <prompt>" row that expands inline. Expanding shows
 * the delegated prompt, a live feed of the subagent's internal tool calls, and
 * its final result — all behind a subtle left rail that signals nested work.
 */
export function SubagentCard({
  block,
  result
}: {
  block: UiToolUseBlock
  result?: UiToolResult
}) {
  const input = parseToolInput(block.inputJson) ?? {}
  const agentType = str(input.subagent_type)
  const description = str(input.description)
  const prompt = str(input.prompt)
  const subtitle = description ?? prompt
  const running = !block.done || !result
  const nested = block.nested ?? []
  const [open, setOpen] = useState(false)

  return (
    <div className="text-[12.5px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="block max-w-full text-left py-0.5 hover:text-ink-200 transition-colors"
      >
        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
          {agentType && (
            <span className="shrink-0 font-mono text-[11px] text-accent">{agentType}</span>
          )}
          {subtitle && (
            <span className="truncate text-ink-500" title={prompt ?? subtitle}>
              {subtitle}
            </span>
          )}
          {nested.length > 0 && (
            <span className="shrink-0 text-[11px] text-ink-600">
              {nested.length} step{nested.length === 1 ? '' : 's'}
            </span>
          )}
          {running && <span className="spinner shrink-0 text-ink-500" />}
          {!running && result?.isError && <span className="shrink-0 text-[#ff9492]">failed</span>}
        </span>
      </button>

      {open && (
        <div className="mt-1 mb-2 ml-3 border-l border-ink-800 pl-3">
          {prompt && (
            <div className="mb-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-500">
              {prompt}
            </div>
          )}
          {nested.length > 0 && (
            <div className="mb-2 space-y-0.5">
              {nested.map((step, i) => (
                <NestedStep key={`${step.toolUseId}-${i}`} step={step} />
              ))}
            </div>
          )}
          <SubagentResult result={result} done={block.done} />
        </div>
      )}
    </div>
  )
}

/** One internal step of the subagent — a tool call and (once it lands) its
 *  result, rendered as a clickable line that expands to the full output. */
function NestedStep({ step }: { step: UiNestedActivity }) {
  const [open, setOpen] = useState(false)
  const { label, arg, argTitle } = summarizeTool(step.name, step.inputJson)
  const done = !!step.result
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="block max-w-full text-left hover:text-ink-200 transition-colors"
      >
        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
          <span className="shrink-0 text-ink-400">{label}</span>
          {arg && (
            <span className="truncate min-w-0 font-mono text-ink-600" title={argTitle ?? arg}>
              {arg}
            </span>
          )}
          {!done && <span className="spinner shrink-0 text-ink-600" />}
          {step.result?.isError && <span className="shrink-0 text-[#ff9492]">failed</span>}
          {done && !step.result?.isError && (
            <span className="truncate min-w-0 text-ink-700">{resultPreview(step.result!)}</span>
          )}
        </span>
      </button>
      {open && step.result && (
        <div className="mt-1 mb-1.5 ml-3">
          <ToolResultBody result={step.result} />
        </div>
      )}
    </div>
  )
}

function SubagentResult({ result, done }: { result?: UiToolResult; done: boolean }) {
  if (!result) {
    return (
      <div className="flex items-center gap-2 text-[12px] italic text-ink-500">
        {!done && <span className="spinner shrink-0 text-ink-500" />}
        {done ? '(no output)' : 'running…'}
      </div>
    )
  }

  const images = result.images ?? []
  const hasText = result.text.trim().length > 0
  return (
    <div>
      {hasText ? (
        <div className="max-h-96 overflow-y-auto text-[12.5px]">
          <MarkdownText text={result.text} />
        </div>
      ) : !images.length ? (
        <div className="text-[12px] italic text-ink-500">(no output)</div>
      ) : null}
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <a
              key={i}
              href={`data:${img.mediaType};base64,${img.data}`}
              target="_blank"
              rel="noreferrer"
              className="block"
            >
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt="subagent output"
                className="max-h-72 max-w-full rounded object-contain"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
