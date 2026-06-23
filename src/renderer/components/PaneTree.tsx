import { Fragment, useRef, type ReactNode } from 'react'
import { paneIds, type PaneNode } from '../state/workspaceStore'

interface Props {
  node: PaneNode
  /** Render one session pane (the wrapped <Pane>) for the given tab localId. */
  renderLeaf: (id: string) => ReactNode
  /**
   * Commit new child sizes for the split at `path` (the chain of child indices
   * from the root to that split) after the user drags a divider.
   */
  onResize?: (path: number[], sizes: number[]) => void
  /** This node's path (child indices) from the root. Root is `[]`. */
  path?: number[]
}

/** Each pane keeps at least this many pixels when a divider is dragged. */
const MIN_PANE_PX = 140

/**
 * Recursively renders a pane layout tree. A `leaf` delegates to `renderLeaf`; a
 * `split` becomes a flex container — `row` lays its children left→right, `col`
 * stacks them top→bottom — with a draggable divider between adjacent children.
 * Each child's share of the space is its `flex-grow` weight (from the split's
 * `sizes`, defaulting to equal); nesting a row inside a col gives arbitrary
 * tiled layouts.
 *
 * Children are keyed by the set of leaf ids they contain so a leaf keeps its
 * React identity (and its ConversationView state) as the surrounding structure
 * is reshaped by splits/closes.
 */
export function PaneTree({ node, renderLeaf, onResize, path = [] }: Props): ReactNode {
  if (node.t === 'leaf') return <>{renderLeaf(node.id)}</>
  return <SplitNode node={node} renderLeaf={renderLeaf} onResize={onResize} path={path} />
}

// Split rendering lives in its own component so its hooks (the container ref)
// are never called conditionally — PaneTree itself bails out for leaf nodes
// before any hook would run.
function SplitNode({
  node,
  renderLeaf,
  onResize,
  path
}: Props & { node: Extract<PaneNode, { t: 'split' }>; path: number[] }): ReactNode {
  const isRow = node.dir === 'row'
  const n = node.children.length
  // Fall back to equal weights when sizes are absent or stale (child count
  // changed since they were set, e.g. after a split or close).
  const sizes = node.sizes && node.sizes.length === n ? node.sizes : node.children.map(() => 1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Drag the divider that sits before child `i`, transferring space between
  // children i-1 and i. Sizes are computed absolutely from the drag's start so
  // the pane edge tracks the cursor exactly (no drift).
  const startDrag = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container || !onResize) return
    const rect = container.getBoundingClientRect()
    const total = isRow ? rect.width : rect.height
    if (total <= 0) return

    const base = [...sizes]
    const sum = base.reduce((a, b) => a + b, 0)
    const startPos = isRow ? e.clientX : e.clientY
    const a0 = base[i - 1]
    const b0 = base[i]
    const pair = a0 + b0
    // Minimum weight per pane, expressed in the same units as `sizes`.
    const minUnit = Math.min((MIN_PANE_PX / total) * sum, pair / 2)

    document.body.style.cursor = isRow ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      const pos = isRow ? ev.clientX : ev.clientY
      const deltaUnits = ((pos - startPos) / total) * sum
      const a = Math.max(minUnit, Math.min(pair - minUnit, a0 + deltaUnits))
      const next = [...base]
      next[i - 1] = a
      next[i] = pair - a
      onResize(path, next)
    }
    const onUp = (): void => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-w-0 min-h-0 flex ${isRow ? 'flex-row' : 'flex-col'}`}
    >
      {node.children.map((child, i) => (
        <Fragment key={`${child.t}:${paneIds(child).join('-')}`}>
          {i > 0 && (
            <div
              onMouseDown={startDrag(i)}
              title="Drag to resize"
              className={`${
                isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
              } shrink-0 bg-ink-800 hover:bg-accent transition-colors`}
            />
          )}
          <div
            className="flex min-w-0 min-h-0 overflow-hidden"
            style={{ flexGrow: sizes[i], flexBasis: 0 }}
          >
            <PaneTree node={child} renderLeaf={renderLeaf} onResize={onResize} path={[...path, i]} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}
