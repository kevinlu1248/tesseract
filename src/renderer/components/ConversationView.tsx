import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import type { AuthInfo, PermissionDecision, QuestionAnswer, SessionCard } from '../../shared/ipc'
import type { UiImage } from '../../shared/schema'
import type { SessionState } from '../state/sessionStore'
import type { Tab } from '../state/workspaceStore'
import { Composer, type ComposerHandle } from './Composer'
import { PermissionPrompt } from './PermissionPrompt'
import { QuestionPrompt } from './QuestionPrompt'
import { RecentCard } from './RecentCard'
import { StatusBar } from './StatusBar'
import { Transcript } from './Transcript'

/**
 * The active-session surface. Two visual modes that animate into each other:
 *
 *  • "centered" — a fresh session with no messages yet. The composer floats in
 *    the vertical center with a greeting above and idea chips (drawn from prior
 *    conversations in this repo) below.
 *  • "docked" — once the first message lands, the composer slides to the bottom
 *    and the transcript fills the space above it.
 *
 * The same composer element is kept mounted across the transition (its wrapper
 * just changes from absolute-centered to absolute-bottom and finally to static
 * flow) so the slide is continuous and the draft/focus survive.
 */

interface Props {
  auth: AuthInfo | null
  session: SessionState
  tab: Tab
  onSend: (text: string, images: UiImage[]) => void
  /** Persist the composer's unsent contents (survives tab-switch remounts). */
  onDraftChange: (text: string, images: UiImage[]) => void
  onInterrupt: () => void
  onUnqueue: (index: number) => void
  onClose: () => void
  /** Present when this view is one pane of a split — removes just the pane. */
  onClosePane?: () => void
  /** Open a new session beside this pane as a split. */
  onNewPane?: () => void
  /** Wipe this pane's conversation and start a fresh, blank one. */
  onClear: () => void
  onClearError: () => void
  onAnswerPermission: (requestId: string, decision: PermissionDecision) => void
  onAnswerQuestion: (requestId: string, answer: QuestionAnswer) => void
  /** Resume a prior conversation (clicked from the recent-conversations cards). */
  onResumeConversation: (sessionId: string) => void
  /** Present only on the leftmost pane while the sidebar is hidden — reveals it. */
  onShowSidebar?: () => void
}

type Phase = 'centered' | 'docking' | 'docked'

