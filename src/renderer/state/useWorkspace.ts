import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventEnvelope,
  SessionStatus,
  StartSessionArgs,
  TranscriptItem,
  BackendProvider
} from '../../shared/ipc'
import type { UiImage } from '../../shared/schema'
import { StreamSmoother } from './streamSmoother'
import { isBusy, paneIds } from './workspaceStore'
import {
  initialWorkspaceState,
  workspaceReducer,
  type PaneNode,
  type Side,
  type WorkspaceState
} from './workspaceStore'

let userSeq = 0

/**
 * localStorage key for the persisted open-tab list. Bumped to v2 to drop the
 * bloated list accumulated by the earlier eager-restore behavior (clean slate).
 */
const TABS_KEY = 'cw.tabs.v2'

/** localStorage key for the set of hidden workspaces (by cwd). */
const HIDDEN_KEY = 'cw.hidden.v1'

/**
 * localStorage key for the pane layout tree (and which pane was focused) so a
 * restart restores the split arrangement, not just a single pane. Leaves are
 * keyed by `localId`, which we persist per tab and reuse on restore so the tree
 * lines up with the restored tabs.
 */
const PANES_KEY = 'cw.panes.v1'

/**
 * How many of a workspace's recent conversations to surface (as lazy, suspended
 * tabs) when it's first opened. Opening a workspace shows its recent convos
 * instead of prompting which one to resume; the cap keeps the sidebar sane for
 * repos with a long history. They're suspended, so this spawns no subprocesses.
 */
const RECENT_CONVOS_ON_OPEN = 10

/** A session idle and off-screen this long gets its subprocess reaped. */
const REAP_IDLE_MS = 5 * 60 * 1000

function newLocalId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.round(Math.random() * 1e9)}`
}

/**
 * A short, single-line preview of a session's most recent message — preferring
 * the assistant's last reply (what just finished), falling back to the last
 * user message. Used as the body of the "finished" desktop notification so the
 * user can tell which session it is and what it said. Returns '' if there's no
 * usable text.
 */
function lastMessagePreview(items: TranscriptItem[] | undefined): string {
  if (!items) return ''
  const textOf = (role: 'assistant' | 'user'): string => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind !== 'message' || it.message.role !== role) continue
      const text = it.message.blocks
        .filter((b) => b.kind === 'text')
        .map((b) => (b as { text: string }).text)
        .join(' ')
        .trim()
      if (text) return text
    }
    return ''
  }
  const raw = textOf('assistant') || textOf('user')
  if (!raw) return ''
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine
}

/** The full text of the first user message in a transcript ('' if none). */
function firstUserText(items: TranscriptItem[] | undefined): string {
  if (!items) return ''
  for (const it of items) {
    if (it.kind !== 'message' || it.message.role !== 'user') continue
    const text = it.message.blocks
      .filter((b) => b.kind === 'text')
      .map((b) => (b as { text: string }).text)
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/** The full text of the most recent assistant message ('' if none). */
function lastAssistantText(items: TranscriptItem[] | undefined): string {
  if (!items) return ''
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind !== 'message' || it.message.role !== 'assistant') continue
    const text = it.message.blocks
      .filter((b) => b.kind === 'text')
      .map((b) => (b as { text: string }).text)
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/** Hard cap on a re-fed transcript so a huge history can't blow the context. */
const MAX_PRIMER_CHARS = 60_000

/** Separator between the re-fed prior transcript and the user's live message. */
const PRIMER_SEPARATOR =
  '\n\n──────────\n[End of restored conversation. Continue from here — answer the message below.]\n\n'

/**
 * Flatten a transcript into compact text to re-feed as context after a resume
 * dropped the conversation's memory. User/assistant prose is included verbatim;
 * tool calls collapse to a one-line marker (the model needs the gist, not every
 * argument). Oldest turns are trimmed first if the result exceeds the cap.
 */
function serializeTranscript(items: TranscriptItem[] | undefined): string {
  if (!items?.length) return ''
  const lines: string[] = []
  for (const it of items) {
    if (it.kind === 'tool_result') continue // folded into its tool_use marker
    if (it.kind !== 'message') continue
    const role = it.message.role === 'user' ? 'User' : 'Assistant'
    const parts: string[] = []
    for (const b of it.message.blocks) {
      if (b.kind === 'text') parts.push(b.text)
      else if (b.kind === 'thinking') continue // internal — not re-fed
      else if (b.kind === 'tool_use') parts.push(`[used tool: ${b.name}]`)
      else if (b.kind === 'image') parts.push('[image]')
    }
    const text = parts.join('\n').trim()
    if (text) lines.push(`${role}: ${text}`)
  }
  let out = lines.join('\n\n')
  if (out.length > MAX_PRIMER_CHARS) out = `…(earlier turns trimmed)…\n\n${out.slice(-MAX_PRIMER_CHARS)}`
  if (!out) return ''
  return `[Reconnected — the earlier conversation below was restored from the local transcript because the session's memory was lost. Use it as context.]\n\n${out}`
}

