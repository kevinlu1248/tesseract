import type { PermissionDecision, PermissionRequest } from '../../shared/ipc'
import { formatToolInput } from '../../shared/schema'

interface Props {
  request: PermissionRequest
  onAnswer: (requestId: string, decision: PermissionDecision) => void
}

export function PermissionPrompt({ request, onAnswer }: Props) {
  const input = formatToolInput(JSON.stringify(request.input))
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-300 text-[13px] font-semibold">
          Permission required
        </span>
        <span className="text-[11px] uppercase tracking-wide font-mono text-amber-200/80">
          {request.toolName}
        </span>
      </div>
      <pre className="text-[12px] leading-relaxed text-amber-100/90 font-mono whitespace-pre-wrap break-words max-h-44 overflow-y-auto mb-3">
        {input}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={() => onAnswer(request.requestId, { behavior: 'allow' })}
          className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium"
        >
          Approve
        </button>
        <button
          onClick={() =>
            onAnswer(request.requestId, { behavior: 'deny', message: 'Denied by user' })
          }
          className="px-3 py-1.5 rounded-md bg-ink-700 hover:bg-ink-600 text-ink-200 text-[12px] font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  )
}
