/**
 * Git worktree creation for workspaces. A "workspace" in Tesseract is a git
 * repo at some cwd; this lets the user spin off an isolated worktree (a new
 * branch checked out in its own directory) and run a session there without
 * disturbing the main working tree.
 *
 * Worktrees are placed INSIDE the repo at `.worktrees/<branch>` and excluded
 * from git via `.git/info/exclude` (no tracked-file changes). The branch name
 * is derived from the user's first prompt.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CreateWorktreeArgs, CreateWorktreeResult } from '../../shared/ipc'

const exec = promisify(execFile)

/** Directory (relative to the repo root) that holds all worktrees. */
const WORKTREES_DIR = '.worktrees'

/** Turn a free-text prompt into a safe, readable git branch slug. */
function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics → hyphen
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, 40)
    .replace(/-+$/g, '') // re-trim after the length cap
  return slug || 'task'
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** True if a local branch with this name already exists in the repo. */
async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
    return true
  } catch {
    return false
  }
}

/** Add `.worktrees/` to the repo's local excludes (best effort, idempotent). */
async function ensureExcluded(repoRoot: string): Promise<void> {
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude')
  try {
    const current = await readFile(excludePath, 'utf8').catch(() => '')
    const line = `${WORKTREES_DIR}/`
    if (current.split('\n').some((l) => l.trim() === line)) return
    const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`
    await writeFile(excludePath, `${prefix}${line}\n`)
  } catch {
    /* `.git` may be a file (nested worktree) or read-only — non-fatal */
  }
}

/**
 * Create a new git worktree (and branch) derived from the given prompt and
 * return its directory + branch. Throws if `cwd` is not inside a git repo or
 * the `git worktree add` fails.
 */
export async function createWorktree({
  cwd,
  prompt
}: CreateWorktreeArgs): Promise<CreateWorktreeResult> {
  // Resolve the repo root so `.worktrees/` sits at the top of the working tree
  // regardless of which subdirectory the workspace cwd points at.
  const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
  const repoRoot = stdout.trim()
  const worktreesDir = path.join(repoRoot, WORKTREES_DIR)
  await mkdir(worktreesDir, { recursive: true })
  await ensureExcluded(repoRoot)

  // Find a branch name (and matching dir) that doesn't collide with anything.
  const base = slugify(prompt)
  let branch = base
  let dir = path.join(worktreesDir, branch)
  for (let n = 2; (await pathExists(dir)) || (await branchExists(repoRoot, branch)); n++) {
    branch = `${base}-${n}`
    dir = path.join(worktreesDir, branch)
  }

  await exec('git', ['worktree', 'add', '-b', branch, dir], { cwd: repoRoot })
  return { path: dir, branch }
}
