// The rules of a resizable, collapsible pair of panes, apart from React and the DOM.

export type PaneSide = 'first' | 'second'

export interface PaneBounds {
  min: number
  max: number
}

export interface PaneState {
  /** The sized pane's width in CSS pixels; the other pane takes the rest. */
  width: number
  /** At most one, so there's always a pane showing. */
  collapsed: PaneSide | null
}

export const PANE_KEY_STEP = 20
/** How far past a pane's limit a drag has to go to hide a pane. */
export const PANE_COLLAPSE_DRAG = 48

export const clampWidth = (width: number, { min, max }: PaneBounds) => Math.round(Math.min(max, Math.max(min, width)))

/** `sized` is the pane the width belongs to: dragging toward it shrinks it. */
export function dragWidth(startWidth: number, startX: number, x: number, bounds: PaneBounds, sized: PaneSide = 'first') {
  return clampWidth(startWidth + (x - startX) * (sized === 'first' ? 1 : -1), bounds)
}

/** The pane a released drag hides: the sized one when dragged well past its minimum, the other one well past its maximum. */
export function dragCollapse(startWidth: number, startX: number, x: number, { min, max }: PaneBounds, sized: PaneSide = 'first'): PaneSide | null {
  const width = startWidth + (x - startX) * (sized === 'first' ? 1 : -1)
  if (width < min - PANE_COLLAPSE_DRAG) return sized
  if (width > max + PANE_COLLAPSE_DRAG) return sized === 'first' ? 'second' : 'first'
  return null
}

/** The width after an arrow key on the divider, or null when the key doesn't resize. */
export function keyWidth(width: number, key: string, bounds: PaneBounds, sized: PaneSide = 'first') {
  if (key === 'Home') return bounds.min
  if (key === 'End') return bounds.max
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const toward = key === 'ArrowRight' ? 1 : -1
  return clampWidth(width + toward * PANE_KEY_STEP * (sized === 'first' ? 1 : -1), bounds)
}

/** A saved state as a valid one: the bounds may have changed since, and preferences can be edited or truncated. */
export function restorePaneState(saved: Partial<PaneState> | null | undefined, defaultWidth: number, bounds: PaneBounds): PaneState {
  const width = typeof saved?.width === 'number' && Number.isFinite(saved.width) ? saved.width : defaultWidth
  const collapsed = saved?.collapsed === 'first' || saved?.collapsed === 'second' ? saved.collapsed : null
  return { width: clampWidth(width, bounds), collapsed }
}
