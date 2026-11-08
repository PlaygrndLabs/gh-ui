import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { BRANCH_SIDEBAR, restorePaneState, type PaneState } from '../lib/panes'
import { useSharedPref } from '../lib/storage'

/**
 * Sizes a toolbar menu, from under the toolbar to the bottom of the window. `start` lines it up with the sidebar, at
 * the sidebar's width on every page; `button` fits it to the header button that opens it.
 */
export function useToolbarPanel(open: boolean, placement: 'start' | 'button') {
  const anchor = useRef<HTMLButtonElement>(null)
  const [frame, setFrame] = useState<CSSProperties>()
  const [saved] = useSharedPref<Partial<PaneState> | null>(`pane:${BRANCH_SIDEBAR.id}`, null)
  const { width } = restorePaneState(saved, BRANCH_SIDEBAR.defaultWidth, BRANCH_SIDEBAR)

  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const button = anchor.current!.getBoundingClientRect()
      const toolbar = anchor.current!.closest('.ws-toolbar')!.getBoundingClientRect()
      const [left, fitted] = placement === 'start' ? [toolbar.left, Math.min(width, toolbar.width)] : [button.left, button.width]
      setFrame({ '--ws-panel-top': `${toolbar.bottom}px`, '--ws-panel-left': `${left}px`, '--ws-panel-width': `${fitted}px` } as CSSProperties)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, placement, width])

  return { anchor, frame }
}
