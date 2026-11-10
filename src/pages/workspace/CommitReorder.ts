import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { moveCommit } from '../../lib/git'

export type GrabRow = (e: ReactPointerEvent<HTMLElement>) => void

/** How close to the list's edge, in pixels, a drag has to be to scroll it. */
const SCROLL_EDGE = 32
const SCROLL_STEP = 16

/**
 * Reorder Commit in History: the menu picks a commit up, and dragging it to a gap among `movable` (newest first) hands
 * back the new order. It lets go by itself if the commit stops being movable.
 */
export function useCommitReorder(movable: string[], onReorder: (order: string[]) => void) {
  const [picked, setPicked] = useState<string | null>(null)
  const [gap, setGap] = useState<number | null>(null)
  const moving = picked && movable.includes(picked) ? picked : null
  const from = moving ? movable.indexOf(moving) : -1
  // Letting go next to where it started changes nothing.
  const changes = (at: number) => at !== from && at !== from + 1

  const endDrag = useRef<(() => void) | null>(null)
  const cancel = useCallback(() => {
    endDrag.current?.()
    setPicked(null)
  }, [])

  useEffect(() => {
    if (picked && !moving) setPicked(null)
  }, [picked, moving])

  useEffect(() => {
    if (!moving) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      endDrag.current?.()
    }
  }, [moving, cancel])

  const grab = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || endDrag.current) return
    const list = e.currentTarget.closest<HTMLElement>('.ws-scroll')
    if (!list) return
    const gapAt = (y: number) => {
      const rows = [...list.querySelectorAll('[data-reorder]')]
      const below = rows.findIndex((row) => {
        const box = row.getBoundingClientRect()
        return y < box.top + box.height / 2
      })
      return below < 0 ? rows.length : below
    }
    const move = (ev: PointerEvent) => {
      const box = list.getBoundingClientRect()
      if (ev.clientY < box.top + SCROLL_EDGE) list.scrollTop -= SCROLL_STEP
      else if (ev.clientY > box.bottom - SCROLL_EDGE) list.scrollTop += SCROLL_STEP
      setGap(gapAt(ev.clientY))
    }
    const drop = (ev: PointerEvent) => {
      const at = gapAt(ev.clientY)
      endDrag.current?.()
      if (!changes(at)) return
      setPicked(null)
      onReorder(moveCommit(movable, from, at))
    }
    const stop = () => endDrag.current?.()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', drop)
    window.addEventListener('pointercancel', stop)
    endDrag.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', drop)
      window.removeEventListener('pointercancel', stop)
      endDrag.current = null
      setGap(null)
    }
  }
  const latest = useRef(grab)
  latest.current = grab
  // The same function every time, so a drag only redraws the rows the line moves between.
  const stableGrab = useCallback<GrabRow>((e) => latest.current(e), [])

  return { moving, dropGap: gap !== null && changes(gap) ? gap : null, start: setPicked, cancel, grab: stableGrab }
}
