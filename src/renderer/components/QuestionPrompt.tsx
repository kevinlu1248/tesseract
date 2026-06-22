import { useMemo, useState } from 'react'
import type { QuestionAnswer, QuestionRequest } from '../../shared/ipc'

interface Props {
  request: QuestionRequest
  onAnswer: (requestId: string, answer: QuestionAnswer) => void
}

/** Per-question working state: the set of chosen option labels plus any
 *  free-text "Other" answer the user typed. */
interface Draft {
  selected: string[]
  other: string
}

/**
 * Interactive renderer for the agent's `AskUserQuestion` tool. Each question is
 * shown with its options as clickable cards — single-select behaves like radio
 * buttons, multi-select like checkboxes — plus an always-available "Other"
 * free-text field. Submitting feeds the chosen labels back to the model.
 */
export function QuestionPrompt({ request, onAnswer }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    request.questions.map(() => ({ selected: [], other: '' }))
  )

  const update = (i: number, fn: (d: Draft) => Draft): void =>
    setDrafts((prev) => prev.map((d, j) => (j === i ? fn(d) : d)))

  const toggle = (i: number, label: string, multi: boolean): void =>
    update(i, (d) => {
      if (multi)
        return {
          ...d,
          selected: d.selected.includes(label)
            ? d.selected.filter((l) => l !== label)
            : [...d.selected, label]
        }
      // Single-select: clicking the chosen option clears it, else replaces.
      return { ...d, selected: d.selected[0] === label ? [] : [label] }
    })

  // The combined answer for each question: chosen labels + a trimmed "Other".
  const answers = useMemo<string[][]>(
    () =>
      drafts.map((d) => {
        const other = d.other.trim()
        return other ? [...d.selected, other] : d.selected
      }),
    [drafts]
  )

  // Ready only once every question has at least one selection or typed answer.
  const ready = answers.every((a) => a.length > 0)

  const submit = (): void => {
    if (!ready) return
    onAnswer(request.requestId, { answers })
  }

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/[0.07] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-accent/90 mb-3">
        Claude is asking
      </div>
      <div className="space-y-4">
        {request.questions.map((q, i) => {
          const draft = drafts[i]
          return (
            <div key={i} className="rounded-md border border-ink-700/60 bg-ink-900/40 px-3 py-2.5">
              {q.header && (
                <div className="-mx-3 -mt-2.5 mb-2 px-3 py-1.5 border-b border-ink-700/60 rounded-t-md bg-ink-800/50">
                  <span className="text-[10px] uppercase tracking-wide font-mono font-semibold text-ink-300">
                    {q.header}
                  </span>
                </div>
              )}
              <div className="mb-2">
                <span className="text-[13px] text-ink-100 font-medium">{q.question}</span>
              </div>
              {q.multiSelect && (
                <div className="text-[11px] text-ink-500 mb-1.5">Select all that apply</div>
              )}
              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const on = draft.selected.includes(opt.label)
                  return (
                    <button
                      key={opt.label}
                      onClick={() => toggle(i, opt.label, q.multiSelect)}
                      className={`block w-full text-left rounded-md border px-3 py-2 transition-colors ${
                        on
                          ? 'border-accent bg-accent/15'
                          : 'border-ink-700 bg-ink-850 hover:border-ink-600'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 grid place-items-center h-3.5 w-3.5 text-[10px] ${
                            q.multiSelect ? 'rounded-[3px]' : 'rounded-full'
                          } border ${
                            on ? 'border-accent bg-accent text-ink-950' : 'border-ink-500'
                          }`}
                        >
                          {on ? '✓' : ''}
                        </span>
                        <span className="text-[12.5px] text-ink-100">{opt.label}</span>
                      </div>
                      {opt.description && (
                        <div className="mt-0.5 ml-[22px] text-[11.5px] leading-snug text-ink-400">
                          {opt.description}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
              <input
                type="text"
                value={draft.other}
                onChange={(e) => update(i, (d) => ({ ...d, other: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ready) submit()
                }}
                placeholder="Other…"
                className="mt-1.5 w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-1.5 text-[12.5px] text-ink-100 placeholder:text-ink-500 focus:border-accent/70 focus:outline-none"
              />
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={submit}
          disabled={!ready}
          className="px-3 py-1.5 rounded-md bg-accent text-ink-950 text-[12px] font-medium hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Submit answer
        </button>
      </div>
    </div>
  )
}
