/**
 * Workspace-level state: many concurrent sessions, each a tab. Per-session
 * transcript reduction is delegated to the existing sessionReducer — this layer
 * only owns cross-session concerns: tab order, the active tab, unread/archive
 * flags, and the per-tab "send when idle" message queue.
 */
import type { BackendProvider, SessionStatus, TranscriptItem } from '../../shared/ipc'
import type { UiImage } from '../../shared/schema'
import {
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState
} from './sessionStore'

/** A message typed while the session was busy, awaiting an idle turn to send. */
export interface QueuedMessage {
  text: string
  images?: UiImage[]
}

/**
 * An unsent draft (composer contents) for a tab. Held here — not in the
 * Composer's local state — so it survives the remount that happens when you
 * switch away from and back to a tab. Applies equally to a brand-new chat (no
 * messages yet) and an existing conversation you're appending to.
 */
export interface DraftMessage {
  text: string
  images: UiImage[]
}

/**
 * Statuses where the session is mid-turn and a new message must be queued.
 * Note: 'starting' is NOT busy — a booting session is ready to receive input
 * (the backend MessageQueue buffers it into the first turn), so the composer
 * should default to "Send", not "Queue".
 */
const BUSY: SessionStatus[] = ['connecting', 'running', 'awaiting-permission']
export function isBusy(status: SessionStatus): boolean {
  return BUSY.includes(status)
}

/** What the status dot in the sidebar should show for a tab. */
export type DotState = 'running' | 'unread' | 'none'
export function dotFor(status: SessionStatus, unread: boolean): DotState {
  // Only an actively-working session shows the yellow dot. 'starting' is a
  // ready-for-input session whose subprocess hasn't materialized yet (sends are
  // buffered) — isBusy() already treats it as not-busy, so it must not pulse.
  if (isBusy(status)) return 'running'
  if (unread) return 'unread' // green
  return 'none'
}

export interface Tab {
  localId: string
  title: string
  cwd: string
  provider: BackendProvider
  /** Finished producing output the user hasn't looked at since (→ green dot). */
  unread: boolean
  /** Archived tabs drop to a hidden group at the bottom of the sidebar. */
  archived: boolean
  /** Messages typed while busy, sent in order once the session goes idle. */
  queued: QueuedMessage[]
  /** True once the title has been derived from the first message. */
  titled: boolean
  /**
   * No live backend subprocess — it was reaped (idle too long or archived) to
   * free resources. The transcript stays cached; the session resumes via
   * --resume the next time the tab is focused or messaged.
   */
  suspended: boolean
  /**
   * Last-known SDK session id for this tab. Seeded from the resume id at open
   * time so the tab stays persisted even before the live session re-reports its
   * id via system_init (or if a resume fails transiently). The live session's
   * id, once known, takes precedence in the persist effect.
   */
  sdkSessionId?: string
  /** Monotonic creation order, for stable sorting. */
  seq: number
  /** Unsent composer contents, preserved across tab switches (remounts). */
  draft?: DraftMessage
}

/** Which edge of a pane a drag is dropped against. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * The layout of the main area, as a tree. A `leaf` is one session (its tab's
 * localId); a `split` lays its children out in a `row` (side by side) or a
 * `col` (stacked top to bottom). Nesting a row inside a col (and vice versa)
 * gives arbitrary tiled layouts. `null` means the main area is empty.
 *
 * Invariants the helpers maintain: a split always has ≥ 2 children, and a
 * leaf's id appears at most once in the whole tree.
 */
export type PaneNode =
  | { t: 'leaf'; id: string }
  | {
      t: 'split'
      dir: 'row' | 'col'
      children: PaneNode[]
      /**
       * Relative sizes (flex-grow weights) for each child, parallel to
       * `children`. Dragging a divider rewrites these. Absent — or out of sync
       * with the child count after a split/close — means "share equally", which
       * the renderer falls back to.
       */
      sizes?: number[]
    }

