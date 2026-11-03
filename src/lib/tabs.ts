// The desktop app's tabs as plain data: every change is a pure function of the state, and React, routers and the
// DOM stay in TabsProvider. A tab's url is an in-app path (pathname + search + hash), never a full URL.

import { safeNextPath } from './links'

export interface Tab {
  id: string
  url: string
  /** What the page calls itself, or a title from the link that opened it. Null until then: see tabTitle. */
  title: string | null
  /** The tab it was opened from, so a run of background tabs lines up next to it in order. */
  opener?: string
}

export interface ClosedTab {
  id: string
  url: string
  title: string | null
  index: number
}

export interface TabsState {
  tabs: Tab[]
  activeId: string
  /** Most recently closed first. */
  closed: ClosedTab[]
  /** Mounted tabs, most recently used first. A tab that isn't here mounts from its URL when it's next shown. */
  live: string[]
  /** Split view: the tabs on screen, left then right. activeId is whichever pane has focus. */
  split: [string, string] | null
  /** The left pane's share of the width. */
  splitRatio: number
}

export const DASHBOARD = '/'
/** Hidden tabs beyond this many live ones unload, least recently used first. */
export const MAX_LIVE_TABS = 8
export const MAX_CLOSED_TABS = 20
export const MAX_HISTORY = 50
const MIN_SPLIT_RATIO = 0.25
const DEFAULT_SPLIT_RATIO = 0.5
const MAX_TITLE = 200

/** A restored or requested tab URL as a path on this origin. Sign-in lives outside the tabs, so it's never a tab's page. */
export function safeTabPath(path: string | null | undefined): string {
  const safe = safeNextPath(path)
  return isLoginPath(safe) ? DASHBOARD : safe
}

export function isLoginPath(path: string) {
  return /^\/login(?:[/?#]|$)/.test(path)
}

export function initialTabs(id: string, url = DASHBOARD): TabsState {
  return { tabs: [{ id, url: safeTabPath(url), title: null }], activeId: id, closed: [], live: [id], split: null, splitRatio: DEFAULT_SPLIT_RATIO }
}

const touch = (live: string[], id: string) => [id, ...live.filter((x) => x !== id)]

/** The tabs on screen. */
export function visibleTabs(state: Pick<TabsState, 'activeId' | 'split'>): string[] {
  return state.split ?? [state.activeId]
}

/** In split view, a tab already on screen only takes focus; any other replaces the pane that has focus. */
export function selectTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id)) return state
  if (state.activeId === id && state.live[0] === id) return state
  const split = state.split && !state.split.includes(id) ? (state.split.map((x) => (x === state.activeId ? id : x)) as [string, string]) : state.split
  return { ...state, activeId: id, live: touch(state.live, id), split }
}

/** Shows a tab beside another, focused. It's on the right unless asked otherwise, or kept on the side it's already on. */
export function showSplit(state: TabsState, id: string, other: string, side: 'left' | 'right' = 'right'): TabsState {
  if (id === other || ![id, other].every((x) => state.tabs.some((t) => t.id === x))) return state
  const split: [string, string] = side === 'left' ? [id, other] : [other, id]
  return { ...state, activeId: id, split, live: touch(touch(state.live, other), id) }
}

/** The tab to keep beside `id`: what's in the other pane, or else the last one used. */
function splitPartner(state: TabsState, id: string): string | undefined {
  return state.split?.find((x) => x !== id) ?? (state.activeId !== id ? state.activeId : (state.live.find((x) => x !== id) ?? state.tabs.find((t) => t.id !== id)?.id))
}

/** Puts a tab that's already open beside another. A window with only that tab has nothing to split with. */
export function splitTab(state: TabsState, id: string, side: 'left' | 'right' = 'right'): TabsState {
  const other = splitPartner(state, id)
  return other ? showSplit(state, id, other, side) : state
}

/** Opens a link in the other pane, in a new tab, leaving the pane with focus where it is. */
export function openTabToSide(state: TabsState, options: Omit<OpenTabOptions, 'background'>): TabsState {
  const focused = state.activeId
  const side = state.split?.[0] === focused || !state.split ? 'right' : 'left'
  return showSplit(openTabNext(state, { ...options, background: true }), options.id, focused, side)
}

/** Cmd+\\: closes split view, or opens it with the last used tab, or a new dashboard if this is the only one. */
export function toggleSplit(state: TabsState, freshId: string): TabsState {
  if (state.split) return { ...state, split: null }
  const other = splitPartner(state, state.activeId)
  return other ? showSplit(state, other, state.activeId) : openTabToSide(state, { id: freshId, url: DASHBOARD })
}

