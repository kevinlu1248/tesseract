/**
 * One-shot conversation title generation.
 *
 * The workspace is subscription-only (no API key, see subscriptionAuth.ts), so
 * the ONLY way to reach a model is the Agent SDK. We run a short, single-turn
 * `query()` with a cheap/fast model to summarize the first user message into a
 * 3–6 word title — the same "spawn a Haiku subagent for a small task" pattern
 * Claude Code uses internally.
 *
 * Isolation: the SDK persists every session as JSONL under the project's cwd,
 * and SessionManager.listSessions() reads that directory. To avoid polluting a
 * repo's session list with throwaway title queries, we run with cwd = a temp
 * dir. The title task needs no repo context — just the message text.
 */
import { tmpdir } from 'node:os'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { subscriptionOnlyEnv } from '../subscriptionAuth'
import { loadSdk } from './sdk'

/** Fast, cheap model for the throwaway summarization turn. */
const TITLE_MODEL = 'claude-haiku-4-5'

/** Cap how much of the first message we feed the titler. */
const MAX_INPUT_CHARS = 2000

function buildPrompt(message: string): string {
  return (
    'Write a concise title (3 to 6 words) summarizing the topic of a conversation ' +
    'that begins with the message below. Respond with ONLY the title — no surrounding ' +
    'quotes, no trailing punctuation, no preamble like "Title:".\n\n' +
    `Message:\n${message.slice(0, MAX_INPUT_CHARS)}`
  )
}

/** Strip quotes / trailing punctuation / stray prefixes and clamp the length. */
function cleanTitle(raw: string): string | null {
  let t = raw.trim()
  if (!t) return null
  // Take the first non-empty line — the model occasionally adds a stray newline.
  t = t.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  t = t.replace(/^(title|conversation)\s*[:\-—]\s*/i, '')
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, '').trim()
  if (!t) return null
  // A runaway response is not a title — reject rather than show a paragraph.
  if (t.length > 80) return null
  return t
}

/**
 * Generate a short title from the conversation's first user message.
 * Returns null on any failure — the caller keeps its placeholder title.
 */
export async function generateTitle(firstMessage: string): Promise<string | null> {
  const message = firstMessage.trim()
  if (!message) return null

  const options: Options = {
    cwd: tmpdir(),
    model: TITLE_MODEL,
    maxTurns: 1,
    permissionMode: 'default',
    // Title generation needs no tools — keep the turn to a single text reply.
    allowedTools: [],
    // Subscription-only: replace the subprocess env, stripping API-billing vars.
    env: subscriptionOnlyEnv()
  }

  try {
    const sdk = await loadSdk()
    const q = sdk.query({ prompt: buildPrompt(message), options })
    let text = ''
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result' && 'result' in msg && typeof msg.result === 'string') {
        text = msg.result
      }
    }
    return cleanTitle(text)
  } catch {
    // Network, auth, or model errors are non-fatal: the snippet title stands.
    return null
  }
}