export interface WorkspaceState {
  sessions: Record<string, SessionState>
  tabs: Tab[]
  /**
   * Workspaces (by cwd) the user has hidden. A hidden workspace and all of its
   * sessions drop out of the main sidebar into a collapsed "Hidden" section;
   * reopening it (see `unhideWorkspace`) brings its non-archived sessions back.
   */
  hiddenWorkspaces: string[]
  /**
   * The sessions currently shown in the main area, as a layout tree (see
   * `PaneNode`). A lone leaf is the normal full-width view; any split is a tiled
   * layout. `activeId` is always one of the tree's leaves (the focused pane).
   * Drag-and-drop from the sidebar inserts or moves leaves via `splitPane`.
   */
  panes: PaneNode | null
  activeId: string | null
  /**
   * Whether the app window is focused/visible. A tab counts as "being looked
   * at" only when it is BOTH active AND the window is focused — so a turn that
   * finishes while the user is in another app still earns a green dot.
   */
  focused: boolean
  seq: number
}

export const initialWorkspaceState: WorkspaceState = {
  sessions: {},
  tabs: [],
  hiddenWorkspaces: [],
  panes: null,
  activeId: null,
  focused: true,
  seq: 0
}

export type WorkspaceAction =
  | {
      t: 'openTab'
      localId: string
      title: string
      cwd: string
      provider?: BackendProvider
      preloaded?: TranscriptItem[]
      status?: SessionStatus
      sdkSessionId?: string
      /** True when `title` is already a real title (e.g. a restored tab). */
      titled?: boolean
      /** Open beside the focused pane as a split, rather than replacing it. */
      split?: boolean
      /** Open without a live backend (restored/reaped) — resumes on first use. */
      suspended?: boolean
    }
  | { t: 'setActive'; localId: string }
  /** Backend subprocess was reaped — keep the tab + transcript, mark dormant. */
  | { t: 'suspend'; localId: string }
  /** Backend is being resumed — mark the tab live again. */
  | { t: 'revive'; localId: string }
  /** Drop a session into the split next to `anchorId`, on the given side. */
  | { t: 'splitPane'; localId: string; anchorId: string; side: Side }
  /** Remove a session from the split view (the session itself stays open). */
  | { t: 'closePane'; localId: string }
  /**
   * Set the child sizes (flex-grow weights) of the split at `path` — the chain
   * of child indices from the root to that split — after dragging its divider.
   */
  | { t: 'resizePane'; path: number[]; sizes: number[] }
  /**
   * Re-apply a saved pane layout at startup. `keep` limits it to tabs that
   * actually restored (and the reducer further prunes to live sessions), so a
   * tab that failed to come back can't leave a dangling pane.
   */
  | { t: 'restorePanes'; panes: PaneNode | null; activeId: string | null; keep: Set<string> }
  | { t: 'setFocus'; focused: boolean }
  | { t: 'archive'; localId: string }
  | { t: 'unarchive'; localId: string }
  /** Hide a whole workspace (cwd) — its sessions drop to the Hidden section. */
  | { t: 'hideWorkspace'; cwd: string }
  /** Reopen a hidden workspace, surfacing its most recent non-archived session. */
  | { t: 'unhideWorkspace'; cwd: string }
  | { t: 'closeTab'; localId: string }
  | { t: 'rename'; localId: string; title: string }
  /** Save (or clear) the unsent composer contents for a tab. */
  | { t: 'setDraft'; localId: string; text: string; images: UiImage[] }
  | { t: 'enqueue'; localId: string; text: string; images?: UiImage[] }
  | { t: 'unqueue'; localId: string; index: number }
  | { t: 'dequeue'; localId: string }
  /**
   * Replace a tab's conversation with a blank one: wipe the transcript and
   * forget the SDK session id so the next message starts a fresh thread rather
   * than resuming. The backend subprocess is reaped separately (see
   * useWorkspace.clearSession); the tab is marked suspended so the next
   * send/focus revives it fresh (no --resume).
   */
  | { t: 'clearSession'; localId: string }
  | { t: 'session'; localId: string; action: SessionAction }

function patchTab(state: WorkspaceState, localId: string, fn: (t: Tab) => Tab): Tab[] {
  return state.tabs.map((t) => (t.localId === localId ? fn(t) : t))
}

