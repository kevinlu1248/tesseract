import { memo } from 'react'
import type { ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'

// Force every markdown link to open in the user's external browser instead of
// navigating the Electron window. target="_blank" routes the click through the
// main process's setWindowOpenHandler, which calls shell.openExternal().
function ExternalLink({ href, children, ...rest }: ComponentProps<'a'>) {
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/** Renders assistant/user text as GitHub-flavored markdown with code highlight + LaTeX math. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md text-[13.5px] text-[#dfe3ec]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // rehypeRaw must run first so it parses inline/raw HTML into the hast
        // tree before highlight/katex walk it. Without it react-markdown
        // escapes raw HTML (<span>, <table>, <abbr>, …) into literal text.
        rehypePlugins={[rehypeRaw, rehypeHighlight, rehypeKatex]}
        components={{ a: ExternalLink }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
