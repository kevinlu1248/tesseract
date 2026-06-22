import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventEnvelope,
  StartSessionArgs,
  TranscriptItem,
  BackendProvider
} from '../../shared/ipc'
import type { UiImage } from '../../shared/schema'
import { StreamSmoother } from './streamSmoother'
import { isBusy } from './workspaceStore'
import {
  initialWorkspaceState,
  workspaceReducer,
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

interface PersistedTab {
  cwd: string
  provider?: BackendProvider
  title: string
  /** Resume id; absent for a tab opened but never messaged (restored fresh). */
  sdkSessionId?: string
  archived: boolean
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
  // `started` guards the one-time restore pass; `ready` gates persistence so we
  // never overwrite the saved tab list until restore has FULLY completed.
  // (Flipping a single flag synchronously at restore-start let a mid-restore
  // re-render — e.g. the window gaining focus — persist the still-empty state
  // and clobber the saved tabs before they came back.)
  const started = useRef(false)
  const ready = useRef(false)

  const smoothers = useRef<Map<string, StreamSmoother>>(new Map())
  // Events for a session can land before its tab is registered (the SDK's
  // system/init races startSession resolving). Hold them until the tab exists.
  const earlyBuffer = useRef<SessionEventEnvelope[]>([])
  // localId → epoch ms when it most recently became idle (for the reaper).
  const idleSince = useRef<Map<string, number>>(new Map())

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
  // Keep live notifications referenced. An un-referenced Notification can be
  // garbage-collected before the user clicks it, which silently drops the
  // `onclick` handler — so the click never focuses the app or opens the tab and
  // the OS falls back to activating whatever process spawned us.
  const liveNotifications = useRef<Map<string, Notification>>(new Map())
  const notify = useCallback((localId: string, title: string, preview: string) => {
    if (typeof Notification === 'undefined') return
    const show = (): void => {
      const n = new Notification(title || 'Claude Workspace', {
        body: preview || 'Finished responding',
        // Re-use the per-session tag so a newer notification replaces an older
        // one for the same tab instead of stacking up.
        tag: localId
      })
      liveNotifications.current.get(localId)?.close()
      liveNotifications.current.set(localId, n)
      const release = (): void => {
        if (liveNotifications.current.get(localId) === n)
          liveNotifications.current.delete(localId)
      }
      n.onclose = release
      n.onclick = () => {
        void window.api.focusWindow()
        dispatch({ t: 'setActive', localId })
        n.close()
        release()
      }
    }
    if (Notification.permission === 'granted') show()
    else if (Notification.permission !== 'denied')
      void Notification.requestPermission().then((p) => {
        if (p === 'granted') show()
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
      split?: boolean
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
        split
      })
      // Flush anything that arrived for this session before its smoother existed.
      const mine = earlyBuffer.current.filter((e) => e.localId === localId)
      earlyBuffer.current = earlyBuffer.current.filter((e) => e.localId !== localId)
      for (const env of mine) sm.push(env.event)
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
        return sid
          ? {
              cwd: t.cwd,
              provider: t.provider,
              title: t.title,
              sdkSessionId: sid,
              archived: t.archived
            }
          : null
      })
      .filter((t): t is PersistedTab => t !== null)
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(s.hiddenWorkspaces))
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
    void (async () => {
      try {
        for (const t of saved) {
          try {
            if (!t.sdkSessionId) continue
            // Lazy restore: bring the tab back as SUSPENDED — load its history
            // for display but DO NOT spawn a subprocess. It resumes (--resume)
            // only when the user focuses or messages it. This is what prevents a
            // launch from spawning one agent per saved tab (the freeze).
            const items = await window.api
              .loadHistory({
                sessionId: t.sdkSessionId,
                cwd: t.cwd,
                provider: t.provider ?? 'claude'
              })
              .catch(() => [] as TranscriptItem[])
            const localId = newLocalId()
            dispatch({
              t: 'openTab',
              localId,
              title: t.title,
              cwd: t.cwd,
              provider: t.provider ?? 'claude',
              preloaded: items,
              status: 'suspended',
              suspended: true,
              titled: true,
              sdkSessionId: t.sdkSessionId
            })
            if (t.archived) dispatch({ t: 'archive', localId })
          } catch {
            /* one tab failing to restore must not lose the others */
          }
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

  // Reaper: every 30s, suspend any live session that's been idle and off-screen
  // (not in a visible pane) for too long — freeing its subprocess.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const s = stateRef.current
      for (const tab of s.tabs) {
        if (tab.suspended || s.panes.includes(tab.localId)) continue
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
      void window.api.send({ localId, text: value, images })
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
        void resumed.then(() => window.api.send({ localId, text: value, images }))
        return
      }
      doSend(localId, text, images)
    },
    [autoTitle, doSend, revive]
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
        void window.api.send({ localId: tab.localId, text, images })
      }
    }
  }, [state])

  // Open a brand-new session beside the focused pane, growing the split.
  const newPane = useCallback(
    (cwd: string, provider: BackendProvider = 'claude') =>
      void begin({ cwd, provider, yolo: true }, undefined, undefined, undefined, true),
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
    (localId: string, anchorId: string, side: 'left' | 'right') => {
      const tab = stateRef.current.tabs.find((t) => t.localId === localId)
      dispatch({ t: 'splitPane', localId, anchorId, side })
      if (tab?.suspended) void revive(localId)
    },
    [revive]
  )
  const closePane = useCallback((localId: string) => dispatch({ t: 'closePane', localId }), [])
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

  // Open a workspace: unhide it if hidden, then re-open all of its previous
  // non-archived sessions by surfacing them (the most recent takes the focused
  // pane, the rest stay in the sidebar and revive on click). A workspace with
  // no prior sessions just starts a fresh one.
  const openWorkspace = useCallback(
    (cwd: string, yolo = true, provider: BackendProvider = 'claude') => {
      const s = stateRef.current
      if (s.hiddenWorkspaces.includes(cwd)) dispatch({ t: 'unhideWorkspace', cwd })
      const existing = s.tabs
        .filter((t) => t.cwd === cwd && t.provider === provider && !t.archived)
        .sort((a, b) => a.seq - b.seq)
      if (existing.length === 0) void begin({ cwd, provider, yolo })
      else setActive(existing[existing.length - 1].localId)
    },
    [begin, setActive]
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

  const active = useMemo(() => {
    if (!state.activeId) return null
    const tab = state.tabs.find((t) => t.localId === state.activeId) ?? null
    const session = state.sessions[state.activeId] ?? null
    return tab && session ? { tab, session } : null
  }, [state])

  return {
    state,
    active,
    begin,
    newPane,
    send,
    interrupt,
    setActive,
    splitPane,
    closePane,
    archive,
    unarchive,
    hideWorkspace,
    openWorkspace,
    closeTab,
    deleteTab,
    unqueue,
    setDraft,
    answerPermission,
    answerQuestion,
    clearError
  }
}
