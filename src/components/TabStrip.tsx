import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
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
  PinIcon,
  PlayIcon,
  RepoIcon,
  SearchIcon,
  XIcon,
  type Icon,
} from '@primer/octicons-react'
import { RepoPicker } from './RepoPicker'
import { UpdateNotice } from './UpdateNotice'
import { tabButtonId, tabPanelId, useTabs } from '../lib/TabsProvider'
import { native, type ContextMenuItem } from '../lib/platform'
import { iconFromPath, repoKeyFromUrl, tabTitle, type Tab, type TabIcon } from '../lib/tabs'

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
// Dragged this far below the strip, a tab is on its way to a pane rather than a new place in the row.
const DROP_DISTANCE = 16

type Side = 'left' | 'right'

/** The row of tabs at the very top of the window, sharing it with the macOS window buttons. */
export function TabStrip() {
  const { state, active, select, close, split, toggleSplit, pin } = useTabs()
  const list = useRef<HTMLDivElement>(null)
  const [dropSide, setDropSide] = useState<Side | null>(null)

  // The system's own menu, which closes the way every other menu on the Mac does.
  const showMenu = async (tab: Tab) => {
    if (!native) return
    const items: ContextMenuItem[] = [
      { id: 'pin', label: tab.pinned ? 'Unpin tab' : 'Pin tab' },
      ...(state.tabs.length > 1 && !state.split?.includes(tab.id) ? [{ id: 'side', label: 'Open to the side' }] : []),
      ...(state.split ? [{ id: 'unsplit', label: 'Close split view' }] : []),
      { type: 'separator' },
      { id: 'close', label: 'Close tab' },
    ]
    const picked = await native.contextMenu(items)
    if (picked === 'pin') pin(tab.id, !tab.pinned)
    else if (picked === 'side') split(tab.id)
    else if (picked === 'unsplit') toggleSplit()
    else if (picked === 'close') close(tab.id)
  }

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
    else if (e.key === 'Delete') close(active.id, { keepPinned: true })
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
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === active.id}
            inSplit={!!state.split?.includes(tab.id)}
            live={state.live.includes(tab.id)}
            list={list}
            onDropSide={setDropSide}
            onMenu={() => void showMenu(tab)}
          />
        ))}
      </div>
      <RepoPicker />
      <div className="tab-strip-end">
        <UpdateNotice />
      </div>
      {/* In the body: the strip keeps one size at any zoom, which would throw this out of place. */}
      {dropSide && createPortal(<div className={`split-drop is-${dropSide}`} aria-hidden="true" />, document.body)}
    </div>
  )
}

function TabItem({
  tab,
  active,
  inSplit,
  live,
  list,
  onDropSide,
  onMenu,
}: {
  tab: Tab
  active: boolean
  inSplit: boolean
  live: boolean
  list: React.RefObject<HTMLDivElement | null>
  onDropSide(side: Side | null): void
  onMenu(): void
}) {
  const { state, select, close, move, split } = useTabs()
  const title = tabTitle(tab)
  const Icon = repoKeyFromUrl(tab.url) ? RepoIcon : ICONS[iconFromPath(tab.url)]
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
    let dropSide: Side | null = null

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
      // Below the strip, the tab can go into a pane: whichever half of the window it's over.
      const below = stateRef.current.tabs.length > 1 && ev.clientY > strip.getBoundingClientRect().bottom + DROP_DISTANCE
      const side = !below ? null : ev.clientX < window.innerWidth / 2 ? 'left' : 'right'
      if (side !== dropSide) {
        dropSide = side
        onDropSide(side)
      }
      if (!dragging && Math.abs(pointerX - e.clientX) < DRAG_THRESHOLD && !below) return
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
      if (dropSide) {
        onDropSide(null)
        split(tab.id, dropSide)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      className={`tab-item${active ? ' is-active' : ''}${inSplit ? ' in-split' : ''}${tab.pinned ? ' is-pinned' : ''}`}
      role="presentation"
      title={title}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
      }}
      onAuxClick={(e) => {
        if (e.button === 1) close(tab.id, { keepPinned: true })
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
      {tab.pinned ? (
        <PinIcon className="tab-pin" size={12} aria-label="Pinned" />
      ) : (
        <button type="button" className="tab-close" tabIndex={-1} aria-label={`Close ${title}`} onClick={() => close(tab.id)}>
          <XIcon size={12} />
        </button>
      )}
    </div>
  )
}
