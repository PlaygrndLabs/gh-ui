import { useMemo, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { clampWidth, dragCollapse, dragWidth, keyWidth, restorePaneState, type PaneBounds, type PaneSide, type PaneState } from '../lib/panes'
import { useSharedPref } from '../lib/storage'

interface SplitPaneBase {
  first: ReactNode
  second: ReactNode
  /** Names the panes on the divider and on a collapsed pane's strip. */
  firstLabel: string
  secondLabel: string
  min: number
  max: number
  defaultWidth: number
  /** The pane the width applies to; the other one fills the space. */
  sized?: PaneSide
}

interface SplitPaneViewProps extends SplitPaneBase {
  state: PaneState
  onChange(next: PaneState): void
}

interface PaneHandleProps {
  /** Names the pane being resized. */
  label: string
  width: number
  min: number
  max: number
  defaultWidth: number
  sized?: PaneSide
  onResize(width: number): void
  /** `width` is what the pane had before the drag, to come back at. */
  onCollapse(side: PaneSide, width: number): void
}

/** The draggable part of a divider, for layouts that can't be a SplitPane (its panes clip, which ends position: sticky inside them). */
export function PaneHandle({ label, width, min, max, defaultWidth, sized = 'first', onResize, onCollapse }: PaneHandleProps) {
  const bounds: PaneBounds = { min, max }
  const drag = useRef<{ x: number; width: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onResize(dragWidth(drag.current.width, drag.current.x, e.clientX, bounds, sized))
  }
  // The browser can merge the last move into the release, so the release has the final say.
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    drag.current = null
    if (!start) return
    const collapsed = dragCollapse(start.width, start.x, e.clientX, bounds, sized)
    if (collapsed) onCollapse(collapsed, start.width)
    else onResize(dragWidth(start.width, start.x, e.clientX, bounds, sized))
  }
  const onPointerCancel = () => {
    drag.current = null
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      return onCollapse(sized, width)
    }
    const next = keyWidth(width, e.key, bounds, sized)
    if (next === null) return
    e.preventDefault()
    onResize(next)
  }

  return (
    <div
      className="ws-divider-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag to resize, or past the edge to hide. Double-click to reset."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(defaultWidth)}
    />
  )
}

/** Both panes stay mounted when one collapses, so its scroll position and unsent text survive. */
export function SplitPaneView({ first, second, firstLabel, secondLabel, min, max, defaultWidth, sized = 'first', state, onChange }: SplitPaneViewProps) {
  const bounds: PaneBounds = { min, max }
  const sizedLabel = sized === 'first' ? firstLabel : secondLabel
  const paneProps = (side: PaneSide) => {
    const collapsed = state.collapsed === side
    const isSized = side === sized && !state.collapsed
    return { className: `ws-pane${isSized ? ' ws-pane-sized' : ''}`, hidden: collapsed, style: isSized ? { width: state.width } : undefined }
  }
  const setCollapsed = (collapsed: PaneSide | null) => onChange({ ...state, collapsed })
  // Dragging out of the strip keeps going after the strip is gone, so this follows the window rather than the element.
  const onStripPointerDown = (e: PointerEvent<HTMLButtonElement>, side: PaneSide) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const outward = side === 'first' ? 1 : -1
    const move = (ev: globalThis.PointerEvent) => {
      const distance = (ev.clientX - startX) * outward
      if (distance < 4) return
      onChange({ width: side === sized ? clampWidth(distance, bounds) : state.width, collapsed: null })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const strip = (side: PaneSide, label: string) =>
    state.collapsed === side && (
      <button type="button" className="ws-pane-strip" aria-label={`Show ${label}`} title={`Drag to show ${label}`} onPointerDown={(e) => onStripPointerDown(e, side)} onClick={() => setCollapsed(null)}>
        <span className="ws-pane-strip-label">{label}</span>
      </button>
    )

  return (
    <div className="ws-split">
      <div {...paneProps('first')}>{first}</div>
      {strip('first', firstLabel)}
      {!state.collapsed && (
        <div className="ws-divider">
          <PaneHandle
            label={sizedLabel}
            width={state.width}
            min={min}
            max={max}
            defaultWidth={defaultWidth}
            sized={sized}
            onResize={(width) => onChange({ ...state, width })}
            onCollapse={(collapsed, width) => onChange({ width, collapsed })}
          />
        </div>
      )}
      {strip('second', secondLabel)}
      <div {...paneProps('second')}>{second}</div>
    </div>
  )
}

/** Two panes with a draggable divider; sizes and collapsed panes are remembered under `id` and shared by every tab. */
export function SplitPane({ id, ...props }: SplitPaneBase & { id: string }) {
  const [saved, setSaved] = useSharedPref<Partial<PaneState> | null>(`pane:${id}`, null)
  const state = useMemo(() => restorePaneState(saved, props.defaultWidth, { min: props.min, max: props.max }), [saved, props.defaultWidth, props.min, props.max])
  return <SplitPaneView {...props} state={state} onChange={setSaved} />
}
