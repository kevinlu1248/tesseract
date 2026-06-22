import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import type { BackendProvider, RecentScreenshot, SessionStatus } from '../../shared/ipc'
import { contextWindowFor, formatTokens, type UiImage } from '../../shared/schema'
import { isBusy, type QueuedMessage } from '../state/workspaceStore'

// Paths of screenshots the user has already added or dismissed are persisted so
// a discarded shot never gets re-suggested after a tab switch or app restart.
const HANDLED_SHOTS_KEY = 'cw.handledShots.v1'
// Cap the stored list so it can't grow without bound; the main process only
// surfaces shots from the last few minutes, so recent paths are all that matter.
const HANDLED_SHOTS_MAX = 200

function loadHandledShots(): Set<string> {
  try {
    const raw = localStorage.getItem(HANDLED_SHOTS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((p): p is string => typeof p === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function persistHandledShots(shots: Set<string>): void {
  try {
    // Keep only the most-recently-added tail when over the cap.
    const list = Array.from(shots).slice(-HANDLED_SHOTS_MAX)
    localStorage.setItem(HANDLED_SHOTS_KEY, JSON.stringify(list))
  } catch {
    /* best-effort; ignore quota/serialization errors */
  }
}

// Adding or dismissing a screenshot in one pane must hide the suggestion in
// every other pane too. localStorage `storage` events don't fire within the
// same window, so we broadcast handling over a custom event that all live
// Composers listen for. Each pane has its own `handledShots` ref + `recent`
// state, so this keeps them in sync without lifting state up to a store.
const SHOT_HANDLED_EVENT = 'cw.shotHandled'

function broadcastShotHandled(path: string): void {
  window.dispatchEvent(new CustomEvent<string>(SHOT_HANDLED_EVENT, { detail: path }))
}

/** Read an image File into the base64 UiImage shape the model expects. */
function fileToImage(file: File): Promise<UiImage | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma === -1 ? null : { mediaType: file.type, data: result.slice(comma + 1) })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Imperative handle so callers (e.g. idea chips) can prefill / focus the input. */
export interface ComposerHandle {
  /** Replace the draft text, resize, and focus the textarea. */
  fill: (text: string) => void
  focus: () => void
  /** Attach image files (e.g. from a window-wide drop) to the draft. */
  addImages: (files: FileList | File[]) => void
}

type Variant = 'primary' | 'secondary' | 'danger'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent hover:bg-[#5b97f5] text-ink-950 disabled:hover:bg-accent',
  secondary: 'bg-ink-700 hover:bg-ink-600 text-ink-100',
  danger: 'bg-ink-700 hover:bg-red-600/80 text-ink-100'
}

function IconButton({
  onClick,
  disabled,
  title,
  variant,
  className = '',
  children
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  variant: Variant
  className?: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`shrink-0 grid place-items-center w-8 h-8 rounded-lg transition-colors disabled:opacity-40 ${VARIANT[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function QueueIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h7M2.5 8h7M2.5 12h4M12 9v5M9.5 11.5h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AttachIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.5 7.5l-3.7 3.7a2.5 2.5 0 0 1-3.5-3.5l4.2-4.2a1.6 1.6 0 0 1 2.3 2.3l-4.2 4.2a.7.7 0 0 1-1-1l3.9-3.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1l.8-1.2a.8.8 0 0 1 .67-.3h2.06a.8.8 0 0 1 .67.3L9.5 4h1A1.5 1.5 0 0 1 12 5.5v5A1.5 1.5 0 0 1 10.5 12h-7A1.5 1.5 0 0 1 2 10.5v-5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="6" y="2" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4 7.5a4 4 0 0 0 8 0M8 11.5V14M6 14h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ---- Minimal Web Speech API typings -------------------------------------
// The DOM lib doesn't ship SpeechRecognition types, so we declare just the
// slice we use. This is the browser-native engine: zero deps and real-time,
// but note it relies on the host's speech backend (works in Chromium browsers;
// may be unavailable in the packaged Electron build — the button hides itself
// when the API isn't present).
interface SpeechAlternative {
  readonly transcript: string
}
interface SpeechResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechAlternative
}
interface SpeechResultList {
  readonly length: number
  readonly [index: number]: SpeechResult
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: SpeechResultList
}
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Append dictated text to an existing draft, inserting a separating space. */
function appendSpeech(base: string, add: string): string {
  const next = add.replace(/^\s+/, '')
  if (!base) return next
  return /\s$/.test(base) ? base + next : `${base} ${next}`
}

/** Idle-state label shown on the left of the composer status bar. */
const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  starting: 'Starting…',
  idle: 'Ready',
  interrupted: 'Interrupted',
  error: 'Error',
  exited: 'Session ended'
}

const STATUS_DOT: Partial<Record<SessionStatus, string>> = {
  starting: '#7b8699',
  idle: '#7ee787',
  interrupted: '#7b8699',
  error: '#f87171',
  exited: '#7b8699'
}

/** Compact context-window fill gauge for the composer status bar. */
function ContextMeter({ tokens, model }: { tokens: number; model?: string }): ReactNode {
  const window = contextWindowFor(model)
  const pct = Math.min(100, (tokens / window) * 100)
  const color = pct >= 90 ? '#f87171' : pct >= 70 ? '#f0b429' : '#6ea8fe'
  const pctText = pct.toFixed(pct < 10 ? 1 : 0)
  return (
    <span
      className="flex items-center gap-1.5 text-ink-500 font-mono shrink-0"
      title={`Context: ${formatTokens(tokens)} / ${formatTokens(window)} tokens (${pctText}%)`}
    >
      <span className="relative inline-block w-12 h-1.5 rounded-full bg-ink-800 overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${Math.max(pct, 2)}%`, background: color }}
        />
      </span>
      <span style={{ color }}>{pctText}%</span>
    </span>
  )
}

interface Props {
  status: SessionStatus
  /** Messages queued to send when the session next goes idle. */
  queued: QueuedMessage[]
  /** Identifies the active session; changing it refocuses the input. */
  sessionLocalId: string
  /** Tokens in the prompt last sent to the model (live context-window fill). */
  contextTokens?: number
  /** Active model id — used to size the context window. */
  model?: string
  provider?: BackendProvider
  /** Centered (landing) layout: bigger input, soft shadow, friendlier hint. */
  centered?: boolean
  /** Restored draft text — seeds the input on mount (e.g. after a tab switch). */
  initialText?: string
  /** Restored draft images — seed the attachments on mount. */
  initialImages?: UiImage[]
  onSend: (text: string, images: UiImage[]) => void
  /** Report every draft change so it can be persisted outside this component. */
  onDraftChange?: (text: string, images: UiImage[]) => void
  onInterrupt: () => void
  onUnqueue: (index: number) => void
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    status,
    queued,
    sessionLocalId,
    contextTokens,
    model,
    provider = 'claude',
    centered = false,
    initialText,
    initialImages,
    onSend,
    onDraftChange,
    onInterrupt,
    onUnqueue
  },
  handleRef
) {
  // Seed once from the restored draft; subsequent prop changes are ignored (the
  // draft store is downstream of this state, so re-applying would clobber edits).
  const [text, setText] = useState(initialText ?? '')
  const [images, setImages] = useState<UiImage[]>(initialImages ?? [])
  const [dragging, setDragging] = useState(false)
  const [recent, setRecent] = useState<RecentScreenshot | null>(null)
  const [listening, setListening] = useState(false)
  const agentName = provider === 'codex' ? 'Codex' : 'Claude Code'
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Resolve the native speech engine once; the mic button is hidden if absent.
  const speechSupported = useRef<boolean>(getSpeechRecognitionCtor() !== null).current
  // Paths the user has already added or dismissed — never re-suggest them.
  // Seeded from localStorage so dismissals survive remounts and restarts.
  const handledShots = useRef<Set<string>>(null as unknown as Set<string>)
  if (handledShots.current === null) handledShots.current = loadHandledShots()
  const busy = isBusy(status)

  // Poll for a freshly-captured screenshot so we can offer a one-click
  // "add to context" chip. The main process only returns shots from the last
  // few minutes, so this stays quiet unless the user just took one.
  useEffect(() => {
    let active = true
    const poll = async (): Promise<void> => {
      try {
        const shot = await window.api.getRecentScreenshot()
        if (!active) return
        if (shot && !handledShots.current.has(shot.path)) setRecent(shot)
        else if (!shot) setRecent(null)
      } catch {
        /* best-effort; ignore */
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 5000)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  // When any pane adds or dismisses a screenshot, drop it here too so the
  // suggestion disappears everywhere at once — not just in the acting pane.
  useEffect(() => {
    const onHandled = (e: Event): void => {
      const path = (e as CustomEvent<string>).detail
      if (typeof path !== 'string') return
      handledShots.current.add(path)
      setRecent((prev) => (prev?.path === path ? null : prev))
    }
    window.addEventListener(SHOT_HANDLED_EVENT, onHandled)
    return () => window.removeEventListener(SHOT_HANDLED_EVENT, onHandled)
  }, [])

  const addRecentScreenshot = (): void => {
    if (!recent) return
    setImages((prev) => [...prev, recent.image])
    handledShots.current.add(recent.path)
    persistHandledShots(handledShots.current)
    broadcastShotHandled(recent.path)
    setRecent(null)
    ref.current?.focus()
  }

  const dismissRecentScreenshot = (): void => {
    if (recent) {
      handledShots.current.add(recent.path)
      persistHandledShots(handledShots.current)
      broadcastShotHandled(recent.path)
    }
    setRecent(null)
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const read = await Promise.all(Array.from(files).map(fileToImage))
    const next = read.filter((img): img is UiImage => img !== null)
    if (next.length) setImages((prev) => [...prev, ...next])
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
  }

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files?.length) void addFiles(e.target.files)
    e.target.value = '' // allow re-picking the same file
  }

  const resize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    // An empty field is exactly one row at height:auto. Skip the scrollHeight
    // measurement in that case — right after a programmatic clear (send,
    // dictation, draft reset) it can read a stale multi-line height that then
    // sticks, and a wrapped placeholder inflates it too. Either way the empty
    // composer renders as a tall box with the placeholder pinned to the top.
    // Reading el.value (not the `text` closure) keeps this correct from the
    // onChange path, where state hasn't committed yet.
    if (el.value === '') return
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  // Autofocus the input on mount and whenever the active session changes,
  // so you can start typing in a new chat right away.
  useEffect(() => {
    ref.current?.focus()
  }, [sessionLocalId])

  // A restored draft can be multi-line, so size the textarea to fit on mount.
  useEffect(() => {
    requestAnimationFrame(resize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-measure on EVERY text change — including programmatic clears (submit,
  // dictation, draft restore). onChange-only resizing leaves the imperative
  // height stuck tall if the field is emptied through any other path, which
  // renders an empty composer as a ~170px box with the placeholder pinned to
  // the top. Keying off `text` makes the height always match the content.
  useEffect(() => {
    resize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // Mirror the live draft up to the workspace store on every change so it
  // survives the remount that happens when this tab is switched away and back.
  // A ref holds the latest callback so the effect depends only on the contents.
  const draftCb = useRef(onDraftChange)
  draftCb.current = onDraftChange
  useEffect(() => {
    draftCb.current?.(text, images)
  }, [text, images])

  useImperativeHandle(
    handleRef,
    () => ({
      fill: (value: string) => {
        setText(value)
        const el = ref.current
        if (!el) return
        el.focus()
        // Wait for the controlled value to render before measuring scrollHeight.
        requestAnimationFrame(resize)
      },
      focus: () => ref.current?.focus(),
      addImages: (files: FileList | File[]) => {
        void addFiles(files)
        ref.current?.focus()
      }
    }),
    []
  )

  // Stop any in-flight recognition when the component unmounts (e.g. tab switch)
  // so the mic isn't left hot in the background.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
    }
  }, [])

  // Toggle browser-native speech-to-text. Dictated words are appended to the
  // current draft live; interim (not-yet-final) words are shown too and get
  // replaced as the engine settles on the final transcription.
  const toggleDictation = (): void => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return

    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'

    // Text committed before/while dictating. Finalized chunks fold into this;
    // interim chunks render on top of it without being permanently kept.
    let committed = text

    rec.onresult = (event): void => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const phrase = result[0]?.transcript ?? ''
        if (result.isFinal) committed = appendSpeech(committed, phrase)
        else interim += phrase
      }
      const draft = interim ? appendSpeech(committed, interim) : committed
      setText(draft)
      requestAnimationFrame(resize)
    }
    rec.onerror = (): void => {
      setListening(false)
      recognitionRef.current = null
    }
    rec.onend = (): void => {
      setListening(false)
      recognitionRef.current = null
      ref.current?.focus()
    }

    recognitionRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      // start() throws if a prior session is still tearing down; ignore.
      recognitionRef.current = null
    }
  }

  const submit = (): void => {
    const value = text.trim()
    if (!value && images.length === 0) return
    recognitionRef.current?.stop()
    onSend(value, images)
    setText('')
    setImages([])
    if (ref.current) ref.current.style.height = 'auto'
  }

  const canSend = Boolean(text.trim()) || images.length > 0

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While an IME composition is active, the Enter that commits the
    // composition reports isComposing/keyCode 229 — treat it as text entry, not
    // a send, otherwise the user has to press Enter twice (once to commit, once
    // to send).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault()
      onInterrupt()
    }
  }

  return (
    <div
      className={
        centered
          ? 'no-drag'
          : 'px-6 py-3 no-drag'
      }
    >
      <div className="max-w-3xl mx-auto">
        {queued.length > 0 && (
          <div className="mb-2 space-y-1">
            {queued.map((q, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-1.5"
              >
                <span className="text-[11px] text-accent font-medium shrink-0">queued</span>
                {q.images && q.images.length > 0 && (
                  <span className="text-[11px] text-ink-400 shrink-0" title="attached images">
                    🖼 {q.images.length}
                  </span>
                )}
                <span className="flex-1 min-w-0 truncate text-[12px] text-ink-300">
                  {q.text || '(image)'}
                </span>
                <button
                  onClick={() => onUnqueue(i)}
                  title="Remove from queue"
                  className="text-ink-500 hover:text-red-300 text-[12px] shrink-0"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
          {busy ? (
            <span className="flex items-center gap-2 text-accent">
              <span className="flex items-center gap-1" aria-hidden>
                <span className="loading-dot" />
                <span className="loading-dot" />
                <span className="loading-dot" />
              </span>
              <span>
                {status === 'awaiting-permission'
                  ? 'Waiting for permission…'
                  : // 'connecting' is the optimistic state set the instant a
                    // message is sent (before the SDK streams its first token).
                    // Show a distinct "Connecting…" so sending gives immediate
                    // feedback, then flip to a provider-specific working label once the model
                    // actually starts streaming ('running').
                    status === 'connecting'
                    ? 'Connecting…'
                    : `${agentName} is working…`}
              </span>
            </span>
          ) : centered ? (
            // Landing layout (no messages yet): the "Ready" indicator is noise.
            <span />
          ) : (
            <span className="flex items-center gap-1.5 text-ink-500">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: STATUS_DOT[status] ?? '#7ee787' }}
                aria-hidden
              />
              <span>{STATUS_LABEL[status] ?? 'Ready'}</span>
            </span>
          )}

          {contextTokens != null && contextTokens > 0 && (
            <ContextMeter tokens={contextTokens} model={model} />
          )}
        </div>

        {recent && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1.5">
            <img
              src={`data:${recent.image.mediaType};base64,${recent.image.data}`}
              alt="recent screenshot"
              className="h-8 w-8 rounded border border-ink-700 object-cover shrink-0"
            />
            <button
              onClick={addRecentScreenshot}
              title={`Attach ${recent.name}`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] text-ink-200 hover:text-ink-50"
            >
              <span className="text-accent shrink-0">
                <CameraIcon />
              </span>
              <span className="shrink-0 font-medium">Add recent screenshot</span>
              <span className="min-w-0 truncate text-ink-500">{recent.name}</span>
            </button>
            <button
              onClick={dismissRecentScreenshot}
              title="Dismiss"
              className="shrink-0 text-ink-500 hover:text-red-300 text-[12px]"
            >
              ✕
            </button>
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragging) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`rounded-xl border bg-ink-850 transition-colors focus-within:border-accent/70 ${
            dragging ? 'border-accent border-dashed' : 'border-ink-700'
          } ${centered ? 'shadow-xl shadow-black/30' : ''}`}
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {images.map((img, i) => (
                <div key={i} className="relative">
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt="attachment"
                    className="h-16 w-16 rounded-lg border border-ink-700 object-cover"
                  />
                  <button
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove image"
                    className="absolute -top-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full border border-ink-600 bg-ink-900 text-[11px] text-ink-300 hover:text-red-300"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={`flex items-end gap-2 px-3 py-2 ${centered ? 'px-4 py-3' : ''}`}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onPickFiles}
            />
            <IconButton
              onClick={() => fileRef.current?.click()}
              title="Attach image"
              variant="secondary"
            >
              <AttachIcon />
            </IconButton>
            {speechSupported && (
              <IconButton
                onClick={toggleDictation}
                title={listening ? 'Stop dictation' : 'Dictate (voice to text)'}
                variant={listening ? 'danger' : 'secondary'}
                className={listening ? 'animate-pulse !bg-red-600/80 text-ink-50' : ''}
              >
                <MicIcon />
              </IconButton>
            )}
            <textarea
              ref={ref}
              value={text}
              rows={1}
              placeholder={
                busy
                  ? 'Queue a message…  (Enter to queue, sent when idle, Esc to interrupt)'
                  : centered
                    ? `Ask ${agentName} anything…  (paste or drop an image to attach)`
                    : `Message ${agentName}…  (Enter to send, Shift+Enter for newline)`
              }
              onChange={(e) => {
                setText(e.target.value)
                resize()
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className="flex-1 min-w-0 resize-none bg-transparent text-[14px] text-ink-100 placeholder:text-ink-500 outline-none leading-relaxed py-1 max-h-[220px]"
            />
            {busy ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <IconButton
                  onClick={submit}
                  disabled={!canSend}
                  title="Queue message — sent when idle"
                  variant="primary"
                >
                  <QueueIcon />
                </IconButton>
                <IconButton onClick={onInterrupt} title="Interrupt (Esc)" variant="danger">
                  <StopIcon />
                </IconButton>
              </div>
            ) : (
              <IconButton
                onClick={submit}
                disabled={!canSend}
                title="Send (Enter)"
                variant="primary"
              >
                <SendIcon />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