export function focusOtherPane(state: TabsState): TabsState {
  const other = state.split?.find((x) => x !== state.activeId)
  return other ? selectTab(state, other) : state
}

export function setSplitRatio(state: TabsState, ratio: number): TabsState {
  return { ...state, splitRatio: clampSplitRatio(ratio) }
}

export function clampSplitRatio(ratio: number) {
  return Number.isFinite(ratio) ? Math.max(MIN_SPLIT_RATIO, Math.min(1 - MIN_SPLIT_RATIO, ratio)) : DEFAULT_SPLIT_RATIO
}

/** Cmd+1…8 pick that tab; Cmd+9 is the last one, however many there are. */
export function selectTabNumber(state: TabsState, n: number): TabsState {
  const tab = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1]
  return tab ? selectTab(state, tab.id) : state
}

export function cycleTab(state: TabsState, delta: number): TabsState {
  const count = state.tabs.length
  const at = state.tabs.findIndex((t) => t.id === state.activeId)
  return selectTab(state, state.tabs[(at + delta + count) % count].id)
}

export interface OpenTabOptions {
  id: string
  url: string
  title?: string | null
  background?: boolean
}

/** Opens a link next to the current tab, after any tabs already opened from it, as browsers do. */
export function openTabNext(state: TabsState, { id, url, title = null, background = false }: OpenTabOptions): TabsState {
  let at = state.tabs.findIndex((t) => t.id === state.activeId) + 1
  while (state.tabs[at]?.opener === state.activeId) at++
  const tabs = [...state.tabs.slice(0, at), { id, url: safeTabPath(url), title, opener: state.activeId }, ...state.tabs.slice(at)]
  const next = { ...state, tabs }
  return background ? next : selectTab(next, id)
}

/** Cmd+T and the + button: a new tab at the end of the strip. */
export function openNewTab(state: TabsState, id: string, url = DASHBOARD): TabsState {
  return selectTab({ ...state, tabs: [...state.tabs, { id, url: safeTabPath(url), title: null }] }, id)
}

/**
 * Closing moves to the tab on the right, or else the left. The last tab leaves a fresh dashboard, never an empty window.
 * Closing one of two panes leaves the other filling the window.
 */
export function closeTab(state: TabsState, id: string, freshId: string): TabsState {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index < 0) return state
  const tab = state.tabs[index]
  // Closing a lone untouched dashboard changes nothing the user could want back.
  const lone = state.tabs.length === 1
  const closed = lone && tab.url === DASHBOARD ? state.closed : [{ id, url: tab.url, title: tab.title, index }, ...state.closed].slice(0, MAX_CLOSED_TABS)
  if (lone) return { ...initialTabs(freshId), closed, splitRatio: state.splitRatio }
  const tabs = state.tabs.filter((t) => t.id !== id)
  const live = state.live.filter((x) => x !== id)
  const remaining = state.split?.includes(id) ? state.split.find((x) => x !== id)! : null
  const split = remaining ? null : state.split
  if (state.activeId !== id) return { ...state, tabs, closed, live, split }
  return selectTab({ ...state, tabs, closed, live, split, activeId: remaining ?? state.activeId }, remaining ?? tabs[Math.min(index, tabs.length - 1)].id)
}

/** Brings back the last closed tab, where it was. */
export function reopenClosedTab(state: TabsState): TabsState {
  const [last, ...closed] = state.closed
  if (!last) return state
  const at = Math.min(last.index, state.tabs.length)
  const tabs = [...state.tabs.slice(0, at), { id: last.id, url: last.url, title: last.title }, ...state.tabs.slice(at)]
  return selectTab({ ...state, tabs, closed }, last.id)
}

export function moveTab(state: TabsState, id: string, toIndex: number): TabsState {
  const from = state.tabs.findIndex((t) => t.id === id)
  const to = Math.max(0, Math.min(toIndex, state.tabs.length - 1))
  if (from < 0 || from === to) return state
  const tabs = [...state.tabs]
  // A moved tab is the user's choice of place, so later links no longer line up after it.
  const [tab] = tabs.splice(from, 1)
  tabs.splice(to, 0, { id: tab.id, url: tab.url, title: tab.title })
  return { ...state, tabs }
}

