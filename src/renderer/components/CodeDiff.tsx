import { useMemo } from 'react'
import { lineDiff } from '../lib/diff'
import { highlightLine, langFromPath } from '../lib/highlight'

interface Props {
  oldText: string
  newText: string
  filePath?: string
}

const ROW_STYLE: Record<'add' | 'del' | 'ctx', string> = {
  add: 'bg-[#1b3326] text-[#aff5b4]',
  del: 'bg-[#3a1d22] text-[#ffb3ad]',
  ctx: 'text-ink-300'
}
const SIGN: Record<'add' | 'del' | 'ctx', string> = { add: '+', del: '-', ctx: ' ' }

/** Line-level red/green diff with token-level syntax highlighting. */
export function CodeDiff({ oldText, newText, filePath }: Props) {
  const lang = useMemo(() => langFromPath(filePath), [filePath])
  const rows = useMemo(() => lineDiff(oldText, newText), [oldText, newText])

  return (
    <div className="rounded overflow-hidden bg-[#0d1117]">
      <pre className="text-[12px] leading-[1.55] font-mono overflow-x-auto m-0">
        <code>
          {rows.map((row, i) => (
            <div key={i} className={`flex ${ROW_STYLE[row.type]}`}>
              <span className="select-none shrink-0 w-5 text-center opacity-50">
                {SIGN[row.type]}
              </span>
              <span
                className="whitespace-pre flex-1 pr-3"
                dangerouslySetInnerHTML={{ __html: highlightLine(row.text, lang) }}
              />
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}
