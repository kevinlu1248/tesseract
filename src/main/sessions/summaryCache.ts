/**
 * Persistent cache of AI-generated conversation summaries (title + description).
 *
 * Generating a summary costs a model round-trip, so we do it once per
 * conversation and remember the result across app restarts in a small JSON file
 * under userData. An entry is keyed by sessionId and tagged with the
 * conversation's lastModified time: when a conversation grows (lastModified
 * advances), its cached summary is considered stale and regenerated.
 */
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CachedSummary {
  title: string
  description: string
  /** lastModified of the conversation when this summary was generated. */
  lastModified: number
}

type CacheShape = Record<string, CachedSummary>

export class SummaryCache {
  private cache: CacheShape | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly file = join(app.getPath('userData'), 'session-summaries.json')

  private async load(): Promise<CacheShape> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.cache = parsed && typeof parsed === 'object' ? (parsed as CacheShape) : {}
    } catch {
      // Missing or corrupt file — start fresh.
      this.cache = {}
    }
    return this.cache
  }

  /** Return the cached summary iff it exists and matches the conversation's mtime. */
  async getFresh(sessionId: string, lastModified: number): Promise<CachedSummary | null> {
    const cache = await this.load()
    const hit = cache[sessionId]
    if (hit && hit.lastModified === lastModified) return hit
    return null
  }

  async set(sessionId: string, value: CachedSummary): Promise<void> {
    const cache = await this.load()
    cache[sessionId] = value
    this.scheduleWrite()
  }

  /** Debounced write — background generation finishes in bursts. */
  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, 500)
  }

  private async flush(): Promise<void> {
    if (!this.cache) return
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify(this.cache), 'utf8')
    } catch {
      // A failed cache write only costs a future regeneration — never fatal.
    }
  }
}
