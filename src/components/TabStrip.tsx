import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { flushSync } from 'react-dom'
import { IconButton } from '@primer/react'
import {
  CodeIcon,
  CommentDiscussionIcon,
  DeviceDesktopIcon,
  GearIcon,
  GitPullRequestIcon,
  HomeIcon,
  InboxIcon,
  IssueOpenedIcon,
  PersonIcon,
  PlayIcon,
  PlusIcon,
  RepoIcon,
  SearchIcon,
  XIcon,
  type Icon,
} from '@primer/octicons-react'
import { tabButtonId, tabPanelId, useTabs } from '../lib/TabsProvider'
import { iconFromPath, tabTitle, type Tab, type TabIcon } from '../lib/tabs'

const ICONS: Record<TabIcon, Icon> = {
  home: HomeIcon,
  pull: GitPullRequestIcon,
  issue: IssueOpenedIcon,
  run: PlayIcon,
  repo: RepoIcon,
  code: CodeIcon,
  discussion: CommentDiscussionIcon,
  inbox: InboxIcon,
  search: SearchIcon,
  settings: GearIcon,
  local: DeviceDesktopIcon,
  person: PersonIcon,
}

// A press has to travel this far before it counts as dragging the tab.
const DRAG_THRESHOLD = 4
const AUTO_SCROLL_EDGE = 24
const AUTO_SCROLL_MAX = 8

/** The row of tabs at the very top of the window, sharing it with the macOS window buttons. */
export function TabStrip() {
  const { state, active, select, newTab, close } = useTabs()
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.getElementById(tabButtonId(active.id))?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active.id, state.tabs.length])

  // A shortcut can change the tab while keyboard focus is on the strip; the focus ring belongs on the selected tab.
  useEffect(() => {
    const focused = document.activeElement
    if (focused?.getAttribute('role') === 'tab' && focused.id !== tabButtonId(active.id)) document.getElementById(tabButtonId(active.id))?.focus()
  }, [active.id])

  const goTo = (tab: Tab | undefined) => {
    if (!tab) return
    select(tab.id)
    document.getElementById(tabButtonId(tab.id))?.focus()
  }

  // The usual tablist keys: arrows and Home/End move and select together, and Delete closes.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = state.tabs.findIndex((t) => t.id === active.id)
    if (e.key === 'ArrowRight') goTo(state.tabs[(at + 1) % state.tabs.length])
    else if (e.key === 'ArrowLeft') goTo(state.tabs[(at - 1 + state.tabs.length) % state.tabs.length])
    else if (e.key === 'Home') goTo(state.tabs[0])
    else if (e.key === 'End') goTo(state.tabs[state.tabs.length - 1])
    else if (e.key === 'Delete') close(active.id)
    else return
    e.preventDefault()
  }

  // A mouse wheel only scrolls up and down; once the tabs overflow, that should move them along.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (list.current && !e.deltaX) list.current.scrollLeft += e.deltaY
  }

  return (
    // Pressing anything here (a tab, its close button, +) shouldn't take focus from the page, where arrow keys and
    // half-written text belong. The keyboard still reaches them.
    <div className="tab-strip" onMouseDown={(e) => e.preventDefault()}>
      <div className="tab-list" role="tablist" aria-label="Open tabs" ref={list} onKeyDown={onKeyDown} onWheel={onWheel}>
        {state.tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} active={tab.id === active.id} live={state.live.includes(tab.id)} list={list} />
        ))}
      </div>
      <IconButton className="tab-new" icon={PlusIcon} aria-label="New tab" size="small" variant="invisible" onClick={newTab} />
    </div>
  )
}

function TabItem({ tab, active, live, list }: { tab: Tab; active: boolean; live: boolean; list: React.RefObject<HTMLDivElement | null> }) {
  const { state, select, close, move } = useTabs()
  const title = tabTitle(tab)
  const Icon = ICONS[iconFromPath(tab.url)]
  const stateRef = useRef(state)
  stateRef.current = state

  // Dragging follows the pointer, and the tab swaps places once it passes a neighbour's middle. The listeners are on
  // the window because reordering moves this element in the DOM, which would drop a pointer capture. Measured in viewport
  // pixels; the strip doesn't zoom with the page, so its own lengths (the transform) differ from those by `scale`.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('.tab-close')) return
    select(tab.id)
    const el = e.currentTarget
    const strip = list.current!
    const scale = el.getBoundingClientRect().width / el.offsetWidth
    const grabX = e.clientX - el.getBoundingClientRect().left
    let pointerX = e.clientX
    let dragging = false
    let frame = 0

    const place = () => {
      el.style.transform = ''
      const home = el.getBoundingClientRect()
      const box = strip.getBoundingClientRect()
      const left = Math.max(box.left, Math.min(pointerX - grabX, box.right - home.width))
      el.style.transform = `translateX(${(left - home.left) / scale}px)`
      return { left, right: left + home.width }
    }
    const middle = (sibling: Element) => {
      const r = sibling.getBoundingClientRect()
      return r.left + r.width / 2
    }
    const reorder = () => {
      for (;;) {
        const { left, right } = place()
        const next = el.nextElementSibling
        const prev = el.previousElementSibling
        const step = next && right > middle(next) ? 1 : prev && left < middle(prev) ? -1 : 0
        if (!step) return
        const at = stateRef.current.tabs.findIndex((t) => t.id === tab.id)
        flushSync(() => move(tab.id, at + step))
      }
    }
    // Held near an end of an overflowing strip, the tabs scroll under it, the nearer the end the faster.
    const autoScroll = () => {
      const box = strip.getBoundingClientRect()
      const into = pointerX < box.left + AUTO_SCROLL_EDGE ? pointerX - box.left - AUTO_SCROLL_EDGE : pointerX > box.right - AUTO_SCROLL_EDGE ? pointerX - box.right + AUTO_SCROLL_EDGE : 0
      if (into) {
        const before = strip.scrollLeft
        strip.scrollLeft += Math.max(-AUTO_SCROLL_MAX, Math.min(into / 2, AUTO_SCROLL_MAX))
        if (strip.scrollLeft !== before) reorder()
      }
      frame = requestAnimationFrame(autoScroll)
    }
    const onMove = (ev: PointerEvent) => {
      pointerX = ev.clientX
      if (!dragging && Math.abs(pointerX - e.clientX) < DRAG_THRESHOLD) return
      if (!dragging) {
        dragging = true
        el.classList.add('is-dragging')
        frame = requestAnimationFrame(autoScroll)
      }
      reorder()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      cancelAnimationFrame(frame)
      el.classList.remove('is-dragging')
      el.style.transform = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      className={`tab-item${active ? ' is-active' : ''}`}
      role="presentation"
      title={title}
      onPointerDown={onPointerDown}
      onAuxClick={(e) => {
        if (e.button === 1) close(tab.id)
      }}
    >
      <button
        type="button"
        role="tab"
        id={tabButtonId(tab.id)}
        className="tab-main"
        aria-selected={active}
        aria-controls={live ? tabPanelId(tab.id) : undefined}
        tabIndex={active ? 0 : -1}
        onClick={() => select(tab.id)}
      >
        <Icon className="tab-icon" size={16} />
        <span className="tab-title">{title}</span>
      </button>
      <button type="button" className="tab-close" tabIndex={-1} aria-label={`Close ${title}`} onClick={() => close(tab.id)}>
        <XIcon size={12} />
      </button>
    </div>
  )
}
