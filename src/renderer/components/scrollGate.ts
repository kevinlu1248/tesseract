import { createContext, useContext } from 'react'

/** Whether an expanded tool body has been "clicked into" and may own a scroll
 *  container. Default `true` so standalone consumers (with no gate wrapper)
 *  keep their normal scrolling; inside an ExpandableTool the provider passes
 *  the real clicked-in state so nothing scrolls until the user clicks in. This
 *  prevents a scrollable region nested inside the page's scroll from trapping
 *  the wheel (scrollable-in-scrollable). */
export const ScrollGateContext = createContext(true)

/** Tailwind overflow class for an inner scroll container, gated on whether the
 *  body has been clicked into. `axis` picks which axis may scroll once active. */
export function useScrollGate(axis: 'x' | 'y'): string {
  const active = useContext(ScrollGateContext)
  if (!active) return 'overflow-hidden'
  return axis === 'x' ? 'overflow-x-auto' : 'overflow-y-auto'
}
