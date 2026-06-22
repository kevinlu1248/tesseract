import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'

/** Renders assistant/user text as GitHub-flavored markdown with code highlight + LaTeX math. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md text-[13.5px] text-[#dfe3ec]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