interface PersistedTab {
  /**
   * The tab's localId, persisted (and reused on restore) so the saved pane tree
   * — whose leaves are localIds — lines up with the restored tabs. Optional for
   * backward compat with lists written before this was added.
   */
  localId?: string
  cwd: string
  provider?: BackendProvider
  title: string
  /** Resume id; absent for a tab opened but never messaged (restored fresh). */
  sdkSessionId?: string
  archived: boolean
}

/** The persisted main-area layout: the pane tree plus the focused pane. */
interface PersistedLayout {
  panes: PaneNode | null
  activeId: string | null
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine
}

/**
 * Owns every open session as a tab. Each session gets its own StreamSmoother so
 * concurrent streams render smoothly and independently. Routing is by localId,
 * so multiple tabs can stream at the same time without interleaving.
 */
export function useWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState)
  const stateRef = useRef<WorkspaceState>(state)
  stateRef.current = state

  // Capture the saved tabs once during the first render — before the persist
  // effect below can overwrite localStorage with the (initially empty) state.
  const savedOnce = useRef<PersistedTab[] | null>(null)
  if (savedOnce.current === null) {
    try {
      savedOnce.current = JSON.parse(localStorage.getItem(TABS_KEY) || '[]') as PersistedTab[]
    } catch {
      savedOnce.current = []
    }
  }
  // The workspaces that were hidden in the last session, restored once at start.
  const savedHiddenOnce = useRef<string[] | null>(null)
  if (savedHiddenOnce.current === null) {
    try {
      savedHiddenOnce.current = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[]
    } catch {
      savedHiddenOnce.current = []
    }
  }
  // The pane layout (split tree + focused pane) from the last session, applied
  // once after the tabs are restored. `undefined` means "not yet read".
  const savedPanesOnce = useRef<PersistedLayout | null | undefined>(undefined)
  if (savedPanesOnce.current === undefined) {
    try {
      const raw = localStorage.getItem(PANES_KEY)
      savedPanesOnce.current = raw ? (JSON.parse(raw) as PersistedLayout) : null
    } catch {
      savedPanesOnce.current = null
    }
  }
  // `started` guards the one-time restore pass; `ready` gates persistence so we
  // never overwrite the saved tab list until restore has FULLY completed.
  // (Flipping a single flag synchronously at restore-start let a mid-restore
  // re-render — e.g. the window gaining focus — persist the still-empty state
  // and clobber the saved tabs before they came back.)
  const started = useRef(false)
  const ready = useRef(false)
  // True while the one-time startup restore is still bringing saved tabs back.
  // It starts true ONLY if there were saved tabs to restore, so a genuine first
  // launch (nothing saved) shows the launcher immediately. While restoring, the
  // app shows a quiet loading state instead of the launcher — otherwise the
  // first render (tabs still empty) would flash the "new / resume session"
  // prompt before the restored tabs land.
  const [restoring, setRestoring] = useState(() => (savedOnce.current?.length ?? 0) > 0)

  const smoothers = useRef<Map<string, StreamSmoother>>(new Map())
  // Events for a session can land before its tab is registered (the SDK's
  // system/init races startSession resolving). Hold them until the tab exists.
  const earlyBuffer = useRef<SessionEventEnvelope[]>([])
  // localId → epoch ms when it most recently became idle (for the reaper).
  const idleSince = useRef<Map<string, number>>(new Map())
  // localId → the status we last observed, so we can detect a busy→idle edge
  // (a completed task) and refresh that conversation's cached AI description.
  const lastSummaryStatus = useRef<Map<string, SessionStatus>>(new Map())
  // localId → serialized prior transcript to re-feed on the next send, captured
  // when a resume reported context loss. Consumed (and cleared) by doSend so the
  // recovered history rides along with the user's next real message.
  const pendingPrimer = useRef<Map<string, string>>(new Map())

  const ensureSmoother = useCallback((localId: string): StreamSmoother => {
    let sm = smoothers.current.get(localId)
    if (!sm) {
      sm = new StreamSmoother((event) =>
        dispatch({ t: 'session', localId, action: { t: 'event', event } })
      )
      smoothers.current.set(localId, sm)
    }
    return sm
  }, [])

  // Show a desktop notification the moment a tab flips to "unread" — i.e. a turn
  // finished while the user wasn't looking at it. Clicking the notification
  // brings the app forward and opens that tab. We track which tabs we've already
  // notified so re-renders don't re-fire, and clear the mark when the tab is read
  // again (so its next background completion notifies afresh).
  const notified = useRef<Set<string>>(new Set())
  // The notification is created and owned by the MAIN process (see main/ipc.ts),
  // which also handles the click: it focuses the window and pushes back the
  // localId via onNotificationClicked. Creating it renderer-side as a Web
  // Notification was fragile — the object could be GC'd before the click,
  // dropping its `onclick` and letting the OS fall back to its default
  // activation (which surfaced the repo picker instead of the conversation).
  const notify = useCallback((localId: string, title: string, preview: string) => {
    window.api.showNotification({ localId, title, body: preview })
  }, [])

  // A notification click (handled in main) tells us which tab to open.
  useEffect(() => {
    return window.api.onNotificationClicked((localId) => {
      dispatch({ t: 'setActive', localId })
    })
  }, [])

  useEffect(() => {
    for (const tab of state.tabs) {
      const already = notified.current.has(tab.localId)
      if (tab.unread && !already) {
        notified.current.add(tab.localId)
        notify(tab.localId, tab.title, lastMessagePreview(state.sessions[tab.localId]?.items))
      } else if (!tab.unread && already) {
        notified.current.delete(tab.localId)
      }
    }
  }, [state.tabs, notify])

  // Track whether the app window is focused/visible so a turn that finishes
  // while the user is in another app still marks its tab unread (green dot).
  useEffect(() => {
    const sync = () => dispatch({ t: 'setFocus', focused: document.hasFocus() })
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  useEffect(() => {
    const off = window.api.onSessionEvent((env) => {
      const sm = smoothers.current.get(env.localId)
      if (sm) sm.push(env.event)
      else earlyBuffer.current.push(env)
    })
    return () => {
      off()
      for (const sm of smoothers.current.values()) sm.flush()
    }
  }, [])

  const begin = useCallback(
    async (
      args: StartSessionArgs,
      preloaded?: TranscriptItem[],
      title?: string,
      /** True when `title` is already a real title (restored tab) — don't auto-title. */
      titled?: boolean,
      /** Open beside the focused pane as a split, instead of replacing it. */
      split?: boolean,
      /** Send this as the session's first message right after it opens. */
      initialPrompt?: string,
      /** Which side of the focused pane to split on (default 'right'). */
      side?: Side
    ) => {
      // Default to yolo unless the caller explicitly opts out.
      const { localId } = await window.api.startSession({ yolo: true, ...args })
      const sm = ensureSmoother(localId)
      // A freshly opened session — new or resumed — is idle and ready for
      // input the moment it opens; sends are buffered by the backend
      // MessageQueue until the subprocess materializes. Materialization is
      // deferred (no init/result event arrives to flip 'starting' → 'idle'
      // until the first message), so opening as 'starting' would leave the tab
      // stuck showing the "working" dot. Open it idle.
      dispatch({
        t: 'openTab',
        localId,
        title: title ?? basename(args.cwd),
        cwd: args.cwd,
        provider: args.provider ?? 'claude',
        preloaded,
        status: 'idle',
        // A restored tab already carries a real title — mark it titled so the
        // next message doesn't overwrite it with a snippet/auto-title.
        titled,
        // Seed the tab with the resume id so it persists immediately, before
        // the live session re-reports its id (or even if the resume fails).
        sdkSessionId: args.resumeSessionId,
        split,
        side
      })
      // Flush anything that arrived for this session before its smoother existed.
      const mine = earlyBuffer.current.filter((e) => e.localId === localId)
      earlyBuffer.current = earlyBuffer.current.filter((e) => e.localId !== localId)
      for (const env of mine) sm.push(env.event)
      // Auto-send the seed prompt (e.g. a freshly created worktree). The tab's
      // 'user' action lands right after openTab, and the backend MessageQueue
      // buffers the send until the subprocess materializes — no stateRef race.
      if (initialPrompt) {
        const id = `u-${(userSeq += 1)}`
        dispatch({ t: 'session', localId, action: { t: 'user', id, text: initialPrompt } })
        void window.api.send({ localId, text: initialPrompt })
      }
      return localId
    },
    [ensureSmoother]
  )

  // Serialize the current open tabs (only those whose SDK session id is known)
  // to localStorage so a restart can bring them back. Reads live state via
  // stateRef so it can also be flushed imperatively right after restore.
  const persistTabs = useCallback(() => {
    const s = stateRef.current
    const tabs = s.tabs
      .map((t): PersistedTab | null => {
        // Prefer the live session's id; fall back to the tab's seeded resume id
        // so a tab still persists while its session is (re)acquiring its id.
        const sid = s.sessions[t.localId]?.sdkSessionId ?? t.sdkSessionId
        // Persist every non-archived tab so the FULL set of open workspaces
        // comes back on restart — even ones never messaged (no session id yet;
        // restored as a fresh suspended session). Archived tabs persist only if
        // they have a resumable session.
        if (!sid && t.archived) return null
        return {
          localId: t.localId,
          cwd: t.cwd,
          provider: t.provider,
          title: t.title,
          sdkSessionId: sid,
          archived: t.archived
        }
      })
      .filter((t): t is PersistedTab => t !== null)
    const layout: PersistedLayout = { panes: s.panes, activeId: s.activeId }
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(s.hiddenWorkspaces))
      localStorage.setItem(PANES_KEY, JSON.stringify(layout))
    } catch {
      /* storage full / unavailable — ignore */
    }
  }, [])

  // Persist on every change — but ONLY once restore has finished. Persisting
  // earlier would write the transient empty/partial state that exists while
  // sessions are still being resumed, clobbering the list we haven't restored.
  useEffect(() => {
    if (!ready.current) return
    persistTabs()
  }, [state, persistTabs])

  // Restore saved tabs once at startup, resuming each SDK session with history.
  // Each tab is isolated in its own try/catch so a single failed resume can't
  // abort the rest, and persistence stays disabled (ready=false) until the whole
  // pass completes — so a mid-restore render can never overwrite the saved list.
  useEffect(() => {
    if (started.current) return
    started.current = true
    const saved = savedOnce.current ?? []
    // Track which tabs actually came back so the saved layout can be pruned to
    // them (a tab that failed to restore must not leave a dangling pane).
    const restoredIds = new Set<string>()
    void (async () => {
      try {
        // Lazy restore: bring each tab back as SUSPENDED — load its history for
        // display (if it has a resumable session) but DO NOT spawn a subprocess.
        // It resumes (--resume) only on focus/message. A tab opened but never
        // messaged (no session id) is restored fresh so its workspace still
        // reappears. This also prevents a launch from spawning one agent per
        // saved tab (the freeze). History loads run in PARALLEL (not awaited one
        // at a time) so all tabs reappear promptly rather than after a slow
        // sequential chain of IPC reads — during which the app would otherwise
        // sit on the launcher screen.
        const histories = await Promise.all(
          saved.map((t) =>
            t.sdkSessionId
              ? window.api
                  .loadHistory({
                    sessionId: t.sdkSessionId,
                    cwd: t.cwd,
                    provider: t.provider ?? 'claude'
                  })
                  .catch(() => [] as TranscriptItem[])
              : Promise.resolve([] as TranscriptItem[])
          )
        )
        saved.forEach((t, i) => {
          try {
            // Reuse the persisted localId so the saved pane tree (keyed by
            // localId) lines up; fall back to a fresh id for older saved lists.
            const localId = t.localId ?? newLocalId()
            dispatch({
              t: 'openTab',
              localId,
              title: t.title,
              cwd: t.cwd,
              provider: t.provider ?? 'claude',
              preloaded: histories[i],
              status: 'suspended',
              suspended: true,
              titled: true,
              sdkSessionId: t.sdkSessionId
            })
            restoredIds.add(localId)
            if (t.archived) dispatch({ t: 'archive', localId })
          } catch {
            /* one tab failing to restore must not lose the others */
          }
        })
        // Re-apply the saved split layout (pruned to tabs that came back). Each
        // openTab above reset panes to a single leaf, so this restores the tree.
        // Done before hideWorkspace so hiding can drop hidden panes from it.
        const layout = savedPanesOnce.current
        if (layout?.panes) {
          dispatch({
            t: 'restorePanes',
            panes: layout.panes,
            activeId: layout.activeId,
            keep: restoredIds
          })
        }
        // Re-hide the workspaces that were hidden last time. Their tabs were
        // restored above (suspended); hiding only drops them from the visible
        // sidebar groups until the user reopens the workspace.
        for (const cwd of savedHiddenOnce.current ?? []) {
          dispatch({ t: 'hideWorkspace', cwd })
        }
      } finally {
        // Restore is complete: enable persistence and flush the full set once
        // (the final dispatch above may not have changed state).
        ready.current = true
        persistTabs()
        // Restored tabs (if any) are now in state — let the app render them and
        // stop showing the loading state in place of the launcher.
        setRestoring(false)
      }
    })()
  }, [begin, persistTabs])

  // Reap a session: kill its backend subprocess but keep the tab + transcript.
  // It will resume (--resume) the next time it's focused or messaged.
  const suspend = useCallback((localId: string) => {
    const tab = stateRef.current.tabs.find((t) => t.localId === localId)
    if (!tab || tab.suspended) return
    smoothers.current.get(localId)?.reset()
    smoothers.current.delete(localId)
    idleSince.current.delete(localId)
    void window.api.closeSession(localId) // terminates the subprocess
    dispatch({ t: 'suspend', localId })
  }, [])

  // Spin a suspended tab's backend back up and resume its prior SDK session.
  const revive = useCallback(
    async (localId: string, pendingSend = false) => {
      const tab = stateRef.current.tabs.find((t) => t.localId === localId)
      if (!tab || !tab.suspended) return
      ensureSmoother(localId)
      dispatch({ t: 'revive', localId })
      try {
        await window.api.reviveSession({
          localId,
          cwd: tab.cwd,
          provider: tab.provider,
          resumeSessionId: tab.sdkSessionId,
          pendingSend
        })
      } catch {
        /* a failed resume surfaces as an error event; the tab stays usable */
      }
      const mine = earlyBuffer.current.filter((e) => e.localId === localId)
      earlyBuffer.current = earlyBuffer.current.filter((e) => e.localId !== localId)
      const sm = smoothers.current.get(localId)
      for (const env of mine) sm?.push(env.event)
    },
    [ensureSmoother]
  )

  // When a session reports lost context (a resume that didn't carry the
  // conversation forward), snapshot its displayed transcript so the next send
  // can re-feed it into the fresh session. Captured here (not at send time) so
  // it reflects the history as it stood at the moment of loss. Cleared once the
  // banner is dismissed / re-fed so a later loss can capture afresh.
  useEffect(() => {
    for (const tab of state.tabs) {
      const sess = state.sessions[tab.localId]
      if (sess?.contextLost) {
        if (!pendingPrimer.current.has(tab.localId)) {
          const primer = serializeTranscript(sess.items)
          if (primer) pendingPrimer.current.set(tab.localId, primer)
        }
      } else {
        pendingPrimer.current.delete(tab.localId)
      }
    }
  }, [state])

  // Track when each live session most recently went idle, for the reaper.
  useEffect(() => {
    const now = Date.now()
    for (const tab of state.tabs) {
      const s = state.sessions[tab.localId]
      if (!s || tab.suspended || s.status !== 'idle') {
        idleSince.current.delete(tab.localId)
      } else if (!idleSince.current.has(tab.localId)) {
        idleSince.current.set(tab.localId, now)
      }
    }
  }, [state])

  // Keep each conversation's cached AI description current: on every busy→idle
  // edge (a completed task), regenerate the description from the latest
  // assistant output and re-cache it (keyed by SDK session id) so the "pick up
  // where you left off" cards are already warm — no on-open "Summarizing…". The
  // title is left to the first-message auto-title path; only the description is
  // refreshed here. Best-effort: a failed call leaves the prior summary intact.
  useEffect(() => {
    for (const tab of state.tabs) {
      const sess = state.sessions[tab.localId]
      if (!sess) continue
      const prev = lastSummaryStatus.current.get(tab.localId)
      lastSummaryStatus.current.set(tab.localId, sess.status)
      // Only a real turn finishing (was busy, now idle) should re-summarize —
      // not a fresh open, a revive, or a load that lands on idle directly.
      if (sess.status !== 'idle' || !prev || !isBusy(prev)) continue
      const sessionId = sess.sdkSessionId ?? tab.sdkSessionId
      if (!sessionId) continue
      const firstPrompt = firstUserText(sess.items)
      const latestState = lastAssistantText(sess.items)
      if (!firstPrompt && !latestState) continue
      void window.api
        .summarizeSession({
          sessionId,
          cwd: tab.cwd,
          provider: tab.provider,
          title: tab.title,
          firstPrompt,
          latestState
        })
        .catch(() => {
          /* summarizing is best-effort — keep the previous description */
        })
    }
  }, [state])

  // Reaper: every 30s, suspend any live session that's been idle and off-screen
  // (not in a visible pane) for too long — freeing its subprocess.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const s = stateRef.current
      for (const tab of s.tabs) {
        if (tab.suspended || paneIds(s.panes).includes(tab.localId)) continue
        const since = idleSince.current.get(tab.localId)
        if (since && now - since > REAP_IDLE_MS) suspend(tab.localId)
      }
    }, 30_000)
    return () => clearInterval(timer)
  }, [suspend])

  // Auto-title a tab from its first worded message: an instant snippet
  // placeholder, upgraded to a concise model-generated title once that resolves.
  // Only titles from text — an image-only first message has nothing to
  // summarize, so the tab keeps its folder-name default until a worded turn.
  // (rename marks the tab titled, so a quick second message won't re-snippet.)
  const autoTitle = useCallback((localId: string, value: string) => {
    const tab = stateRef.current.tabs.find((t) => t.localId === localId)
    if (!tab || tab.titled || !value) return
    dispatch({ t: 'rename', localId, title: snippet(value) })
    void window.api
      .generateTitle(value)
      .then((title) => {
        // Only apply if the tab is still open when the title comes back.
        if (title && stateRef.current.tabs.some((t) => t.localId === localId))
          dispatch({ t: 'rename', localId, title })
      })
      .catch(() => {
        /* titling is best-effort — keep the snippet placeholder */
      })
  }, [])

  const doSend = useCallback(
    (localId: string, text: string, images?: UiImage[]) => {
      const value = text.trim()
      const hasImages = Boolean(images && images.length)
      const sess = stateRef.current.sessions[localId]
      if (!sess || (!value && !hasImages)) return

      autoTitle(localId, value)

      if (isBusy(sess.status)) {
        // Busy → queue it; the idle-flush effect sends it when the turn finishes.
        dispatch({ t: 'enqueue', localId, text: value, images })
        return
      }
      const id = `u-${(userSeq += 1)}`
      dispatch({ t: 'session', localId, action: { t: 'user', id, text: value, images } })
      // If a prior resume dropped this conversation's memory, re-feed the saved
      // transcript ahead of the user's message — on the WIRE only, so the user
      // sees just their own bubble while the model regains full context.
      const primer = pendingPrimer.current.get(localId)
      if (primer) {
        pendingPrimer.current.delete(localId)
        dispatch({ t: 'session', localId, action: { t: 'clearContextLost' } })
      }
      const wireText = primer ? `${primer}${PRIMER_SEPARATOR}${value}` : value
      void window.api.send({ localId, text: wireText, images })
    },
    [autoTitle]
  )

  // Sending to a suspended tab must first revive it (--resume) before the real
  // message can go to the backend. But the subprocess spin-up takes a beat, so
  // render the user's message + busy state *optimistically now* rather than
  // making the composer sit idle until the resume round-trips. revive()'s own
  // dispatch (status→idle) runs synchronously first, so our 'user' action
  // (status→connecting) lands on top of it and the UI reads as working
  // immediately; the actual send is deferred until the subprocess is back.
  const send = useCallback(
    (localId: string, text: string, images?: UiImage[]) => {
      const tab = stateRef.current.tabs.find((t) => t.localId === localId)
      if (tab?.suspended) {
        const value = text.trim()
        const hasImages = Boolean(images && images.length)
        const sess = stateRef.current.sessions[localId]
        if (!sess || (!value && !hasImages)) return
        const resumed = revive(localId, true)
        autoTitle(localId, value)
        const id = `u-${(userSeq += 1)}`
        dispatch({ t: 'session', localId, action: { t: 'user', id, text: value, images } })
        // A resume can report context loss before this send fires; if a primer
        // was captured by then, re-feed it on the wire alongside the message.
        void resumed.then(() => {
          const primer = pendingPrimer.current.get(localId)
          if (primer) {
            pendingPrimer.current.delete(localId)
            dispatch({ t: 'session', localId, action: { t: 'clearContextLost' } })
          }
          const wireText = primer ? `${primer}${PRIMER_SEPARATOR}${value}` : value
          void window.api.send({ localId, text: wireText, images })
        })
        return
      }
      doSend(localId, text, images)
    },
    [autoTitle, doSend, revive]
  )

  // Edit an earlier user message and rewind the conversation to that point: fork
  // the SDK session up to just before the message (so the prior turns stay as
  // context), drop the edited message and everything after it from the
  // transcript, then resume the forked session and send the edited text as the
  // new turn. Forking past the first message (or a session that was never
  // persisted) yields no fork id — the edited text starts a fresh conversation.
  const editAndRewind = useCallback(
    async (localId: string, messageId: string, text: string, images?: UiImage[]) => {
      const value = text.trim()
      const hasImages = Boolean(images && images.length)
      const sess = stateRef.current.sessions[localId]
      const tab = stateRef.current.tabs.find((t) => t.localId === localId)
      if (!sess || !tab || (!value && !hasImages)) return
      const idx = sess.items.findIndex(
        (it) => it.kind === 'message' && it.message.id === messageId && it.message.role === 'user'
      )
      if (idx < 0) return
      // Position of the edited message among user messages — stable across the
      // live `u-N` ids and persisted SDK uuids, so the backend can resolve it.
      const userOrdinal = sess.items
        .slice(0, idx)
        .filter((it) => it.kind === 'message' && it.message.role === 'user').length
      const sessionId = sess.sdkSessionId ?? tab.sdkSessionId

      // Tear down the live subprocess — we're branching onto a new session.
      smoothers.current.get(localId)?.reset()
      smoothers.current.delete(localId)
      idleSince.current.delete(localId)
      pendingPrimer.current.delete(localId)
      void window.api.closeSession(localId)

      // Fork the persisted session up to just before the edited message. A null
      // result (first message, or no persisted session) means "start fresh".
      let resumeId: string | undefined
      if (sessionId) {
        try {
          const r = await window.api.rewind({
            sessionId,
            cwd: tab.cwd,
            provider: tab.provider,
            userOrdinal
          })
          resumeId = r.sessionId ?? undefined
        } catch {
          /* fork failed — fall back to a fresh session */
        }
      }

      autoTitle(localId, value)
      // Truncate the transcript and rebase the tab onto the forked/fresh session.
      dispatch({ t: 'rewindTo', localId, itemIndex: idx, sdkSessionId: resumeId })
      // Revive that session (idle), then optimistically show the edited message
      // (connecting) — matching the suspended-send ordering so the revive's idle
      // status doesn't stomp the connecting state.
      ensureSmoother(localId)
      dispatch({ t: 'revive', localId })
      const uid = `u-${(userSeq += 1)}`
      dispatch({ t: 'session', localId, action: { t: 'user', id: uid, text: value, images } })
      try {
        await window.api.reviveSession({
          localId,
          cwd: tab.cwd,
          provider: tab.provider,
          resumeSessionId: resumeId,
          pendingSend: true
        })
      } catch {
        /* a failed resume surfaces as an error event; the tab stays usable */
      }
      const mine = earlyBuffer.current.filter((e) => e.localId === localId)
      earlyBuffer.current = earlyBuffer.current.filter((e) => e.localId !== localId)
      const sm = smoothers.current.get(localId)
      for (const env of mine) sm?.push(env.event)
      void window.api.send({ localId, text: value, images })
    },
    [autoTitle, ensureSmoother]
  )

  // Drain each tab's queue one message at a time as sessions return to idle.
  useEffect(() => {
    for (const tab of state.tabs) {
      const sess = state.sessions[tab.localId]
      if (sess && sess.status === 'idle' && tab.queued.length > 0) {
        const { text, images } = tab.queued[0]
        const id = `u-${(userSeq += 1)}`
        dispatch({ t: 'dequeue', localId: tab.localId })
        dispatch({ t: 'session', localId: tab.localId, action: { t: 'user', id, text, images } })
        const primer = pendingPrimer.current.get(tab.localId)
        if (primer) {
          pendingPrimer.current.delete(tab.localId)
          dispatch({ t: 'session', localId: tab.localId, action: { t: 'clearContextLost' } })
        }
        const wireText = primer ? `${primer}${PRIMER_SEPARATOR}${text}` : text
        void window.api.send({ localId: tab.localId, text: wireText, images })
      }
    }
  }, [state])

  // Open a brand-new session beside the focused pane (on `side`, default
  // 'right'), growing the split.
  const newPane = useCallback(
    (cwd: string, provider: BackendProvider = 'claude', side: Side = 'right') =>
      void begin({ cwd, provider, yolo: true }, undefined, undefined, undefined, true, undefined, side),
    [begin]
  )

  // Focusing a suspended tab brings its backend back (resume on use).
  const setActive = useCallback(
    (localId: string) => {
      const tab = stateRef.current.tabs.find((t) => t.localId === localId)
      dispatch({ t: 'setActive', localId })
      if (tab?.suspended) void revive(localId)
    },
    [revive]
  )
  const splitPane = useCallback(
    (localId: string, anchorId: string, side: Side) => {
      const tab = stateRef.current.tabs.find((t) => t.localId === localId)
      dispatch({ t: 'splitPane', localId, anchorId, side })
      if (tab?.suspended) void revive(localId)
    },
    [revive]
  )
  const closePane = useCallback((localId: string) => dispatch({ t: 'closePane', localId }), [])
  // Persist a dragged pane divider's new child sizes (path = child indices from
  // the pane-tree root to the split being resized).
  const resizePane = useCallback(
    (path: number[], sizes: number[]) => dispatch({ t: 'resizePane', path, sizes }),
    []
  )
  // Archiving a tab also reaps its backend — archived sessions don't need a
  // live subprocess; they resume on demand if reopened.
  const archive = useCallback(
    (localId: string) => {
      dispatch({ t: 'archive', localId })
      suspend(localId)
    },
    [suspend]
  )
  const unarchive = useCallback((localId: string) => dispatch({ t: 'unarchive', localId }), [])

  // Hide a whole workspace: reap each of its live sessions (they resume on
  // demand if reopened) and drop the group into the sidebar's Hidden section.
  const hideWorkspace = useCallback(
    (cwd: string) => {
      for (const tab of stateRef.current.tabs) {
        if (tab.cwd === cwd && !tab.suspended) suspend(tab.localId)
      }
      dispatch({ t: 'hideWorkspace', cwd })
    },
    [suspend]
  )

  // Open a workspace: unhide it if hidden. If it's already open, just focus its
  // most recent tab. If it's NOT open yet, surface its recent conversations from
  // disk as lazy (suspended) tabs — no prompt, no subprocesses — with the most
  // recent focused; a workspace with no prior conversations just starts fresh.
  const openWorkspace = useCallback(
    async (cwd: string, yolo = true, provider: BackendProvider = 'claude') => {
      const s = stateRef.current
      if (s.hiddenWorkspaces.includes(cwd)) dispatch({ t: 'unhideWorkspace', cwd })
      const existing = s.tabs
        .filter((t) => t.cwd === cwd && t.provider === provider && !t.archived)
        .sort((a, b) => a.seq - b.seq)
      // Already open → just focus it (don't re-flood the sidebar from disk or
      // disturb an existing split layout).
      if (existing.length > 0) {
        setActive(existing[existing.length - 1].localId)
        return
      }
      // Not open yet → pull this workspace's recent conversations from disk.
      // Skip any whose session is already represented by a tab (e.g. archived).
      const present = new Set(
        s.tabs
          .filter((t) => t.cwd === cwd && t.provider === provider)
          .map((t) => s.sessions[t.localId]?.sdkSessionId ?? t.sdkSessionId)
          .filter(Boolean) as string[]
      )
      const recent = (await window.api.listSessions(cwd, provider).catch(() => []))
        .filter((sess) => !present.has(sess.sessionId))
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(0, RECENT_CONVOS_ON_OPEN)
      // No prior conversations → start a fresh session.
      if (recent.length === 0) {
        void begin({ cwd, provider, yolo })
        return
      }
      // Load histories in parallel, then open each as a suspended tab. Opening
      // oldest-first leaves the MOST recent as the focused pane (openTab focuses
      // the tab it opens). They revive (--resume) only when clicked/messaged.
      const histories = await Promise.all(
        recent.map((sess) =>
          window.api
            .loadHistory({ sessionId: sess.sessionId, cwd, provider })
            .catch(() => [] as TranscriptItem[])
        )
      )
      for (let i = recent.length - 1; i >= 0; i--) {
        const sess = recent[i]
        dispatch({
          t: 'openTab',
          localId: newLocalId(),
          title: sess.summary || sess.firstPrompt || basename(cwd),
          cwd,
          provider,
          preloaded: histories[i],
          status: 'suspended',
          suspended: true,
          titled: true,
          sdkSessionId: sess.sessionId
        })
      }
    },
    [begin, setActive]
  )
  // Spin a git worktree (new branch) off a workspace repo, then open a fresh
  // session in it seeded with the task prompt. The worktree dir becomes the new
  // session's cwd, so it surfaces as its own workspace group in the sidebar.
  const createWorktree = useCallback(
    async (cwd: string, prompt: string, provider: BackendProvider = 'claude') => {
      const value = prompt.trim()
      if (!value) return
      const result = await window.api.createWorktree({ cwd, prompt: value })
      await begin(
        { cwd: result.path, provider, yolo: true },
        undefined,
        snippet(value), // title from the prompt …
        true, // … and mark it titled so the seed message doesn't re-snippet it
        false,
        value // seed the worktree session with the prompt
      )
    },
    [begin]
  )

  const unqueue = useCallback(
    (localId: string, index: number) => dispatch({ t: 'unqueue', localId, index }),
    []
  )

  // Persist the composer's unsent contents on the tab so they survive switching
  // away and back (which remounts the ConversationView + Composer).
  const setDraft = useCallback(
    (localId: string, text: string, images: UiImage[]) =>
      dispatch({ t: 'setDraft', localId, text, images }),
    []
  )

  const interrupt = useCallback((localId: string) => {
    smoothers.current.get(localId)?.flush()
    void window.api.interrupt(localId)
  }, [])

  // Close is non-destructive: it tucks the tab into the (collapsed) Archived
  // section and reaps its backend (resumable later). Permanent removal lives in
  // `deleteTab`.
  const closeTab = useCallback(
    (localId: string) => {
      dispatch({ t: 'archive', localId })
      suspend(localId)
    },
    [suspend]
  )

  // Permanently remove a tab: stop its backend session and drop it from state.
  const deleteTab = useCallback((localId: string) => {
    smoothers.current.get(localId)?.reset()
    smoothers.current.delete(localId)
    void window.api.closeSession(localId)
    dispatch({ t: 'closeTab', localId })
  }, [])

  const answerPermission = useCallback(
    (localId: string, requestId: string, decision: PermissionDecision) =>
      void window.api.answerPermission({ localId, requestId, decision }),
    []
  )

  const answerQuestion = useCallback(
    (localId: string, requestId: string, answer: QuestionAnswer) =>
      void window.api.answerQuestion({ localId, requestId, answer }),
    []
  )

  const clearError = useCallback(
    (localId: string) => dispatch({ t: 'session', localId, action: { t: 'clearError' } }),
    []
  )

  // Dismiss the "memory not restored" banner without re-feeding (the user
  // accepts the fresh context). Drops the captured primer so nothing is
  // prepended to the next message.
  const dismissContextLost = useCallback((localId: string) => {
    pendingPrimer.current.delete(localId)
    dispatch({ t: 'session', localId, action: { t: 'clearContextLost' } })
  }, [])

  // Replace a pane's conversation with a blank one. Reap the live subprocess and
  // forget the SDK session id so nothing resumes the old thread, then wipe the
  // transcript. The tab is left suspended-and-idle (see the clearSession action);
  // the next message revives a fresh session via the normal lazy-revive path.
  const clearSession = useCallback((localId: string) => {
    smoothers.current.get(localId)?.reset()
    smoothers.current.delete(localId)
    idleSince.current.delete(localId)
    void window.api.closeSession(localId)
    dispatch({ t: 'clearSession', localId })
  }, [])

  const active = useMemo(() => {
    if (!state.activeId) return null
    const tab = state.tabs.find((t) => t.localId === state.activeId) ?? null
    const session = state.sessions[state.activeId] ?? null
    return tab && session ? { tab, session } : null
  }, [state])

  return {
    state,
    restoring,
    active,
    begin,
    newPane,
    send,
    editAndRewind,
    interrupt,
    setActive,
    splitPane,
    closePane,
    resizePane,
    archive,
    unarchive,
    hideWorkspace,
    openWorkspace,
    createWorktree,
    closeTab,
    deleteTab,
    unqueue,
    setDraft,
    answerPermission,
    answerQuestion,
    clearError,
    dismissContextLost,
    clearSession
  }
}
