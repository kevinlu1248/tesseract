import { useMemo } from 'react'
import { lineDiff } from '../lib/diff'
import { highlightLine, langFromPath } from '../lib/highlight'
import { useScrollGate } from './scrollGate'

interface Props {
  oldText: string
  newText: string
  filePath?: string
}

// Background tint marks the line as add/del; the base text color stays the
// neutral code foreground so unclassed tokens (identifiers, brackets, `=`)
// don't inherit a green/red tint — only the `.hljs-*` spans add token colors.
const ROW_STYLE: Record<'add' | 'del' | 'ctx', string> = {
  add: 'bg-[#1b3326] text-[#c9d1d9]',
  del: 'bg-[#3a1d22] text-[#c9d1d9]',
  ctx: 'text-ink-300'
}
// The +/- gutter keeps the add/del accent color.
const SIGN_STYLE: Record<'add' | 'del' | 'ctx', string> = {
  add: 'text-[#3fb950]',
  del: 'text-[#f85149]',
  ctx: 'opacity-50'
}
const SIGN: Record<'add' | 'del' | 'ctx', string> = { add: '+', del: '-', ctx: ' ' }

/** Line-level red/green diff with token-level syntax highlighting. */
export function CodeDiff({ oldText, newText, filePath }: Props) {
  const lang = useMemo(() => langFromPath(filePath), [filePath])
  const rows = useMemo(() => lineDiff(oldText, newText), [oldText, newText])
  const overflowX = useScrollGate('x')

  return (
    <div className="rounded overflow-hidden bg-[#0d1117]">
      <pre className={`text-[12px] leading-[1.55] font-mono ${overflowX} m-0`}>
        <code>
          {rows.map((row, i) => (
            <div key={i} className={`flex ${ROW_STYLE[row.type]}`}>
              <span className={`select-none shrink-0 w-5 text-center ${SIGN_STYLE[row.type]}`}>
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