function basename(p?: string): string {
  if (!p) return ''
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function clamp(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export function ConversationView({
  auth,
  session,
  tab,
  onSend,
  onDraftChange,
  onInterrupt,
  onUnqueue,
  onClose,
  onClosePane,
  onNewPane,
  onClear,
  onClearError,
  onAnswerPermission,
  onAnswerQuestion,
  onResumeConversation,
  onShowSidebar
}: Props) {
  const empty = session.items.length === 0
  const composerRef = useRef<ComposerHandle>(null)

  // Window-wide image drag-and-drop. Dragging a file anywhere over this surface
  // lights up a full-bleed overlay; dropping it routes the image straight into
  // the composer draft (regardless of where in the UI you let go).
  //
  // dragenter/dragleave flicker as the pointer crosses child elements, so we
  // drive the overlay off dragover (which fires continuously) plus a short
  // trailing timer: each dragover keeps it alive, and the absence of one for a
  // beat — because the pointer left the window or the drop landed — clears it.
  const [dragging, setDragging] = useState(false)
  const dragTimer = useRef<number>()

  const hasFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
    window.clearTimeout(dragTimer.current)
    dragTimer.current = window.setTimeout(() => setDragging(false), 120)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    window.clearTimeout(dragTimer.current)
    setDragging(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) composerRef.current?.addImages(files)
  }

  useEffect(() => () => window.clearTimeout(dragTimer.current), [])

  // Drive the centered → docked transition. We only animate when an *empty*
  // session receives its first message; switching between already-populated
  // sessions just snaps to the right mode.
  const [phase, setPhase] = useState<Phase>(empty ? 'centered' : 'docked')
  const prevEmpty = useRef(empty)
  useEffect(() => {
    if (prevEmpty.current && !empty) {
      prevEmpty.current = empty
      setPhase('docking')
      const t = setTimeout(() => setPhase('docked'), 520)
      return () => clearTimeout(t)
    }
    prevEmpty.current = empty
    setPhase(empty ? 'centered' : 'docked')
  }, [empty])

  // Recent-conversation cards: the most recent prior conversations in this repo,
  // each with an AI-generated title + description. Titles/descriptions are
  // generated in the background by the main process; we render snippet
  // fallbacks immediately and patch each card in place as its summary arrives
  // over the onSessionSummaryUpdated push channel.
  const [cards, setCards] = useState<SessionCard[]>([])
  // Key the fetch off `tab.cwd`, not `session.cwd`: the tab's cwd is known the
  // moment the tab is created, whereas session.cwd is only populated once the
  // backend streams its first event. A fresh, never-messaged session has no
  // events yet, so session.cwd is undefined — and the recent-conversation cards
  // (which only matter in that empty state) would never load.
  useEffect(() => {
    if (!tab.cwd) return
    let alive = true
    window.api
      .getSessionSummaries(tab.cwd, tab.provider)
      .then((list) => {
        if (alive) setCards(list)
      })
      .catch(() => undefined)
    const unsubscribe = window.api.onSessionSummaryUpdated((update) => {
      if (!alive) return
      if (update.cwd !== tab.cwd || update.provider !== tab.provider) return
      setCards((prev) =>
        prev.map((c) => (c.sessionId === update.card.sessionId ? update.card : c))
      )
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [tab.cwd, tab.provider])

  const centered = phase === 'centered'
  const floating = phase !== 'docked'

  const alerts =
    session.permissions.length > 0 || session.questions.length > 0 || session.error
  const alertBlock = alerts ? (
    <div className="px-6 pb-2">
      <div className="max-w-3xl mx-auto space-y-2">
        {session.error && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2.5 flex items-start gap-3">
            <span className="text-[13px] text-red-200 flex-1">{session.error.message}</span>
            <button
              onClick={onClearError}
              className="text-red-300 hover:text-red-100 text-[12px]"
            >
              dismiss
            </button>
          </div>
        )}
        {session.permissions.map((p) => (
          <PermissionPrompt
            key={p.requestId}
            request={p}
            onAnswer={(requestId, decision) => onAnswerPermission(requestId, decision)}
          />
        ))}
        {session.questions.map((q) => (
          <QuestionPrompt
            key={q.requestId}
            request={q}
            onAnswer={(requestId, answer) => onAnswerQuestion(requestId, answer)}
          />
        ))}
      </div>
    </div>
  ) : null

  const composer = (
    <Composer
      ref={composerRef}
      status={session.status}
      queued={tab.queued}
      sessionLocalId={tab.localId}
      contextTokens={session.contextTokens}
      model={session.model}
      provider={tab.provider}
      centered={centered}
      initialText={tab.draft?.text}
      initialImages={tab.draft?.images}
      onSend={onSend}
      onDraftChange={onDraftChange}
      onInterrupt={onInterrupt}
      onUnqueue={onUnqueue}
    />
  )

  return (
    <>
      <StatusBar
        status={session.status}
        auth={auth}
        model={session.model}
        cwd={session.cwd ?? tab.cwd}
        contextTokens={session.contextTokens}
        onClose={onClose}
        onClosePane={onClosePane}
        onNewPane={onNewPane}
        onClear={onClear}
        onShowSidebar={onShowSidebar}
        // `onClosePane` is only supplied while split, so it doubles as the
        // "this pane can be repositioned" signal.
        reorderId={onClosePane ? tab.localId : undefined}
      />

      <div
        className="relative flex-1 min-h-0 flex flex-col overflow-hidden"
        onDragOver={onDragOver}
      >
        {/* Transcript appears as soon as there's something to show. */}
        {phase !== 'centered' && <Transcript items={session.items} />}

        {/* Docked alerts live in normal flow, above the composer. */}
        {!floating && alertBlock}

        {/* Single, always-mounted composer. Its WRAPPER changes layout with the
            phase — absolutely positioned (centered → bottom) while floating, then
            static normal-flow once docked — but the composer element itself stays
            at this one position in the tree, so it never unmounts. Remounting it
            (the old dual-branch layout) reset its draft + focus and silently ate
            the keystroke mid-transition, which felt like "Enter does nothing". */}
        <div
          className={
            floating
              ? `absolute inset-x-0 px-6 transition-all duration-500 ease-out ${
                  centered ? 'top-1/2 -translate-y-1/2' : 'top-full -translate-y-full'
                }`
              : 'relative'
          }
        >
          {/* Soft fade above the docked composer so the scrolling transcript
              melts into the input area instead of ending on a hard edge. Sits
              just above the composer and is pointer-transparent so it never
              intercepts clicks/scroll. */}
          {!floating && (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-full inset-x-0 h-16 bg-gradient-to-t from-ink-950 to-transparent"
            />
          )}

          {/* Greeting — floats above the composer, fades out on dock. */}
          {floating && (
            <div
              className={`absolute bottom-full inset-x-0 px-6 mb-7 text-center transition-opacity duration-300 ${
                centered ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <div className="max-w-3xl mx-auto">
                <h2 className="text-2xl font-semibold text-ink-100">
                  What should we build{basename(tab.cwd) ? ` in ${basename(tab.cwd)}` : ''}?
                </h2>
                <p className="mt-1.5 text-[13px] text-ink-400">
                  Describe a task, or pick up where you left off below.
                </p>
              </div>
            </div>
          )}

          {composer}

          {/* Recent conversations — float below the composer, fade out on dock.
              Each card resumes that conversation when clicked. */}
          {floating && (
            <div
              className={`absolute top-full inset-x-0 px-6 mt-5 transition-opacity duration-300 ${
                centered ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              <div className="max-w-3xl mx-auto">
                {cards.length > 0 && (
                  <>
                    <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-2 text-center">
                      Pick up from a previous conversation
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {cards.map((card) => (
                        <button
                          key={card.sessionId}
                          onClick={() => onResumeConversation(card.sessionId)}
                          title={card.description ?? card.title}
                          className="group text-left px-3.5 py-2.5 rounded-xl border border-ink-700 bg-ink-850 hover:border-accent/70 hover:bg-ink-800 transition-colors"
                        >
                          <div className="text-[13px] font-medium text-ink-100 truncate group-hover:text-white">
                            {clamp(card.title, 60)}
                          </div>
                          <div className="mt-0.5 text-[12px] text-ink-400 line-clamp-2 min-h-[2.25em]">
                            {card.description ?? (
                              <span className="italic text-ink-500">
                                {card.pending ? 'Summarizing…' : 'No description'}
                              </span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Full-bleed drag-and-drop overlay. Mounted always (so it can fade),
            but only grabs pointer/drop events while a drag is in flight. The
            overlay sits on top, so the drop lands here no matter where in the
            surface you release. */}
        <div
          onDragOver={onDragOver}
          onDrop={onDrop}
          className={`absolute inset-0 z-30 grid place-items-center transition-opacity duration-200 ${
            dragging ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="absolute inset-3 rounded-2xl border-2 border-dashed border-accent/70 bg-ink-950/70 backdrop-blur-sm" />
          <div className="relative flex flex-col items-center gap-3 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl border border-accent/50 bg-accent/15 text-accent">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 15.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5M12 3.5v11M12 3.5L8 7.5M12 3.5l4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="text-[15px] font-semibold text-ink-100">Drop images to attach</div>
            <div className="text-[12px] text-ink-400">They'll be added to your message</div>
          </div>
        </div>
      </div>
    </>
  )
}
