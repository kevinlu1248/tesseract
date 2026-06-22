import { useEffect, useState } from 'react'
import type { BackendProvider, SessionSummary } from '../../shared/ipc'

interface Props {
  onNew: (cwd: string, yolo: boolean, provider: BackendProvider) => void
  onResume: (cwd: string, sessionId: string, yolo: boolean, provider: BackendProvider) => void
  /** When opening an extra tab alongside existing ones, allow backing out. */
  onCancel?: () => void
  /** Pre-select this workspace (e.g. the current session's cwd) instead of forcing a pick. */
  defaultCwd?: string
}

export function StartScreen({ onNew, onResume, onCancel, defaultCwd }: Props) {
  const [repo, setRepo] = useState<string | null>(defaultCwd ?? null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [yolo, setYolo] = useState(true)
  const [provider, setProvider] = useState<BackendProvider>('claude')

  useEffect(() => {
    if (!repo) return
    setLoading(true)
    window.api
      .listSessions(repo, provider)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [repo, provider])

  const pick = async (): Promise<void> => {
    const dir = await window.api.pickRepo()
    if (dir) setRepo(dir)
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3 mb-2">
          <img
            src="/icon.svg"
            alt="Tesseract"
            className="w-9 h-9 rounded-xl shadow-lg shadow-accent/10"
          />
          <h1 className="text-xl font-semibold text-ink-100">Tesseract</h1>
          {onCancel && (
            <button
              onClick={onCancel}
              className="ml-auto text-[12px] text-ink-400 hover:text-ink-200"
            >
              cancel
            </button>
          )}
        </div>
        <p className="text-ink-400 text-[13px] mb-6">
          Run Claude Code with output rendered as a real document — no terminal.
        </p>

        {!repo ? (
          <button
            onClick={pick}
            className="w-full px-4 py-3 rounded-xl bg-accent hover:bg-[#5b97f5] text-ink-950 font-semibold transition-colors"
          >
            Open a repository…
          </button>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[12px] text-ink-300 truncate" title={repo}>
                {repo}
              </span>
              <button
                onClick={() => setRepo(null)}
                className="text-[12px] text-ink-400 hover:text-ink-200"
              >
                change
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 rounded-lg border border-ink-800 bg-ink-900 p-1">
              {(['claude', 'codex'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`px-3 py-2 rounded-md text-[13px] font-medium transition-colors ${
                    provider === p
                      ? 'bg-accent text-ink-950'
                      : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                  }`}
                >
                  {p === 'claude' ? 'Claude Code' : 'Codex'}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2.5 px-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={yolo}
                onChange={(e) => setYolo(e.target.checked)}
                className="accent-accent w-4 h-4"
              />
              <span className="text-[13px] text-ink-200">
                Yolo mode
                <span className="text-ink-500"> — auto-approve every tool (no prompts)</span>
              </span>
            </label>

            <button
              onClick={() => onNew(repo, yolo, provider)}
              className="w-full px-4 py-3 rounded-xl bg-accent hover:bg-[#5b97f5] text-ink-950 font-semibold transition-colors"
            >
              + New {provider === 'claude' ? 'Claude' : 'Codex'} session
            </button>

            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-2">
                {loading ? 'Loading sessions…' : `Resume a session (${sessions.length})`}
              </div>
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => onResume(repo, s.sessionId, yolo, provider)}
                    className="w-full text-left px-3 py-2 rounded-lg border border-ink-800 bg-ink-850 hover:border-ink-600 transition-colors"
                  >
                    <div className="text-[13px] text-ink-200 truncate">
                      {s.summary || s.firstPrompt || s.sessionId}
                    </div>
                    <div className="text-[11px] text-ink-500">
                      {new Date(s.lastModified).toLocaleString()}
                    </div>
                  </button>
                ))}
                {!loading && sessions.length === 0 && (
                  <div className="text-[12px] text-ink-500 italic">
                    No prior sessions in this repo yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
