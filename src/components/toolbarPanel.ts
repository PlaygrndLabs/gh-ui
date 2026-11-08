import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** Sizes a toolbar menu: as wide as the header button that opens it, from under the toolbar to the bottom of the window. */
export function useToolbarPanel(open: boolean) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [frame, setFrame] = useState<CSSProperties>()

  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const { left, width, bottom } = anchor.current!.getBoundingClientRect()
      setFrame({ '--ws-panel-top': `${bottom}px`, '--ws-panel-left': `${left}px`, '--ws-panel-width': `${width}px` } as CSSProperties)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  return { anchor, frame }
}
