import hljs from 'highlight.js'

/** Map a file path's extension to a highlight.js language name. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  html: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  sql: 'sql'
}

export function langFromPath(path: string | undefined): string | null {
  if (!path) return null
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return null
  const lang = EXT_TO_LANG[ext]
  return lang && hljs.getLanguage(lang) ? lang : null
}

/**
 * Token-level highlight of a single line, returning HTML. Highlighting per-line
 * keeps diff rows independent (a removed line and an added line highlight on
 * their own), at the cost of losing multi-line context — fine for code review.
 */
export function highlightLine(line: string, lang: string | null): string {
  if (line === '') return '&nbsp;'
  if (!lang) return escapeHtml(line)
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(line)
  }
}

export function highlightCode(code: string, lang: string | null): string {
  if (!lang) return escapeHtml(code)
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