const mapTab = (state: TabsState, id: string, change: (tab: Tab) => Tab): TabsState => {
  const at = state.tabs.findIndex((t) => t.id === id)
  if (at < 0) return state
  const tab = change(state.tabs[at])
  if (tab === state.tabs[at]) return state
  const tabs = [...state.tabs]
  tabs[at] = tab
  return { ...state, tabs }
}

const pathnameOf = (url: string) => url.replace(/[?#].*$/, '')

/** A tab navigated. The title belonged to the old page, unless only the query or hash changed. */
export function setTabUrl(state: TabsState, id: string, location: string): TabsState {
  const url = safeTabPath(location)
  return mapTab(state, id, (tab) => (tab.url === url ? tab : { ...tab, url, title: pathnameOf(tab.url) === pathnameOf(url) ? tab.title : null }))
}

export function setTabTitle(state: TabsState, id: string, title: string): TabsState {
  const clipped = title.slice(0, MAX_TITLE)
  return mapTab(state, id, (tab) => (tab.title === clipped ? tab : { ...tab, title: clipped }))
}

export function unloadTabs(state: TabsState, ids: string[]): TabsState {
  const visible = visibleTabs(state)
  return { ...state, live: state.live.filter((x) => !ids.includes(x) || visible.includes(x)) }
}

/**
 * Which tabs to unload to get back to `max` live ones: the least recently used hidden tabs. `keep` says a tab must
 * stay (an unsent draft, something the user started), so the live count can stay above `max` until it no longer has to.
 */
export function tabsToUnload(live: string[], activeId: string, keep: (id: string) => boolean, max = MAX_LIVE_TABS): string[] {
  let excess = live.length - max
  const out: string[] = []
  for (let i = live.length - 1; i >= 0 && excess > 0; i--) {
    if (live[i] === activeId || keep(live[i])) continue
    out.push(live[i])
    excess--
  }
  return out
}

// ---------------------------------------------------------------------------
// One tab's back/forward entries, kept outside its router so unloading a tab doesn't lose them.

export interface HistoryEntry {
  path: string
  key: string
}

export interface TabHistory {
  entries: HistoryEntry[]
  index: number
}

export function recordNavigation(history: TabHistory, action: 'POP' | 'PUSH' | 'REPLACE', entry: HistoryEntry): TabHistory {
  if (action === 'POP') {
    const index = history.entries.findIndex((e) => e.key === entry.key)
    if (index >= 0) return { ...history, index }
  }
  if (action === 'PUSH') {
    const entries = [...history.entries.slice(0, history.index + 1), entry].slice(-MAX_HISTORY)
    return { entries, index: entries.length - 1 }
  }
  const entries = [...history.entries]
  entries[history.index] = entry
  return { entries, index: history.index }
}

// ---------------------------------------------------------------------------
// Saved state. Everything from storage is untrusted: anything but a valid tab drops out, and a state with none starts over.

export function serializeTabs(state: TabsState) {
  return {
    tabs: state.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
    activeId: state.activeId,
    closed: state.closed,
    split: state.split,
    splitRatio: state.splitRatio,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const validId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,64}$/.test(v)
const validTitle = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, MAX_TITLE) : null)
// A saved URL in the form validation gives it, or null if validation had to replace it: that didn't come from here.
// Validation can also just tidy a URL (a ' in a query becomes %27), which leaves the same page.
const savedUrl = (v: unknown) => {
  if (typeof v !== 'string') return null
  const safe = safeTabPath(v)
  return safe !== DASHBOARD || v === DASHBOARD ? safe : null
}

export function parseSavedTabs(saved: unknown, freshId: string): TabsState {
  if (!isRecord(saved) || !Array.isArray(saved.tabs)) return initialTabs(freshId)
  const tabs: Tab[] = []
  const seen = new Set<string>()
  for (const t of saved.tabs as unknown[]) {
    const url = isRecord(t) ? savedUrl(t.url) : null
    if (!isRecord(t) || !validId(t.id) || seen.has(t.id) || !url) continue
    seen.add(t.id)
    tabs.push({ id: t.id, url, title: validTitle(t.title) })
  }
  if (!tabs.length) return initialTabs(freshId)
  const closed: ClosedTab[] = []
  for (const c of Array.isArray(saved.closed) ? (saved.closed as unknown[]) : []) {
    const url = isRecord(c) ? savedUrl(c.url) : null
    if (!isRecord(c) || !validId(c.id) || seen.has(c.id) || !url) continue
    seen.add(c.id)
    closed.push({ id: c.id, url, title: validTitle(c.title), index: Number.isInteger(c.index) && (c.index as number) >= 0 ? (c.index as number) : 0 })
  }
  const activeId = tabs.some((t) => t.id === saved.activeId) ? (saved.activeId as string) : tabs[0].id
  const pair = saved.split
  const split =
    Array.isArray(pair) && pair.length === 2 && pair[0] !== pair[1] && pair.includes(activeId) && pair.every((x) => tabs.some((t) => t.id === x))
      ? (pair as [string, string])
      : null
  // Only what's on screen mounts at startup; the others mount from their URLs when they're first shown.
  return { tabs, activeId, closed: closed.slice(0, MAX_CLOSED_TABS), live: split ?? [activeId], split, splitRatio: clampSplitRatio(saved.splitRatio as number) }
}

// ---------------------------------------------------------------------------
// Titles and icons from the URL, until (or unless) the page names itself.

export type TabIcon = 'home' | 'pull' | 'issue' | 'run' | 'repo' | 'code' | 'discussion' | 'inbox' | 'search' | 'settings' | 'local' | 'person'

const TOP_LEVEL: Record<string, { title: string; icon: TabIcon }> = {
  pulls: { title: 'Pull requests', icon: 'pull' },
  issues: { title: 'Issues', icon: 'issue' },
  notifications: { title: 'Notifications', icon: 'inbox' },
  search: { title: 'Search', icon: 'search' },
  settings: { title: 'Settings', icon: 'settings' },
  local: { title: 'Local repositories', icon: 'local' },
}

const REPO_SECTIONS: Record<string, string> = {
  issues: 'Issues',
  pulls: 'Pull requests',
  actions: 'Actions',
  commits: 'Commits',
  branches: 'Branches',
  tags: 'Tags',
  releases: 'Releases',
  discussions: 'Discussions',
  projects: 'Projects',
  security: 'Security',
  pulse: 'Insights',
  graphs: 'Insights',
  wiki: 'Wiki',
  settings: 'Settings',
  compare: 'Compare',
}

const pathParts = (url: string) =>
  pathnameOf(url)
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })

