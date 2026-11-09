import { useLayoutEffect, useRef } from 'react'
import { PaneHandle } from '../../../components/SplitPane'
import { restorePaneState } from '../../../lib/panes'
import { useSharedPref } from '../../../lib/storage'

const BOUNDS = { min: 160, max: 520 }

/**
 * The divider beside the changed-files tree. It holds the width itself and hands it to the
 * grid as a CSS variable, so a drag re-renders this and not every diff in the pull request.
 */
export function FileTreeResizer({ defaultWidth, onHide }: { defaultWidth: number; onHide(): void }) {
  const [saved, setSaved] = useSharedPref<number | null>('pane:files-tree', null)
  const { width } = restorePaneState({ width: saved ?? undefined }, defaultWidth, BOUNDS)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    box.current?.parentElement?.style.setProperty('--files-tree-width', `${width}px`)
  }, [width])
  return (
    <div className="ws-divider files-tree-resizer" ref={box}>
      <PaneHandle
        label="Changed files"
        width={width}
        min={BOUNDS.min}
        max={BOUNDS.max}
        defaultWidth={defaultWidth}
        onResize={setSaved}
        // Past the far edge a SplitPane hides the other pane, but the diffs are why this page is open.
        onCollapse={(side) => (side === 'first' ? onHide() : setSaved(BOUNDS.max))}
      />
    </div>
  )
}
