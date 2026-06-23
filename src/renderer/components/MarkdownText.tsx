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

// Markdown images: constrain size so a large remote image can't blow out the
// transcript layout, and degrade gracefully — if the URL fails to load, swap
// the broken-image icon for the alt text rather than leaving a broken glyph.
function MarkdownImage({ src, alt, ...rest }: ComponentProps<'img'>) {
  return (
    <img
      {...rest}
      src={src}
      alt={alt}
      loading="lazy"
      className="my-1 max-w-full h-auto rounded-md border border-white/10"
      onError={(e) => {
        const img = e.currentTarget
        const fallback = document.createElement('span')
        fallback.className = 'text-[#8a90a0] italic'
        fallback.textContent = alt ? `🖼 ${alt}` : '🖼 (image failed to load)'
        img.replaceWith(fallback)
      }}
    />
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
        components={{ a: ExternalLink, img: MarkdownImage }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
