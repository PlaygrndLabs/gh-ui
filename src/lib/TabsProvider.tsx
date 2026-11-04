import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createMemoryRouter, createPath, parsePath, useLocation, type RouteObject, type To } from 'react-router-dom'
import { useConfirm } from '@primer/react'
import { QueryObserver, useQueryClient } from '@tanstack/react-query'
import { useAuth } from './auth'
import { writesInFlight } from './github'
import { readPref, writePref } from './storage'
import {
  closeTab,
  cycleTab,
  dedupeRepoTabs,
  findRepoTab,
  isLoginPath,
  moveTab,
  navigationTarget,
  openNewTab,
  openTabNext,
  parseSavedTabs,
  recordNavigation,
  reopenClosedTab,
  repoKeyFromUrl,
  safeTabPath,
  selectTab,
  selectTabNumber,
  serializeTabs,
  setTabTitle,
  setTabUrl,
  tabsToUnload,
  tabTitle,
  unloadTabs,
  type HistoryEntry,
  type Tab,
  type TabHistory,
  type TabsState,
} from './tabs'

export type TabRouter = ReturnType<typeof createMemoryRouter>

interface TabsApi {
  state: TabsState
  active: Tab
  select(id: string): void
  /** The tab on screen right now, for handlers that can run between renders. */
  activeTabId(): string
  selectNumber(n: number): void
  cycle(delta: number): void
  newTab(): void
  /** Opens a validated in-app path next to the current tab. */
  open(url: string, options?: { background?: boolean; title?: string | null }): void
  /** Asks first if the tab holds text that hasn't been sent. */
  close(id: string): void
  /** Whether a tab (or any tab) holds text that hasn't been sent. */
  hasUnsentText(id?: string): boolean
  reopen(): void
  move(id: string, toIndex: number): void
  /** The active tab's router: Back, Forward, the Go menu and the shared agent panel all act on it. */
  activeRouter(): TabRouter
  routerFor(tab: Tab): TabRouter
  setTitle(id: string, title: string): void
  pinQueries(id: string): void
  unpinQueries(id: string): void
}

const TabsContext = createContext<TabsApi | null>(null)
const CurrentTabContext = createContext<string | null>(null)

export const CurrentTabProvider = CurrentTabContext.Provider
export const tabPanelId = (id: string) => `tab-panel-${id}`
export const tabButtonId = (id: string) => `tab-${id}`
const prefKey = (accountId: string) => `tabs:${accountId}`
const newId = () => crypto.randomUUID()

export function forgetSavedTabs(accountId: string) {
  try {
    localStorage.removeItem(`gh-ui:${prefKey(accountId)}`)
  } catch {
    // storage blocked; nothing was saved then either
  }
}

/** The absolute path a navigation goes to, or null for a relative one, which stays in the tab it started from. */
function absolutePath(to: unknown): string | null {
  if (typeof to === 'string') return to.startsWith('/') ? to : null
  if (typeof to !== 'object' || to === null) return null
  const path = to as Exclude<To, string>
  return path.pathname?.startsWith('/') ? createPath(path) : null
}

const historyEntry = (location: { pathname: string; search: string; hash: string; key: string }): HistoryEntry => ({
  path: location.pathname + location.search + location.hash,
  key: location.key,
})

type TextField = HTMLTextAreaElement | HTMLInputElement

/**
 * A hidden tab must not lose what the user left in it. Effects can't report this, because <Activity> has already
 * cleaned them up, but the DOM stays: any text waiting to be sent, or a marker for text with no field on screen.
 */
function paneHasUnsentText(id: string) {
  const pane = document.getElementById(tabPanelId(id))
  if (!pane) return false
  if (pane.querySelector('span[data-tab-draft]')) return true
  return [...pane.querySelectorAll<TextField>('textarea, input[data-tab-draft]')].some((field) => field.value.trim())
}

