/**
 * One-shot conversation summary generation — an AI title + short description for
 * a past conversation, shown on the new-session screen's "recent conversations"
 * cards.
 *
 * Same constraints as generateTitle.ts: the workspace is subscription-only, so
 * the only path to a model is a short single-turn Agent SDK `query()` with a
 * cheap/fast model. We run with cwd = a temp dir so these throwaway queries
 * never pollute a repo's persisted session list.
 *
 * Input is the cheap context we already have from listSessions() — the first
 * user prompt and the SDK's rolling summary (usually the last agent message) —
 * so we never have to load full JSONL history just to caption a card.
 */
import { tmpdir } from 'node:os'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { subscriptionOnlyEnv } from '../subscriptionAuth'
import { loadSdk } from './sdk'

/** Fast, cheap model for the throwaway summarization turn. */
const SUMMARY_MODEL = 'claude-haiku-4-5'

/** Cap how much context we feed the summarizer. */
const MAX_INPUT_CHARS = 2000

export interface GeneratedSummary {
  title: string
  description: string
}

function buildPrompt(firstPrompt: string, summary: string): string {
  const ctx = [
    firstPrompt && `First user message:\n${firstPrompt.slice(0, MAX_INPUT_CHARS)}`,
    summary && `Latest state / last assistant message:\n${summary.slice(0, MAX_INPUT_CHARS)}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return (
    'You are labelling a past coding conversation for a "recent conversations" list. ' +
    'Given the context below, respond with ONLY a JSON object of the form ' +
    '{"title": "...", "description": "..."} and nothing else.\n' +
    '- title: 3 to 6 words naming the topic. No quotes, no trailing punctuation.\n' +
    '- description: one or two sentences (under 160 characters) describing what the ' +
    'conversation is about or what was accomplished.\n\n' +
    ctx
  )
}

/** Pull the first balanced {...} object out of a model reply and parse it. */
function parseSummary(raw: string): GeneratedSummary | null {
  const text = raw.trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const record = obj as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  if (!title || !description) return null
  // A runaway response is not a card caption — reject rather than show a wall.
  if (title.length > 80 || description.length > 300) return null
  return { title, description }
}

/**
 * Generate a title + description summarizing a conversation. Returns null on any
 * failure — callers keep their raw-text fallback.
 */
export async function generateSummary(
  firstPrompt: string,
  summary: string
): Promise<GeneratedSummary | null> {
  const fp = (firstPrompt || '').trim()
  const sm = (summary || '').trim()
  if (!fp && !sm) return null

  const options: Options = {
    cwd: tmpdir(),
    model: SUMMARY_MODEL,
    maxTurns: 1,
    permissionMode: 'default',
    allowedTools: [],
    env: subscriptionOnlyEnv()
  }

  try {
    const sdk = await loadSdk()
    const q = sdk.query({ prompt: buildPrompt(fp, sm), options })
    let text = ''
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result' && 'result' in msg && typeof msg.result === 'string') {
        text = msg.result
      }
    }
    return parseSummary(text)
  } catch {
    // Network, auth, or model errors are non-fatal: the raw-text fallback stands.
    return null
  }
}
