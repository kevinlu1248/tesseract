import { parseToolInput } from '../../shared/schema'

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export interface ToolSummary {
  /** Lowercased verb shown before the argument, e.g. "read". */
  label: string
  /** The primary argument (file name, command, pattern…). */
  arg?: string
  /** Full value for a tooltip (e.g. absolute path). */
  argTitle?: string
}

/** Extract a human label + primary argument from a tool's input. */
export function summarizeTool(name: string, inputJson: string): ToolSummary {
  const input = parseToolInput(inputJson) ?? {}
  const file = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
  switch (name) {
    case 'Read':
      return { label: 'Read', arg: file && basename(file), argTitle: file }
    case 'LS':
      return { label: 'Listed', arg: file && basename(file), argTitle: file }
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Edited', arg: file && basename(file), argTitle: file }
    case 'Write':
      return { label: 'Created', arg: file && basename(file), argTitle: file }
    case 'Glob':
      return { label: 'Searched', arg: str(input.pattern) }
    case 'Grep':
      return { label: 'Searched', arg: str(input.pattern) }
    case 'Bash': {
      const cmd = str(input.command)
      return { label: 'Ran', arg: cmd?.split('\n')[0], argTitle: cmd }
    }
    case 'Task':
    case 'Agent':
      return { label: 'Subagent', arg: str(input.description) ?? str(input.prompt) }
    case 'WebFetch':
      return { label: 'Fetched', arg: str(input.url) }
    case 'WebSearch':
      return { label: 'Searched', arg: str(input.query) }
    case 'TodoWrite':
      return { label: 'Updated todos' }
    case 'NotebookEdit':
      return { label: 'Edited', arg: file && basename(file), argTitle: file }
    default:
      return { label: name }
  }
}