export function TabsProvider({
  accountId,
  routes,
  onLogin,
  pendingPath,
  onPendingPathUsed,
  children,
}: {
  accountId: string
  routes: RouteObject[]
  /** Sign-in lives outside the tabs, so a navigation to /login opens it over them and leaves the tab where it is. */
  onLogin(path: string): void
  /** Somewhere the sign-in flow was asked to come back to. */
  pendingPath: string | null
  onPendingPathUsed(): void
  children: ReactNode
}) {
  const client = useQueryClient()
  const confirm = useConfirm()
  const [state, setState] = useState<TabsState>(() => dedupeRepoTabs(parseSavedTabs(readPref<unknown>(prefKey(accountId), null), newId())))
  const routers = useRef(new Map<string, TabRouter>())
  const histories = useRef(new Map<string, TabHistory>())
  const pins = useRef(new Map<string, Array<() => void>>())
  const pinObservers = useRef(new WeakSet<object>())
  const onLoginRef = useRef(onLogin)
  onLoginRef.current = onLogin
  const stateRef = useRef(state)
  stateRef.current = state
  const dialogFields = useRef(new Map<string, Set<TextField>>())
  // Set below: a tab's router needs these, and they need the routers.
  const elsewhere = useRef<{ show(id: string, url: string): void; open(url: string): void }>(null)

  // Primer takes a hidden tab's portals out of the document, with their text still in them. So a field that's gone only
  // means its dialog closed while the tab is on screen, and here in render is the last look before a switch hides it.
  const lastActive = useRef(state.activeId)
  if (lastActive.current !== state.activeId) {
    const fields = dialogFields.current.get(lastActive.current)
    if (fields) for (const field of fields) if (!field.isConnected) fields.delete(field)
    lastActive.current = state.activeId
  }

  const hasUnsentText = useCallback((id?: string) => {
    const holds = (tabId: string) =>
      paneHasUnsentText(tabId) || [...(dialogFields.current.get(tabId) ?? [])].some((f) => (f.isConnected || tabId !== stateRef.current.activeId) && f.value.trim())
    return id ? holds(id) : stateRef.current.live.some(holds)
  }, [])

  const routerFor = useCallback(
    (tab: Tab) => {
      const existing = routers.current.get(tab.id)
      if (existing) return existing
      const history = histories.current.get(tab.id)
      const router = createMemoryRouter(routes, history
        ? { initialEntries: history.entries.map((e) => ({ ...parsePath(e.path), key: e.key })), initialIndex: history.index }
        : { initialEntries: [tab.url] })
      const navigate = router.navigate
      router.navigate = ((to: never, options: never) => {
        if (typeof to === 'string' && isLoginPath(to)) {
          onLoginRef.current(to)
          return Promise.resolve()
        }
        // A replace tidies the current page's URL, and going through history stays in the tab whatever it holds.
        const path = absolutePath(to)
        if (path && !(options as { replace?: boolean } | undefined)?.replace) {
          const target = navigationTarget(stateRef.current, tab.id, safeTabPath(path))
          if (target.kind === 'focus') {
            elsewhere.current!.show(target.id, path)
            return Promise.resolve()
          }
          if (target.kind === 'open') {
            elsewhere.current!.open(path)
            return Promise.resolve()
          }
        }
        return navigate(to, options)
      }) as typeof router.navigate
      if (!history) histories.current.set(tab.id, { entries: [historyEntry(router.state.location)], index: 0 })
      let lastKey = router.state.location.key
      // Kept outside React, so it keeps working while the tab's own effects are cleaned up.
      router.subscribe(({ location, historyAction }) => {
        if (location.key === lastKey) return
        lastKey = location.key
        const entry = historyEntry(location)
        histories.current.set(tab.id, recordNavigation(histories.current.get(tab.id)!, historyAction, entry))
        setState((s) => setTabUrl(s, tab.id, entry.path))
      })
      routers.current.set(tab.id, router)
      return router
    },
    [routes],
  )

  const select = useCallback((id: string) => setState((s) => selectTab(s, id)), [])
  const selectNumber = useCallback((n: number) => setState((s) => selectTabNumber(s, n)), [])
  const cycle = useCallback((delta: number) => setState((s) => cycleTab(s, delta)), [])
  const reopen = useCallback(() => setState(reopenClosedTab), [])
  const move = useCallback((id: string, toIndex: number) => setState((s) => moveTab(s, id, toIndex)), [])
  const setTitle = useCallback((id: string, title: string) => setState((s) => setTabTitle(s, id, title)), [])
  const newTab = useCallback(() => {
    const id = newId()
    setState((s) => openNewTab(s, id))
  }, [])
  const close = useCallback(
    async (tabId: string) => {
      if (hasUnsentText(tabId)) {
        const tab = stateRef.current.tabs.find((t) => t.id === tabId)
        const ok = await confirm({
          title: 'Close this tab?',
          content: `${tab ? tabTitle(tab) : 'This tab'} has text you haven’t sent. Closing the tab discards it.`,
          confirmButtonType: 'danger',
          confirmButtonContent: 'Close tab',
        })
        if (!ok) return
      }
      const fresh = newId()
      setState((s) => closeTab(s, tabId, fresh))
    },
    [confirm, hasUnsentText],
  )
  /** Takes an existing tab to a page. One that isn't mounted goes there when it next mounts. */
  const show = useCallback(
    (id: string, url: string, background = false) => {
      const tab = stateRef.current.tabs.find((t) => t.id === id)
      if (!tab) return
      if (safeTabPath(url) !== tab.url) {
        if (stateRef.current.live.includes(id)) void routerFor(tab).navigate(url)
        else {
          histories.current.delete(id)
          setState((s) => setTabUrl(s, id, url))
        }
      }
      if (!background) setState((s) => selectTab(s, id))
    },
    [routerFor],
  )
  const open = useCallback(
    (url: string, options: { background?: boolean; title?: string | null } = {}) => {
      if (isLoginPath(url)) return onLoginRef.current(url)
      const existing = findRepoTab(stateRef.current, repoKeyFromUrl(url))
      if (existing) return show(existing.id, url, options.background)
      const id = newId()
      setState((s) => openTabNext(s, { id, url, ...options }))
    },
    [show],
  )
  elsewhere.current = { show, open }
  const activeTabId = useCallback(() => stateRef.current.activeId, [])
  const activeRouter = useCallback(() => {
    const s = stateRef.current
    return routerFor(s.tabs.find((t) => t.id === s.activeId)!)
  }, [routerFor])

  /**
   * React Query forgets data 5 minutes after its last observer leaves, and pages show a spinner instead of their
   * children when a query has no data. Left alone, that would unmount a half-written comment when a tab comes back.
   * So a hidden tab holds its queries through disabled observers, which keep them cached but never fetch.
   */
  const unpinQueries = useCallback((id: string) => {
    for (const release of pins.current.get(id) ?? []) release()
    pins.current.delete(id)
  }, [])
  const pinQueries = useCallback(
    (id: string) => {
      unpinQueries(id)
      const observed = client.getQueryCache().getAll().filter((q) => q.observers.some((o) => !pinObservers.current.has(o)))
      pins.current.set(
        id,
        observed.map((query) => {
          const observer = new QueryObserver(client, { ...query.options, queryKey: query.queryKey, enabled: false })
          pinObservers.current.add(observer)
          return observer.subscribe(() => {})
        }),
      )
    },
    [client, unpinQueries],
  )

  // Another account's tabs, or none: whatever they held is free to go.
  useEffect(
    () => () => {
      for (const id of [...pins.current.keys()]) unpinQueries(id)
    },
    [unpinQueries],
  )

  useEffect(() => writePref(prefKey(accountId), serializeTabs(state)), [accountId, state])

  // Fields in dialogs live in portals, outside the tab's pane, and nothing in the DOM says which tab opened them. Only
  // the tab on screen can be typed in, though, so note it as the text is typed.
  useEffect(() => {
    const onInput = (e: Event) => {
      const field = e.target
      if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) || field.type === 'checkbox' || field.type === 'radio') return
      if (field.closest('.tab-pane, .agent-dock')) return
      const { activeId } = stateRef.current
      dialogFields.current.set(activeId, (dialogFields.current.get(activeId) ?? new Set()).add(field))
    }
    document.addEventListener('input', onInput, true)
    return () => document.removeEventListener('input', onInput, true)
  }, [])

  // After more than 8 live tabs the least recently used hidden ones unload. What's in flight belongs to somebody, and
  // nothing can say which tab started it, so nothing unloads until it settles; it looks again shortly.
  useEffect(() => {
    let retry = 0
    const mustStay = (id: string) => hasUnsentText(id) || !!document.getElementById(tabPanelId(id))?.querySelector('[data-loading="true"]')
    const trim = () => {
      const drop = tabsToUnload(state.live, state.activeId, mustStay)
      if (!drop.length) return
      if (client.isMutating() > 0 || writesInFlight() > 0) retry = window.setTimeout(trim, 1000)
      else setState((s) => unloadTabs(s, drop))
    }
    trim()
    return () => window.clearTimeout(retry)
  }, [client, hasUnsentText, state.live, state.activeId])

  // Routers and pins of tabs that closed or unloaded. An unloaded tab's history stays, for when it comes back.
  useEffect(() => {
    for (const [id, router] of routers.current) {
      if (state.live.includes(id)) continue
      router.dispose()
      routers.current.delete(id)
      unpinQueries(id)
    }
    for (const id of histories.current.keys()) {
      if (!state.tabs.some((t) => t.id === id) && !state.closed.some((c) => c.id === id)) histories.current.delete(id)
    }
    for (const id of dialogFields.current.keys()) {
      if (!state.live.includes(id)) dialogFields.current.delete(id)
    }
  }, [state.live, state.tabs, state.closed, unpinQueries])

  useEffect(() => {
    if (pendingPath === null) return
    const current = stateRef.current.tabs.find((t) => t.id === stateRef.current.activeId)!
    if (safeTabPath(pendingPath) !== safeTabPath(current.url).replace(/#.*$/, '')) open(safeTabPath(pendingPath))
    onPendingPathUsed()
  }, [pendingPath, onPendingPathUsed, open])

  const active = state.tabs.find((t) => t.id === state.activeId)!
  const value = useMemo<TabsApi>(
    () => ({ state, active, activeTabId, select, selectNumber, cycle, newTab, open, close, hasUnsentText, reopen, move, activeRouter, routerFor, setTitle, pinQueries, unpinQueries }),
    [state, active, activeTabId, select, selectNumber, cycle, newTab, open, close, hasUnsentText, reopen, move, activeRouter, routerFor, setTitle, pinQueries, unpinQueries],
  )
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}

export function useTabs() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs must be used inside <TabsProvider>')
  return ctx
}

