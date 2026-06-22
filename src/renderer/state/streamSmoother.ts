/**
 * Smooths the live token stream. The SDK emits text deltas in irregular bursts
 * (a clump of tokens, then a pause), which makes the transcript lurch forward in
 * chunks. This buffer accepts those bursts and releases text at a steady
 * character-per-frame cadence via requestAnimationFrame, so rendering reads as a
 * smooth typewriter regardless of how the bytes actually arrive.
 *
 * Ordering is preserved: non-text events (block_stop, tool_result, status, …)
 * queue behind any text still draining, so the "running" indicator and tool
 * cards never appear before the prose that logically precedes them.
 */
import type { SessionOutboundEvent } from '../../shared/ipc'
import type { CcEvent } from '../../shared/schema'

type DripType = 'text_delta' | 'thinking_delta'

type QueueItem =
  | { kind: 'drip'; type: DripType; blockId: string; remaining: string }
  | { kind: 'raw'; event: SessionOutboundEvent }

/** Floor on release rate — keeps slow trickles visibly moving. */
const MIN_CHARS_PER_FRAME = 2
/** Ceiling — stops a huge backlog from dumping in one janky frame. */
const MAX_CHARS_PER_FRAME = 120
/** Target: drain whatever is buffered within ~this many frames (~0.4s @60fps). */
const DRAIN_FRAMES = 24

export class StreamSmoother {
  private queue: QueueItem[] = []
  private raf: number | null = null

  constructor(private readonly emit: (event: SessionOutboundEvent) => void) {}

  /** Feed one inbound event. Text deltas are buffered; everything else queues in order. */
  push(event: SessionOutboundEvent): void {
    if (event.kind === 'cc' && isDrip(event.event)) {
      const cc = event.event
      const last = this.queue[this.queue.length - 1]
      // Coalesce consecutive deltas for the same block — keeps the queue small
      // and makes the backlog math a single length lookup.
      if (last && last.kind === 'drip' && last.type === cc.type && last.blockId === cc.blockId) {
        last.remaining += cc.text
      } else {
        this.queue.push({ kind: 'drip', type: cc.type, blockId: cc.blockId, remaining: cc.text })
      }
    } else {
      this.queue.push({ kind: 'raw', event })
    }
    this.schedule()
  }

  /** Dump everything still buffered immediately, then stop (interrupt / unmount). */
  flush(): void {
    this.cancel()
    for (const it of this.queue) this.emitItem(it, it.kind === 'drip' ? it.remaining : undefined)
    this.queue = []
  }

  /** Drop everything without emitting (starting a fresh session). */
  reset(): void {
    this.cancel()
    this.queue = []
  }

  private pendingChars(): number {
    let n = 0
    for (const it of this.queue) if (it.kind === 'drip') n += it.remaining.length
    return n
  }

  private schedule(): void {
    if (this.raf !== null) return
    this.raf = requestAnimationFrame(() => {
      this.raf = null
      this.tick()
    })
  }

  private cancel(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }

  private tick(): void {
    // Scale the per-frame budget to the backlog so we catch up after a big burst
    // without ever exceeding a smooth ceiling.
    let budget = Math.min(
      MAX_CHARS_PER_FRAME,
      Math.max(MIN_CHARS_PER_FRAME, Math.ceil(this.pendingChars() / DRAIN_FRAMES))
    )

    while (this.queue.length) {
      const head = this.queue[0]
      if (head.kind === 'raw') {
        // FIFO guarantees all earlier text has flushed, so order is intact.
        this.emit(head.event)
        this.queue.shift()
        continue
      }
      if (budget <= 0) break
      const take = Math.min(budget, head.remaining.length)
      this.emitItem(head, head.remaining.slice(0, take))
      head.remaining = head.remaining.slice(take)
      budget -= take
      if (head.remaining.length === 0) this.queue.shift()
    }

    if (this.queue.length) this.schedule()
  }

  private emitItem(item: QueueItem, text?: string): void {
    if (item.kind === 'raw') {
      this.emit(item.event)
      return
    }
    const cc: CcEvent =
      item.type === 'text_delta'
        ? { type: 'text_delta', blockId: item.blockId, text: text ?? '' }
        : { type: 'thinking_delta', blockId: item.blockId, text: text ?? '' }
    this.emit({ kind: 'cc', event: cc })
  }
}

function isDrip(e: CcEvent): e is Extract<CcEvent, { type: DripType }> {
  return e.type === 'text_delta' || e.type === 'thinking_delta'
}
