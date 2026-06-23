import { useState } from 'react'
import { parseToolInput, type UiToolResult, type UiToolUseBlock } from '../../shared/schema'

interface AskedOption {
  label: string
  description?: string
}

interface AskedQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskedOption[]
}

/** Pull the question set out of the AskUserQuestion tool input. */
function parseQuestions(inputJson: string): AskedQuestion[] {
  const input = parseToolInput(inputJson) ?? {}
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const out: AskedQuestion[] = []
  for (const q of raw) {
    const question = typeof q?.question === 'string' ? q.question : ''
    const opts = Array.isArray(q?.options) ? q.options : []
    if (!question) continue
    out.push({
      question,
      header: typeof q?.header === 'string' ? q.header : undefined,
      multiSelect: Boolean(q?.multiSelect),
      options: opts
        .filter((o: unknown) => typeof (o as { label?: unknown })?.label === 'string')
        .map((o: { label: string; description?: unknown }) => ({
          label: o.label,
          description: typeof o.description === 'string' ? o.description : undefined
        }))
    })
  }
  return out
}

/** The answer transport feeds the user's picks back as the tool-result text,
 *  one "→ choice" line per question, in order (see formatAnswer in the
 *  backend). Extract those lines so we can show what was chosen. */
function parseAnswers(result: UiToolResult | undefined): string[] {
  if (!result) return []
  return result.text
    .split('\n')
    .filter((l) => l.trimStart().startsWith('→'))
    .map((l) => l.replace(/^\s*→\s*/, '').trim())
}

/** Did the user pick this option for this question? Picks for a question are a
 *  comma-joined list (multi-select) or free-text "Other"; match case-folded. */
function isChosen(answer: string | undefined, label: string): boolean {
  if (!answer || answer === '(no answer)') return false
  const picks = answer.split(',').map((p) => p.trim().toLowerCase())
  return picks.includes(label.trim().toLowerCase())
}

/** Renders an AskUserQuestion tool call as the question(s) asked plus the
 *  user's choices. The interactive picker itself lives in QuestionPrompt; this
 *  is the durable transcript record. Crucially it never shows "failed": the
 *  backend delivers the answer by resolving the SDK permission as a deny, which
 *  marks the tool_result as an error, but that denial is the transport, not a
 *  failure. */
export function AskedQuestionCard({
  block,
  result
}: {
  block: UiToolUseBlock
  result?: UiToolResult
}) {
  const questions = parseQuestions(block.inputJson)
  const answers = parseAnswers(result)
  const answered = answers.length > 0
  const interrupted =
    result != null && !answered && /interrupted|closed/i.test(result.text)
  const [open, setOpen] = useState(!answered && !interrupted)

  if (questions.length === 0)
    return (
      <div className="text-[12.5px] py-0.5 text-ink-400">
        <span className="text-ink-300">Asked a question</span>
      </div>
    )

  const summary = questions[0].question
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''

  return (
    <div className="text-[12.5px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="block max-w-full text-left py-0.5 hover:text-ink-200 transition-colors"
      >
        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
          <span className="text-ink-300 shrink-0">Asked</span>
          <span className="truncate min-w-0 text-ink-500" title={summary}>
            {summary}
            {more}
          </span>
          {!result && <span className="shrink-0 text-ink-500 italic">awaiting answer…</span>}
          {interrupted && <span className="shrink-0 text-ink-500">interrupted</span>}
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-3 space-y-3">
          {questions.map((q, i) => {
            const answer = answers[i]
            return (
              <div key={i}>
                {q.header && (
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ink-500 mb-0.5">
                    {q.header}
                  </div>
                )}
                <div className="text-ink-300 mb-1">{q.question}</div>
                <div className="space-y-0.5">
                  {q.options.map((o, j) => {
                    const chosen = isChosen(answer, o.label)
                    return (
                      <div
                        key={j}
                        className={`flex items-baseline gap-1.5 ${chosen ? 'text-accent' : 'text-ink-500'}`}
                      >
                        <span className="shrink-0 w-3 text-center">{chosen ? '✓' : '·'}</span>
                        <span className="font-medium">{o.label}</span>
                        {o.description && (
                          <span className="text-ink-600 truncate">— {o.description}</span>
                        )}
                      </div>
                    )
                  })}
                  {/* A free-text "Other" answer won't match any listed option. */}
                  {answer && !q.options.some((o) => isChosen(answer, o.label)) && (
                    <div className="flex items-baseline gap-1.5 text-accent">
                      <span className="shrink-0 w-3 text-center">✓</span>
                      <span className="font-medium">{answer}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