/**
 * Pick the next visible tab to focus after the current one leaves — skipping
 * archived tabs and any tab belonging to a hidden workspace.
 */
function nextActive(tabs: Tab[], leaving: string, hidden: string[]): string | null {
  const visible = tabs.filter(
    (t) => !t.archived && !hidden.includes(t.cwd) && t.localId !== leaving
  )
  return visible.length ? visible[visible.length - 1].localId : null
}

// ── Pane-tree helpers ──────────────────────────────────────────────────────
// All operations are pure and rebuild only the spine they touch. Two invariants
// are preserved everywhere: splits never drop below 2 children (a split that
// would have one child collapses into that child), and a given leaf id appears
// at most once in the tree.

const leaf = (id: string): PaneNode => ({ t: 'leaf', id })

/** Every leaf id in the tree, in visual (left→right, top→bottom) order. */
export function paneIds(node: PaneNode | null): string[] {
  if (!node) return []
  return node.t === 'leaf' ? [node.id] : node.children.flatMap(paneIds)
}

function hasLeaf(node: PaneNode | null, id: string): boolean {
  return paneIds(node).includes(id)
}

function lastId(node: PaneNode | null): string | null {
  const ids = paneIds(node)
  return ids.length ? ids[ids.length - 1] : null
}

/** Drop a leaf, collapsing any split left with a single child. */
function removeLeaf(node: PaneNode | null, id: string): PaneNode | null {
  if (!node) return null
  if (node.t === 'leaf') return node.id === id ? null : node
  const children = node.children
    .map((c) => removeLeaf(c, id))
    .filter((c): c is PaneNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children }
}

/** Like removeLeaf, but drops every leaf failing `keep` in one pass. */
export function pruneTree(node: PaneNode | null, keep: (id: string) => boolean): PaneNode | null {
  if (!node) return null
  if (node.t === 'leaf') return keep(node.id) ? node : null
  const children = node.children
    .map((c) => pruneTree(c, keep))
    .filter((c): c is PaneNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children }
}

/** Swap the id carried by one leaf (used to focus a tab into an existing pane). */
function replaceLeaf(node: PaneNode, oldId: string, newId: string): PaneNode {
  if (node.t === 'leaf') return node.id === oldId ? leaf(newId) : node
  return { ...node, children: node.children.map((c) => replaceLeaf(c, oldId, newId)) }
}

const sideToDir = (side: Side): 'row' | 'col' =>
  side === 'left' || side === 'right' ? 'row' : 'col'
const sideIsBefore = (side: Side): boolean => side === 'left' || side === 'top'

/**
 * Insert a new leaf adjacent to the `anchorId` leaf on the given side. When the
 * split directly containing the anchor already runs in the requested direction
 * the new pane joins it as a sibling; otherwise the anchor leaf is wrapped in a
 * fresh nested split of the requested direction. Caller must ensure `newId`
 * isn't already in the tree (splitPane removes it first to move rather than dupe).
 */
function insertBeside(node: PaneNode, anchorId: string, newId: string, side: Side): PaneNode {
  const dir = sideToDir(side)
  const before = sideIsBefore(side)
  const wrap = (anchor: PaneNode): PaneNode => ({
    t: 'split',
    dir,
    children: before ? [leaf(newId), anchor] : [anchor, leaf(newId)]
  })

  // The whole tree is just the anchor leaf → wrap it in a 2-pane split.
  if (node.t === 'leaf') return node.id === anchorId ? wrap(node) : node

  const idx = node.children.findIndex((c) => c.t === 'leaf' && c.id === anchorId)
  if (idx !== -1) {
    if (node.dir === dir) {
      // Same orientation as the anchor's split → add the new pane as a sibling.
      const children = [...node.children]
      children.splice(before ? idx : idx + 1, 0, leaf(newId))
      return { ...node, children }
    }
    // Cross orientation → wrap just the anchor leaf in a nested split.
    return { ...node, children: node.children.map((c, i) => (i === idx ? wrap(c) : c)) }
  }

  // Anchor lives deeper down → recurse into the subtree that contains it.
  return {
    ...node,
    children: node.children.map((c) =>
      hasLeaf(c, anchorId) ? insertBeside(c, anchorId, newId, side) : c
    )
  }
}

