import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { clampWidth, dragCollapse, dragWidth, keyWidth, restorePaneState } from '../lib/panes'
import { SplitPaneView } from './SplitPane'

const bounds = { min: 100, max: 400 }

describe('pane rules', () => {
  it('keeps widths inside the bounds', () => {
    expect(clampWidth(50, bounds)).toBe(100)
    expect(clampWidth(999, bounds)).toBe(400)
    expect(clampWidth(200.4, bounds)).toBe(200)
  })

  it('drags toward the pane on either side', () => {
    expect(dragWidth(200, 500, 530, bounds)).toBe(230)
    expect(dragWidth(200, 500, 530, bounds, 'second')).toBe(170)
    expect(dragWidth(200, 500, 5000, bounds)).toBe(400)
  })

  it('hides a pane only when a drag goes well past a limit', () => {
    expect(dragCollapse(200, 500, 460, bounds)).toBeNull()
    expect(dragCollapse(200, 500, 360, bounds)).toBeNull()
    expect(dragCollapse(200, 500, 200, bounds)).toBe('first')
    expect(dragCollapse(200, 500, 800, bounds)).toBe('second')
    expect(dragCollapse(200, 500, 800, bounds, 'second')).toBe('second')
    expect(dragCollapse(200, 500, 200, bounds, 'second')).toBe('first')
  })

  it('resizes from the keyboard and ignores other keys', () => {
    expect(keyWidth(200, 'ArrowRight', bounds)).toBe(220)
    expect(keyWidth(200, 'ArrowRight', bounds, 'second')).toBe(180)
    expect(keyWidth(200, 'Home', bounds)).toBe(100)
    expect(keyWidth(200, 'End', bounds)).toBe(400)
    expect(keyWidth(200, 'a', bounds)).toBeNull()
  })

  it('repairs a saved state', () => {
    expect(restorePaneState(null, 250, bounds)).toEqual({ width: 250, collapsed: null })
    expect(restorePaneState({ width: 9000, collapsed: 'second' }, 250, bounds)).toEqual({ width: 400, collapsed: 'second' })
    expect(restorePaneState({ width: Number.NaN, collapsed: 'sideways' as never }, 250, bounds)).toEqual({ width: 250, collapsed: null })
  })
})

describe('SplitPaneView', () => {
  const render = (collapsed: 'first' | 'second' | null, sized?: 'first' | 'second') =>
    renderToStaticMarkup(
      <SplitPaneView first={<p>list</p>} second={<p>detail</p>} firstLabel="List" secondLabel="Detail" min={100} max={400} defaultWidth={200} sized={sized} state={{ width: 240, collapsed }} onChange={() => {}} />,
    )

  it('sizes one pane and has no collapse buttons', () => {
    const html = render(null)
    expect(html).toContain('style="width:240px"')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-valuenow="240"')
    expect(html).not.toContain('Collapse')
    expect(html).not.toContain('Show List')
  })

  it('sizes the second pane when asked', () => {
    expect(render(null, 'second')).toMatch(/<p>list<\/p><\/div>.*style="width:240px"><p>detail/)
  })

  it('swaps a collapsed pane for a strip and keeps it mounted', () => {
    const html = render('first')
    expect(html).toContain('aria-label="Show List"')
    expect(html).toContain('hidden=""')
    expect(html).toContain('<p>list</p>')
    expect(html).not.toContain('role="separator"')
    expect(html).not.toContain('style="width')
  })
})
