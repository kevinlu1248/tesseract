import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionSummary } from '../../shared/ipc'
import type { TranscriptItem, UiMessage } from '../../shared/schema'

interface CodexSessionMeta {
  id?: string
  cwd?: string
  timestamp?: string
}

interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    type?: string
    message?: string
    last_agent_message?: string
    content?: Array<{ type?: string; text?: string }>
    role?: string
    cwd?: string
    timestamp?: string
  }
}

interface CodexSessionFile {
  path: string
  id: string
  cwd: string
  mtimeMs: number
  firstPrompt?: string
  lastAgentMessage?: string
}

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

async function readSessionIndex(): Promise<Map<string, string>> {
  const path = join(homedir(), '.codex', 'session_index.jsonl')
  const names = new Map<string, string>()
  try {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
    for await (const line of rl) {
      try {
        const rec = JSON.parse(line) as { id?: string; thread_name?: string }
        if (rec.id && rec.thread_name) names.set(rec.id, rec.thread_name)
      } catch {
        /* skip malformed records */
      }
    }
  } catch {
    /* no index yet */
  }
  return names
}

async function inspectSessionFile(path: string): Promise<CodexSessionFile | null> {
  const s = await stat(path).catch(() => null)
  if (!s) return null
  let meta: CodexSessionMeta | null = null
  let firstPrompt: string | undefined
  let lastAgentMessage: string | undefined
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    let rec: CodexRecord
    try {
      rec = JSON.parse(line) as CodexRecord
    } catch {
      continue
    }
    if (rec.type === 'session_meta') {
      meta = {
        id: rec.payload?.id,
        cwd: rec.payload?.cwd,
        timestamp: rec.payload?.timestamp
      }
      continue
    }
    if (rec.type === 'event_msg' && rec.payload?.type === 'user_message' && !firstPrompt) {
      firstPrompt = rec.payload.message
      continue
    }
    if (rec.type === 'event_msg' && rec.payload?.type === 'agent_message') {
      lastAgentMessage = rec.payload.message
      continue
    }
    if (rec.type === 'event_msg' && rec.payload?.type === 'task_complete') {
      lastAgentMessage = rec.payload.last_agent_message
    }
  }
  if (!meta?.id || !meta.cwd) return null
  return { path, id: meta.id, cwd: meta.cwd, mtimeMs: s.mtimeMs, firstPrompt, lastAgentMessage }
}

async function findSessionFiles(cwd?: string): Promise<CodexSessionFile[]> {
  const files = await walk(CODEX_SESSIONS_DIR)
  const inspected = await Promise.all(files.map(inspectSessionFile))
  return inspected
    .filter((f): f is CodexSessionFile => Boolean(f))
    .filter((f) => !cwd || f.cwd === cwd)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export async function listCodexSessions(cwd: string): Promise<SessionSummary[]> {
  const [files, names] = await Promise.all([findSessionFiles(cwd), readSessionIndex()])
  return files.slice(0, 50).map((f) => ({
    sessionId: f.id,
    summary: names.get(f.id) ?? f.lastAgentMessage ?? f.firstPrompt ?? f.id,
    lastModified: f.mtimeMs,
    firstPrompt: f.firstPrompt,
    provider: 'codex'
  }))
}

export async function loadCodexHistory(args: {
  sessionId: string
  cwd: string
}): Promise<TranscriptItem[]> {
  const files = await findSessionFiles(args.cwd)
  const file = files.find((f) => f.id === args.sessionId)
  if (!file) return []
  const items: TranscriptItem[] = []
  let seq = 0
  const rl = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity })
  for await (const line of rl) {
    let rec: CodexRecord
    try {
      rec = JSON.parse(line) as CodexRecord
    } catch {
      continue
    }
    const payload = rec.payload
    if (!payload) continue
    if (rec.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
      items.push(messageItem('user', `codex-h-user-${(seq += 1)}`, payload.message, rec.timestamp))
    } else if (rec.type === 'event_msg' && payload.type === 'agent_message' && payload.message) {
      items.push(
        messageItem('assistant', `codex-h-assistant-${(seq += 1)}`, payload.message, rec.timestamp)
      )
    }
  }
  return items
}

function messageItem(
  role: UiMessage['role'],
  id: string,
  text: string,
  timestamp?: string
): TranscriptItem {
  return {
    kind: 'message',
    message: {
      id,
      role,
      ts: timestamp ? Date.parse(timestamp) || Date.now() : Date.now(),
      blocks: text ? [{ kind: 'text', id: `${id}#0`, text }] : []
    }
  }
}