/**
 * Set `sizes` on the split reached by following `path` (a chain of child
 * indices from the root). Returns the node unchanged if the path doesn't land
 * on a split, or `sizes` doesn't match that split's child count — so a stale
 * path (e.g. after the tree was reshaped) is a safe no-op rather than a crash.
 */
function setSizesAt(node: PaneNode, path: number[], sizes: number[]): PaneNode {
  if (path.length === 0) {
    if (node.t !== 'split' || sizes.length !== node.children.length) return node
    return { ...node, sizes }
  }
  if (node.t !== 'split') return node
  const [i, ...rest] = path
  if (i < 0 || i >= node.children.length) return node
  const child = setSizesAt(node.children[i], rest, sizes)
  if (child === node.children[i]) return node
  const children = [...node.children]
  children[i] = child
  return { ...node, children }
}

/** Keep `activeId` pointing at a real pane: itself if still shown, else the last. */
function fixActive(panes: PaneNode | null, activeId: string | null): string | null {
  if (!panes) return null
  return activeId && hasLeaf(panes, activeId) ? activeId : lastId(panes)
}

/**
 * Bring `localId` into view as the focused pane without growing the split: if
 * it's already a pane, leave the layout alone; otherwise replace the currently
 * focused pane (falling back to the last) with it, or open a single pane when
 * there is none.
 */