export function titleFromPath(url: string): string {
  const [owner, repo, section, id, ...rest] = pathParts(url)
  if (!owner) return 'Dashboard'
  const top = TOP_LEVEL[owner]
  if (top) {
    const q = owner === 'search' ? new URLSearchParams(url.split('?')[1]?.split('#')[0] ?? '').get('q') : null
    return q ? `Search: ${q}` : top.title
  }
  if (!repo) return owner
  if (!section) return `${owner}/${repo}`
  if ((section === 'pull' || section === 'issues' || section === 'discussions') && /^\d+$/.test(id ?? '')) return `#${id}`
  if (section === 'actions' && id === 'runs' && rest[0]) return `Run ${rest[0]}`
  if (section === 'commit' && id) return id.slice(0, 7)
  if (section === 'blob' || section === 'blame' || section === 'tree') return rest[rest.length - 1] ?? repo
  if (section === 'releases' && id === 'tag' && rest.length) return rest.join('/')
  return `${REPO_SECTIONS[section] ?? section} · ${repo}`
}

export function iconFromPath(url: string): TabIcon {
  const [owner, repo, section] = pathParts(url)
  if (!owner) return 'home'
  if (TOP_LEVEL[owner]) return TOP_LEVEL[owner].icon
  if (!repo) return 'person'
  if (section === 'pull' || section === 'pulls' || section === 'compare') return 'pull'
  if (section === 'issues') return 'issue'
  if (section === 'actions') return 'run'
  if (section === 'discussions') return 'discussion'
  if (section === 'settings') return 'settings'
  return !section ? 'repo' : section === 'blob' || section === 'tree' || section === 'blame' || section === 'commit' || section === 'commits' ? 'code' : 'repo'
}

export function tabTitle(tab: Pick<Tab, 'url' | 'title'>) {
  return tab.title ?? titleFromPath(tab.url)
}

/** A pull request or issue link's text makes a real title before its tab has ever been shown. */
export function titleFromLink(url: string, text: string): string | null {
  const [, , section, id] = pathParts(url)
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean || (section !== 'pull' && section !== 'issues') || !/^\d+$/.test(id ?? '')) return null
  // Links that are only the number ("#128"), or a whole sentence that happens to link, say nothing useful.
  if (/^#?\d+$/.test(clean) || clean.includes('#')) return null
  return `#${id} ${clean}`
}
