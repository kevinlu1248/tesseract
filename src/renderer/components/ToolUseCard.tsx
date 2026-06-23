import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseToolInput, type UiToolResult, type UiToolUseBlock } from '../../shared/schema'
import { highlightCode, langFromPath } from '../lib/highlight'
import { summarizeTool } from '../lib/toolMeta'
import { CodeDiff } from './CodeDiff'
import { ToolResultBody } from './ToolResultCard'
import { SubagentCard } from './SubagentCard'
import { AskedQuestionCard } from './AskedQuestionCard'
import { ScrollGateContext, useScrollGate } from './scrollGate'

export function ToolUseCard({
  block,
  result
}: {
  block: UiToolUseBlock
  result?: UiToolResult
}) {
  // The subagent-delegation tool is named "Task" in older SDKs and "Agent" in
  // newer ones — both render as the SubagentCard.
  if (block.name === 'Task' || block.name === 'Agent')
    return <SubagentCard block={block} result={result} />
  // AskUserQuestion is the model asking the user to choose — render the
  // question + chosen answer, never as a "failed" tool. The answer is delivered
  // to the model by resolving the SDK permission as a deny (the only available
  // short-circuit), which flags the tool_result as an error; that denial is the
  // transport, not a real failure, so it must not surface as one.
  if (block.name === 'AskUserQuestion')
    return <AskedQuestionCard block={block} result={result} />
  // Edits auto-expand to show the diff and stay open.
  if (block.name === 'Edit' || block.name === 'MultiEdit')
    return (
      <ExpandableTool block={block} result={result} body={<EditDiff block={block} />} defaultOpen />
    )
  // Writes auto-expand to show the created file's contents.
  if (block.name === 'Write')
    return (
      <ExpandableTool block={block} result={result} body={<WriteContent block={block} />} defaultOpen />
    )
  // Bash ("Ran") auto-expands to show its output.
  if (block.name === 'Bash')
    return <ExpandableTool block={block} result={result} defaultOpen />
  // Everything else expands to its result, exactly like Read.
  return <ExpandableTool block={block} result={result} />
}

function Spinner() {
  return <span className="spinner text-ink-500 shrink-0" />
}

/** The plain text line shown for every tool — verb + argument, no card. */
function ToolLine({ block, result }: { block: UiToolUseBlock; result?: UiToolResult }) {
  const { label, arg, argTitle } = summarizeTool(block.name, block.inputJson)
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
      <span className="text-ink-300 shrink-0">{label}</span>
      {arg && (
        <span className="truncate min-w-0 text-ink-500 font-mono" title={argTitle ?? arg}>
          {arg}
        </span>
      )}
      {!block.done && <Spinner />}
      {result?.isError && <span className="shrink-0 text-[#ff9492]">failed</span>}
    </span>
  )
}

/** A tool rendered as a single clickable text line — like Read — that expands
 *  inline. By default it expands to its result; pass `body` to expand to custom
 *  content (e.g. an edit diff) instead. No card, no border. */
function ExpandableTool({
  block,
  result,
  body,
  defaultOpen = false,
  autoCollapse = false
}: {
  block: UiToolUseBlock
  result?: UiToolResult
  body?: ReactNode
  defaultOpen?: boolean
  /** Open while the tool is still running, then collapse once it's done. */
  autoCollapse?: boolean
}) {
  const [open, setOpen] = useState(autoCollapse ? !block.done : defaultOpen)
  // The expanded body is clipped (overflow-hidden) by default so the page
  // scrolls past it cleanly; clicking into it activates its own scroll so it
  // doesn't trap the wheel inside another scrollable (scrollable-in-scrollable).
  const [scrollable, setScrollable] = useState(false)
  const wasDone = useRef(block.done)
  useEffect(() => {
    if (autoCollapse && block.done && !wasDone.current) setOpen(false)
    wasDone.current = block.done
  }, [autoCollapse, block.done])
  const toggle = () => {
    setOpen(!open)
    setScrollable(false)
  }
  const expanded = body ?? (result != null ? <ToolResultBody result={result} /> : null)

  if (expanded == null) {
    return (
      <div className="text-[12.5px] py-0.5">
        <ToolLine block={block} result={result} />
      </div>
    )
  }

  return (
    <div className="text-[12.5px]">
      <button
        onClick={toggle}
        className="block max-w-full text-left py-0.5 hover:text-ink-200 transition-colors"
      >
        <ToolLine block={block} result={result} />
      </button>
      {open && (
        <ScrollGateContext.Provider value={scrollable}>
          {/* The wrapper itself doesn't scroll — each inner body owns a single
              gated scroll container (see scrollGate.ts), so there's never a
              scrollable nested inside a scrollable. mousedown arms the gate. */}
          <div className="mt-1 mb-2" onMouseDown={() => setScrollable(true)}>
            {expanded}
          </div>
        </ScrollGateContext.Provider>
      )}
    </div>
  )
}

interface EditPair {
  old_string?: string
  new_string?: string
}

/** The syntax-highlighted diff for an Edit / MultiEdit tool. */
function EditDiff({ block }: { block: UiToolUseBlock }) {
  const input = parseToolInput(block.inputJson) ?? {}
  const file = typeof input.file_path === 'string' ? input.file_path : undefined
  const edits: EditPair[] = Array.isArray(input.edits)
    ? (input.edits as EditPair[])
    : [{ old_string: input.old_string as string, new_string: input.new_string as string }]
  const hasEdits = edits.some((e) => e.old_string != null || e.new_string != null)

  if (!hasEdits) return <div className="text-[12px] text-ink-500 italic">collecting edit…</div>
  return <EditDiffBody edits={edits} file={file} />
}

function EditDiffBody({ edits, file }: { edits: EditPair[]; file?: string }) {
  const overflowY = useScrollGate('y')
  return (
    <div className={`space-y-2 max-h-80 ${overflowY}`}>
      {edits.map((e, i) => (
        <CodeDiff key={i} oldText={e.old_string ?? ''} newText={e.new_string ?? ''} filePath={file} />
      ))}
    </div>
  )
}

/** The created file's contents for a Write tool, syntax-highlighted. */
function WriteContent({ block }: { block: UiToolUseBlock }) {
  const input = parseToolInput(block.inputJson) ?? {}
  const content = typeof input.content === 'string' ? input.content : undefined
  const file = typeof input.file_path === 'string' ? input.file_path : undefined

  if (content == null) return <div className="text-[12px] text-ink-500 italic">collecting input…</div>
  return <WriteContentBody content={content} file={file} />
}

function WriteContentBody({ content, file }: { content: string; file?: string }) {
  const overflowY = useScrollGate('y')
  return (
    <pre
      className={`hljs text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words bg-[#0d1117] rounded px-3 py-2 m-0 max-h-80 ${overflowY}`}
    >
      <code dangerouslySetInnerHTML={{ __html: highlightCode(content, langFromPath(file)) }} />
    </pre>
  )
}