export const useCurrentTabId = () => useContext(CurrentTabContext)

/** Each account has its own tabs, so switching unmounts this one's: ask first if that would throw away unsent text. */
export function useSwitchAccount() {
  const { switchTo } = useAuth()
  const tabs = useContext(TabsContext)
  const confirm = useConfirm()
  return async (id: string) => {
    if (tabs?.hasUnsentText()) {
      const ok = await confirm({
        title: 'Switch account?',
        content: 'Your open tabs have text you haven’t sent. Switching account discards it.',
        confirmButtonType: 'danger',
        confirmButtonContent: 'Switch account',
      })
      if (!ok) return
    }
    switchTo(id)
  }
}

/** Holds a tab's queries for as long as it's hidden. Layout effects clean up before the page's query observers do. */
export function useTabQueryPins(id: string) {
  const { pinQueries, unpinQueries } = useTabs()
  useLayoutEffect(() => {
    unpinQueries(id)
    return () => pinQueries(id)
  }, [id, pinQueries, unpinQueries])
}

/** Names the tab a page is in. Does nothing in the web build, which has no tabs. */
export function useTabTitle(title: string | undefined) {
  const tabs = useContext(TabsContext)
  const id = useContext(CurrentTabContext)
  const { pathname } = useLocation()
  const setTitle = tabs?.setTitle
  useEffect(() => {
    if (setTitle && id && title) setTitle(id, title)
  }, [setTitle, id, title, pathname])
}