function showInActivePane(
  panes: PaneNode | null,
  activeId: string | null,
  localId: string
): PaneNode | null {
  if (hasLeaf(panes, localId)) return panes
  if (!panes) return leaf(localId)
  const target = activeId && hasLeaf(panes, activeId) ? activeId : lastId(panes)
  return target ? replaceLeaf(panes, target, localId) : leaf(localId)
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction
): WorkspaceState {
  switch (action.t) {
    case 'openTab': {
      const seq = state.seq + 1
      const tab: Tab = {
        localId: action.localId,
        title: action.title,
        cwd: action.cwd,
        provider: action.provider ?? 'claude',
        unread: false,
        archived: false,
        queued: [],
        titled: action.titled ?? false,
        suspended: action.suspended ?? false,
        sdkSessionId: action.sdkSessionId,
        seq
      }
      // A freshly opened session takes over the main area as a single pane —
      // unless `split` is set, in which case it opens just to the right of the
      // focused pane, growing the split.
      let panes: PaneNode | null
      if (action.split && state.panes) {
        const anchor = fixActive(state.panes, state.activeId)
        panes = anchor
          ? insertBeside(state.panes, anchor, action.localId, 'right')
          : leaf(action.localId)
      } else {
        panes = leaf(action.localId)
      }
      return {
        ...state,
        seq,
        activeId: action.localId,
        panes,
        tabs: [...state.tabs, tab],
        sessions: {
          ...state.sessions,
          [action.localId]: {
            ...initialSessionState,
            items: action.preloaded ?? [],
            status: action.status ?? 'starting'
          }
        }
      }
    }

    case 'setActive':
      return {
        ...state,
        // Selecting a tab from the sidebar focuses it: if it's already a pane,
        // just focus it; otherwise it replaces the focused pane (the split keeps
        // its shape). Use splitPane to add a pane instead of replacing one.
        panes: showInActivePane(state.panes, state.activeId, action.localId),
        activeId: action.localId,
        // Focusing a tab clears its unread flag (green → none).
        tabs: patchTab(state, action.localId, (t) => ({ ...t, unread: false }))
      }

    case 'suspend': {
      const sess = state.sessions[action.localId]
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({ ...t, suspended: true })),
        sessions: sess
          ? { ...state.sessions, [action.localId]: { ...sess, status: 'suspended' } }
          : state.sessions
      }
    }

    case 'revive': {
      const sess = state.sessions[action.localId]
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({ ...t, suspended: false })),
        // Resumed sessions are idle and ready for input; live events take over.
        sessions: sess
          ? { ...state.sessions, [action.localId]: { ...sess, status: 'idle' } }
          : state.sessions
      }
    }

    case 'splitPane': {
      // Focusing a pane onto itself is a no-op beyond clearing unread.
      if (action.localId === action.anchorId) {
        return {
          ...state,
          activeId: action.localId,
          tabs: patchTab(state, action.localId, (t) => ({ ...t, unread: false }))
        }
      }
      // Remove first so dragging an existing pane MOVES it rather than dupes it.
      const without = removeLeaf(state.panes, action.localId)
      let panes: PaneNode | null
      if (!without) {
        panes = leaf(action.localId)
      } else if (hasLeaf(without, action.anchorId)) {
        panes = insertBeside(without, action.anchorId, action.localId, action.side)
      } else {
        // Anchor no longer present (shouldn't happen) — attach beside the last.
        const fallback = lastId(without)
        panes = fallback
          ? insertBeside(without, fallback, action.localId, action.side)
          : leaf(action.localId)
      }
      return {
        ...state,
        panes,
        activeId: action.localId,
        tabs: patchTab(state, action.localId, (t) => ({ ...t, unread: false }))
      }
    }

    case 'closePane': {
      // Never empty the main area — the last pane can't be closed this way.
      if (paneIds(state.panes).length <= 1) return state
      const panes = removeLeaf(state.panes, action.localId)
      return { ...state, panes, activeId: fixActive(panes, state.activeId) }
    }

    case 'resizePane': {
      if (!state.panes) return state
      const panes = setSizesAt(state.panes, action.path, action.sizes)
      if (panes === state.panes) return state
      return { ...state, panes }
    }

    case 'restorePanes': {
      // Keep only leaves that restored AND have a live session entry.
      const panes = pruneTree(
        action.panes,
        (id) => action.keep.has(id) && Boolean(state.sessions[id])
      )
      // Nothing usable in the saved layout → leave the current panes alone.
      if (!panes) return state
      return { ...state, panes, activeId: fixActive(panes, action.activeId) }
    }

    case 'setFocus': {
      if (state.focused === action.focused) return state
      // Regaining window focus means the user is now looking at the active tab,
      // so clear its unread flag (it may have been set while the window was in
      // the background). Other tabs stay unread until explicitly selected.
      const tabs =
        action.focused && state.activeId
          ? patchTab(state, state.activeId, (t) => ({ ...t, unread: false }))
          : state.tabs
      return { ...state, focused: action.focused, tabs }
    }

    case 'archive': {
      const tabs = patchTab(state, action.localId, (t) => ({
        ...t,
        archived: true,
        unread: false
      }))
      // Drop the archived session from the split; if that empties the view,
      // fall back to the most recent other visible tab.
      let panes = removeLeaf(state.panes, action.localId)
      if (!panes) {
        const fb = nextActive(tabs, action.localId, state.hiddenWorkspaces)
        panes = fb ? leaf(fb) : null
      }
      return { ...state, tabs, panes, activeId: fixActive(panes, state.activeId) }
    }

    case 'unarchive': {
      const tabs = patchTab(state, action.localId, (t) => ({ ...t, archived: false }))
      // Restore it into the focused pane (matching sidebar selection). Also make
      // sure its workspace isn't hidden, so the restored tab is actually visible.
      const panes = showInActivePane(state.panes, state.activeId, action.localId)
      const tab = state.tabs.find((t) => t.localId === action.localId)
      const hiddenWorkspaces = tab
        ? state.hiddenWorkspaces.filter((c) => c !== tab.cwd)
        : state.hiddenWorkspaces
      return { ...state, tabs, hiddenWorkspaces, panes, activeId: action.localId }
    }

    case 'hideWorkspace': {
      const hiddenWorkspaces = state.hiddenWorkspaces.includes(action.cwd)
        ? state.hiddenWorkspaces
        : [...state.hiddenWorkspaces, action.cwd]
      // Drop every pane belonging to the hidden workspace; if that empties the
      // main area, fall back to the most recent still-visible session.
      const hiddenIds = new Set(
        state.tabs.filter((t) => t.cwd === action.cwd).map((t) => t.localId)
      )
      let panes = pruneTree(state.panes, (id) => !hiddenIds.has(id))
      if (!panes) {
        const fb = nextActive(state.tabs, '', hiddenWorkspaces)
        panes = fb ? leaf(fb) : null
      }
      return { ...state, hiddenWorkspaces, panes, activeId: fixActive(panes, state.activeId) }
    }

    case 'unhideWorkspace': {
      const hiddenWorkspaces = state.hiddenWorkspaces.filter((c) => c !== action.cwd)
      // Reopening a workspace surfaces its most recent non-archived session into
      // the focused pane — the rest reappear in the sidebar (revive on click).
      const candidates = state.tabs
        .filter((t) => t.cwd === action.cwd && !t.archived)
        .sort((a, b) => a.seq - b.seq)
      const top = candidates.length ? candidates[candidates.length - 1].localId : null
      if (!top) return { ...state, hiddenWorkspaces }
      return {
        ...state,
        hiddenWorkspaces,
        panes: showInActivePane(state.panes, state.activeId, top),
        activeId: top,
        tabs: patchTab(state, top, (t) => ({ ...t, unread: false }))
      }
    }

    case 'closeTab': {
      const tabs = state.tabs.filter((t) => t.localId !== action.localId)
      const { [action.localId]: _removed, ...sessions } = state.sessions
      let panes = removeLeaf(state.panes, action.localId)
      if (!panes) {
        const fb = nextActive(tabs, action.localId, state.hiddenWorkspaces)
        panes = fb ? leaf(fb) : null
      }
      return { ...state, tabs, sessions, panes, activeId: fixActive(panes, state.activeId) }
    }

    case 'rename':
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({
          ...t,
          title: action.title,
          titled: true
        }))
      }

    case 'setDraft': {
      const tab = state.tabs.find((t) => t.localId === action.localId)
      if (!tab) return state
      const empty = action.text.trim() === '' && action.images.length === 0
      // No-op when nothing actually changes — keeps the per-keystroke dispatch
      // (and the mount-time sync) from forcing a needless workspace re-render.
      if (empty && !tab.draft) return state
      if (
        tab.draft &&
        tab.draft.text === action.text &&
        tab.draft.images === action.images
      )
        return state
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({
          ...t,
          draft: empty ? undefined : { text: action.text, images: action.images }
        }))
      }
    }

    case 'enqueue':
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({
          ...t,
          queued: [...t.queued, { text: action.text, images: action.images }]
        }))
      }

    case 'unqueue':
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({
          ...t,
          queued: t.queued.filter((_, i) => i !== action.index)
        }))
      }

    case 'dequeue':
      return {
        ...state,
        tabs: patchTab(state, action.localId, (t) => ({ ...t, queued: t.queued.slice(1) }))
      }

    case 'clearSession': {
      const sess = state.sessions[action.localId]
      if (!sess) return state
      return {
        ...state,
        // Forget the resume id and mark the tab suspended (no live backend) so
        // the next send/focus revives a brand-new SDK session instead of
        // resuming the wiped one. Drop any queued/drafted input too — it
        // belonged to the conversation we just cleared.
        tabs: patchTab(state, action.localId, (t) => ({
          ...t,
          sdkSessionId: undefined,
          suspended: true,
          unread: false,
          queued: [],
          draft: undefined
        })),
        sessions: {
          ...state.sessions,
          [action.localId]: sessionReducer(sess, { t: 'clear' })
        }
      }
    }

    case 'session': {
      const prev = state.sessions[action.localId]
      if (!prev) return state
      const next = sessionReducer(prev, action.action)
      if (next === prev) return state
      // A turn that finishes becomes "done & unread" unless the user is
      // actively looking at it — i.e. it is the active tab AND the app window is
      // focused. Finishing while the user is on another tab, or in another app
      // entirely, earns a green dot.
      const becameIdle = prev.status !== 'idle' && next.status === 'idle'
      const beingViewed = action.localId === state.activeId && state.focused
      const tabs =
        becameIdle && !beingViewed
          ? patchTab(state, action.localId, (t) => ({ ...t, unread: true }))
          : state.tabs
      return {
        ...state,
        tabs,
        sessions: { ...state.sessions, [action.localId]: next }
      }
    }
  }
}
