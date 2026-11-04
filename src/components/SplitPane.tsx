import { useMemo, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from '@primer/octicons-react'
import { dragWidth, keyWidth, restorePaneState, type PaneBounds, type PaneSide, type PaneState } from '../lib/panes'
import { useSharedPref } from '../lib/storage'

interface SplitPaneBase {
  first: ReactNode
  second: ReactNode
  /** Names the panes on the divider's controls and on a collapsed pane's strip. */
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

/** Both panes stay mounted when one collapses, so its scroll position and unsent text survive. */
export function SplitPaneView({ first, second, firstLabel, secondLabel, min, max, defaultWidth, sized = 'first', state, onChange }: SplitPaneViewProps) {
  const bounds: PaneBounds = { min, max }
  const drag = useRef<{ x: number; width: number } | null>(null)
  const sizedLabel = sized === 'first' ? firstLabel : secondLabel
  const paneProps = (side: PaneSide) => {
    const collapsed = state.collapsed === side
    const isSized = side === sized && !state.collapsed
    return { className: `ws-pane${isSized ? ' ws-pane-sized' : ''}`, hidden: collapsed, style: isSized ? { width: state.width } : undefined }
  }
  const setCollapsed = (collapsed: PaneSide | null) => onChange({ ...state, collapsed })
  const strip = (side: PaneSide, label: string) =>
    state.collapsed === side && (
      <button type="button" className="ws-pane-strip" aria-label={`Show ${label}`} onClick={() => setCollapsed(null)}>
        <span className="ws-pane-strip-label">{label}</span>
      </button>
    )

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width: state.width }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onChange({ ...state, width: dragWidth(drag.current.width, drag.current.x, e.clientX, bounds, sized) })
  }
  // The browser can merge the last move into the release, so the release has the final say.
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    onPointerMove(e)
    drag.current = null
  }
  const onPointerCancel = () => {
    drag.current = null
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const width = keyWidth(state.width, e.key, bounds, sized)
    if (width === null) return
    e.preventDefault()
    onChange({ ...state, width })
  }

  return (
    <div className="ws-split">
      <div {...paneProps('first')}>{first}</div>
      {strip('first', firstLabel)}
      {!state.collapsed && (
        <div className="ws-divider">
          <div
            className="ws-divider-handle"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={`Resize ${sizedLabel}`}
            aria-valuenow={state.width}
            aria-valuemin={min}
            aria-valuemax={max}
            title="Drag to resize. Double-click to reset."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onPointerCancel}
            onKeyDown={onKeyDown}
            onDoubleClick={() => onChange({ ...state, width: defaultWidth })}
          />
          <button type="button" className="ws-divider-button ws-divider-button-first" aria-label={`Collapse ${firstLabel}`} title={`Collapse ${firstLabel}`} onClick={() => setCollapsed('first')}>
            <ChevronLeftIcon size={12} />
          </button>
          <button type="button" className="ws-divider-button ws-divider-button-second" aria-label={`Collapse ${secondLabel}`} title={`Collapse ${secondLabel}`} onClick={() => setCollapsed('second')}>
            <ChevronRightIcon size={12} />
          </button>
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
