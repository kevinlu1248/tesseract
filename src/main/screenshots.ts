/**
 * Locates the most recently captured screenshot so the renderer can offer a
 * one-click "add to context" chip. Best-effort and cross-platform-tolerant:
 * scans the common screenshot directories, matches typical screenshot file
 * names, and returns the newest one captured within a recency window.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RecentScreenshot } from '../shared/ipc'

const execFileAsync = promisify(execFile)

/** Only surface screenshots captured this recently (ms). */
const RECENCY_MS = 5 * 60 * 1000
/** Don't try to inline anything larger than this (base64 over IPC). */
const MAX_BYTES = 12 * 1024 * 1024

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/**
 * Heuristic screenshot name match. Covers macOS ("Screenshot …", legacy
 * "Screen Shot …"), Windows ("Screenshot (1).png"), and common Linux tools
 * (gnome-screenshot, flameshot, spectacle, grim). Case-insensitive.
 */
function looksLikeScreenshot(name: string): boolean {
  return /(^|[^a-z])(screen[ _-]?shot|screenshot|capture|screen[ _-]?clip|grim|spectacle|flameshot)/i.test(
    name
  )
}

/** Read the user's configured macOS screenshot location, if any. */
async function macScreenshotDir(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('defaults', [
      'read',
      'com.apple.screencapture',
      'location'
    ])
    const dir = stdout.trim()
    return dir ? dir.replace(/^~/, os.homedir()) : null
  } catch {
    return null // key unset → default (Desktop), handled by candidate list
  }
}

function candidateDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures'),
    path.join(home, 'Pictures', 'Screenshots'),
    path.join(home, 'Screenshots')
  ]
}

/** Find the newest screenshot captured within {@link RECENCY_MS}, or null. */
export async function findRecentScreenshot(): Promise<RecentScreenshot | null> {
  const now = Date.now()
  const configured = await macScreenshotDir()
  const dirs = Array.from(new Set([configured, ...candidateDirs()].filter(Boolean) as string[]))

  let best: { path: string; name: string; takenAt: number } | null = null

  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue // dir doesn't exist / not readable
    }
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase()
      if (!IMAGE_EXT[ext]) continue
      if (!looksLikeScreenshot(name)) continue
      const full = path.join(dir, name)
      try {
        const info = await stat(full)
        if (!info.isFile()) continue
        const takenAt = info.mtimeMs
        if (now - takenAt > RECENCY_MS) continue
        if (info.size > MAX_BYTES) continue
        if (!best || takenAt > best.takenAt) best = { path: full, name, takenAt }
      } catch {
        continue
      }
    }
  }

  if (!best) return null

  try {
    const bytes = await readFile(best.path)
    const ext = path.extname(best.name).toLowerCase()
    return {
      path: best.path,
      name: best.name,
      takenAt: best.takenAt,
      image: { mediaType: IMAGE_EXT[ext], data: bytes.toString('base64') }
    }
  } catch {
    return null
  }
}
