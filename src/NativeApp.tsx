import { flushSync } from 'react-dom'
import { Activity, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPath, createRoutesFromElements, MemoryRouter, parsePath, Route, Router, RouterProvider, Routes, useLocation, type Navigator } from 'react-router-dom'
import { AppShell, ErrorBoundary, pageRoutes } from './App'
import { AgentPanel } from './components/AgentPanel'
import { AppLoading } from './components/Bits'
import { TabStrip } from './components/TabStrip'
import { LoginPage } from './pages/Login'
import { AgentProvider, useAgent } from './lib/agent/AgentProvider'
import { useAuth } from './lib/auth'
import { linkTarget } from './lib/links'
import { native, openExternal } from './lib/platform'
import { confirmDialogOpen, contentElementById } from './lib/scroll'
import { CurrentTabProvider, CurrentTabViewProvider, forgetSavedTabs, tabButtonId, tabPanelId, TabsProvider, useCurrentTabId, useTabActions, useTabQueryPins, useTabs, type CurrentTabView } from './lib/TabsProvider'
import { forgetRepoSnapshots } from './lib/repo'
import { clampSplitRatio, repoKeyFromUrl, safeTabPath, titleFromLink, visibleTabs, type Tab } from './lib/tabs'

const decodeId = (id: string) => {
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

const TabShownContext = createContext(true)

function TabQueryPins() {
  useTabQueryPins(useCurrentTabId()!)
  return null
}

/**
 * The root of every tab's routes, and where a hidden tab is hidden: below its RouterProvider, which listens to the router
 * from a layout effect. Above it, <Activity> would cut that off, and a navigation finishing in a hidden tab (a new issue
 * going to its page) would never reach the page, which would keep showing the form it just submitted.
 */
function TabContent({ children }: { children: ReactNode }) {
  return (
    <Activity mode={useContext(TabShownContext) ? 'visible' : 'hidden'}>
      <TabQueryPins />
      {children}
    </Activity>
  )
}

const TabPane = memo(function TabPane({ tab, shown, side, focused }: { tab: Tab; shown: boolean; side: 'left' | 'right' | null; focused: boolean }) {
  const { routerFor, select } = useTabActions()
  const view = useMemo<CurrentTabView>(() => ({ focused, branch: tab.branch ?? null, pickedBranch: tab.pickedBranch ?? null }), [focused, tab.branch, tab.pickedBranch])
  const takeFocus = () => {
    if (side && !focused) select(tab.id)
  }
  const className = `tab-pane${side ? ` in-split is-${side}` : ''}${shown && focused ? ' is-focused' : ''}`
  return (
    <CurrentTabProvider value={tab.id}>
      <CurrentTabViewProvider value={view}>
        <TabShownContext.Provider value={shown}>
          <div className={className} id={tabPanelId(tab.id)} role="tabpanel" aria-labelledby={tabButtonId(tab.id)} onPointerDownCapture={takeFocus} onFocusCapture={takeFocus}>
            <RouterProvider router={routerFor(tab)} />
          </div>
        </TabShownContext.Provider>
      </CurrentTabViewProvider>
    </CurrentTabProvider>
  )
})

const splitColumns = (ratio: number) => `minmax(0, ${ratio}fr) 1px minmax(0, ${1 - ratio}fr) auto`

/** Between the panes: drag or use the arrow keys to resize, double-click to even them up. */
function SplitDivider() {
  const { state, setSplitRatio } = useTabs()
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const shell = e.currentTarget.parentElement!
    const left = shell.querySelector('.tab-pane.is-left')!.getBoundingClientRect()
    const right = shell.querySelector('.tab-pane.is-right')!.getBoundingClientRect()
    let ratio = state.splitRatio
    shell.classList.add('is-resizing')
    const onMove = (ev: PointerEvent) => {
      ratio = clampSplitRatio((ev.clientX - left.left) / (right.right - left.left))
      shell.style.gridTemplateColumns = splitColumns(ratio)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      shell.classList.remove('is-resizing')
      setSplitRatio(ratio)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setSplitRatio(state.splitRatio + (e.key === 'ArrowLeft' ? -0.02 : 0.02))
  }
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuenow={Math.round(state.splitRatio * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setSplitRatio(0.5)}
    />
  )
}

/**
 * One panel, outside every tab, so its scroll position and unsent text don't depend on which tab is showing. Its links
 * get router context from the active tab: they read that tab's location and navigate that tab.
 */
function AgentDock() {
  const { open, setChat } = useAgent()
  const { active, activeRouter } = useTabs()
  // Before paint and before the page's own effects run, so a question asked from a page lands in its repository's chat.
  const chat = repoKeyFromUrl(active.url)
  useLayoutEffect(() => setChat(chat), [chat, setChat])
  const navigator = useMemo<Navigator>(
    () => ({
      createHref: (to) => (typeof to === 'string' ? to : createPath(to)),
      go: (delta) => void activeRouter().navigate(delta),
      push: (to, state) => void activeRouter().navigate(to, { state }),
      replace: (to, state) => void activeRouter().navigate(to, { state, replace: true }),
    }),
    [activeRouter],
  )
  if (!open) return null
  return (
    <div className="agent-dock">
      <Router location={parsePath(active.url)} navigator={navigator}>
        <ErrorBoundary resetKey={active.url} title="The agent panel hit an error">
          <AgentPanel />
        </ErrorBoundary>
      </Router>
    </div>
  )
}

/** Tab shortcuts live in the app menu (electron/main.cjs); so do the Go menu's and Back and Forward, which act on the active tab. */
function useTabMenu() {
  const { toggle } = useAgent()
  const { activeRouter, activeTabId, newTab, close, reopen, cycle, selectNumber, open, toggleSplit, focusOtherPane } = useTabs()
  useEffect(() => {
    if (!native) return
    return native.onMenu((action) => {
      // Primer's confirm dialogs render outside the tabs, so they'd stay up over another tab and act on the one behind.
      // The window is modal until they're answered, as it is for the mouse.
      if (confirmDialogOpen()) return
      if (action === 'toggle-agent') toggle()
      else if (action === 'new-tab') newTab()
      // Applied at once, so a quick second press closes the next tab and not the one just closed.
      else if (action === 'close-tab') flushSync(() => void close(activeTabId(), { keepPinned: true }))
      else if (action === 'reopen-tab') reopen()
      else if (action === 'toggle-split') toggleSplit()
      else if (action === 'focus-other-pane') focusOtherPane()
      else if (action === 'next-tab') cycle(1)
      else if (action === 'previous-tab') cycle(-1)
      else if (action === 'back') void activeRouter().navigate(-1)
      else if (action === 'forward') void activeRouter().navigate(1)
      else if (action.startsWith('select-tab:')) selectNumber(Number(action.slice('select-tab:'.length)))
      else if (action.startsWith('navigate:')) void activeRouter().navigate(safeTabPath(action.slice('navigate:'.length)))
      else if (action.startsWith('open-tab:')) {
        const [, disposition, path] = action.match(/^open-tab:(background|foreground):(.*)$/s) ?? []
        if (path) open(safeTabPath(path), { background: disposition === 'background' })
      }
    })
  }, [toggle, activeRouter, activeTabId, newTab, close, reopen, cycle, selectNumber, open, toggleSplit, focusOtherPane])
}

/**
 * Links are decided here, for the whole window. Cmd-click and middle-click open a tab: in-app links in the background
 * (Cmd+Shift-click in front), anything else in the system browser. Option-click opens an in-app link in the other pane. A plain click on a same-origin link that the router
 * didn't handle stays in the active tab, so nothing on a page can navigate the app shell.
 */
function useTabLinks() {
  const { active: account } = useAuth()
  const tabs = useTabs()
  const latest = useRef({ host: account!.host, tabs })
  latest.current = { host: account!.host, tabs }

  useEffect(() => {
    const anchorOf = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]')
      return a instanceof HTMLAnchorElement && !a.hasAttribute('download') ? a : null
    }

    const openLink = (e: MouseEvent, a: HTMLAnchorElement) => {
      const { host, tabs } = latest.current
      const target = linkTarget(a.getAttribute('href')!, host, tabs.active.url, !!a.closest('.markdown-body'))
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      if ('external' in target) openExternal(target.external)
      else if (e.altKey) tabs.openToSide(target.app, { title: titleFromLink(target.app, a.textContent ?? '') })
      else tabs.open(target.app, { background: !e.shiftKey, title: titleFromLink(target.app, a.textContent ?? '') })
    }

    const newTabKey = (e: MouseEvent) => (native?.platform === 'darwin' ? e.metaKey : e.ctrlKey)

    // In the capture phase, before Link and the markdown interceptor decide it's the browser's job.
    const onClickCapture = (e: MouseEvent) => {
      const a = anchorOf(e)
      if (a && (newTabKey(e) || e.altKey)) openLink(e, a)
    }
    const onAuxClick = (e: MouseEvent) => {
      const a = anchorOf(e)
      if (a && e.button === 1) openLink(e, a)
    }
    // Middle-press would otherwise start autoscroll on Windows and Linux.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1 && anchorOf(e)) e.preventDefault()
    }

    // In the bubble phase, after anything that handled the click for itself.
    const onClick = (e: MouseEvent) => {
      const a = anchorOf(e)
      if (!a || e.defaultPrevented || e.button !== 0 || a.target === '_blank') return
      const href = a.getAttribute('href')!
      if (href.startsWith('#')) {
        e.preventDefault()
        // Hidden tabs keep their ids, and GitHub prefixes the ones in rendered markdown.
        const id = decodeId(href.slice(1))
        ;(contentElementById(id) ?? contentElementById(`user-content-${id}`))?.scrollIntoView()
      } else if (a.protocol === location.protocol && a.host === location.host) {
        e.preventDefault()
        void latest.current.tabs.activeRouter().navigate(safeTabPath(a.pathname + a.search + a.hash))
      }
    }

    document.addEventListener('click', onClickCapture, true)
    document.addEventListener('auxclick', onAuxClick, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('click', onClickCapture, true)
      document.removeEventListener('auxclick', onAuxClick, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('click', onClick)
    }
  }, [])
}

function TabCommands() {
  useTabMenu()
  useTabLinks()
  return null
}

/** `covered`: sign-in is open over the tabs. They only hide, so a half-written comment survives it. */
function TabShell({ covered }: { covered: boolean }) {
  const { state } = useTabs()
  const mode = covered ? 'hidden' : 'visible'
  // Sorted, not in strip order: reordering tabs must not move the panes in the DOM, which would reset their scroll.
  const live = state.tabs.filter((t) => state.live.includes(t.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
  const visible = visibleTabs(state)
  const style = { ...(covered ? { display: 'none' } : {}), ...(state.split ? { gridTemplateColumns: splitColumns(state.splitRatio) } : {}) }
  return (
    <div className={`app-shell tabbed${state.split ? ' is-split' : ''}`} style={style}>
      <Activity mode={mode}>
        <TabCommands />
        <TabStrip />
      </Activity>
      {live.map((tab) => (
        <TabPane
          key={tab.id}
          tab={tab}
          shown={!covered && visible.includes(tab.id)}
          side={state.split?.[0] === tab.id ? 'left' : state.split?.[1] === tab.id ? 'right' : null}
          focused={tab.id === state.activeId}
        />
      ))}
      {state.split && <SplitDivider />}
      <Activity mode={mode}>
        <AgentDock />
      </Activity>
    </div>
  )
}

function LoginFinished({ onDone }: { onDone(path: string): void }) {
  const { pathname, search, hash } = useLocation()
  useEffect(() => onDone(pathname + search + hash), [pathname, search, hash, onDone])
  return null
}

function LoginGate({ path, onDone }: { path: string; onDone(path: string): void }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<LoginFinished onDone={onDone} />} />
      </Routes>
    </MemoryRouter>
  )
}

/**
 * The desktop app's root, in place of the web build's BrowserRouter: one router per tab (nested routers are illegal),
 * and sign-in in a router of its own. Adding an account or signing in again only hides the tabs, so a half-written
 * comment survives it; each account has its own tabs, which unmount when the account changes.
 */
export function NativeApp() {
  const { ready, active, accounts } = useAuth()
  const [loginPath, setLoginPath] = useState<string | null>(null)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [tabRoutes] = useState(() => createRoutesFromElements(pageRoutes(<TabContent><AppShell tabbed /></TabContent>)))

  const finishLogin = useCallback((path: string) => {
    setLoginPath(null)
    setPendingPath(safeTabPath(path) === '/' ? null : path)
  }, [])
  const clearPending = useCallback(() => setPendingPath(null), [])

  // A signed-out account's tabs name its repositories, so they don't stay behind.
  const known = useRef<string[]>([])
  useEffect(() => {
    for (const id of known.current) {
      if (accounts.some((a) => a.id === id)) continue
      forgetSavedTabs(id)
      forgetRepoSnapshots(id)
    }
    known.current = accounts.map((a) => a.id)
  }, [accounts])

  if (!ready) return <AppLoading label="Loading accounts" />
  const showLogin = !active || loginPath !== null
  return (
    <>
      {active && (
        <AgentProvider>
          <TabsProvider key={active.id} accountId={active.id} routes={tabRoutes} onLogin={setLoginPath} pendingPath={pendingPath} onPendingPathUsed={clearPending}>
            <TabShell covered={showLogin} />
          </TabsProvider>
        </AgentProvider>
      )}
      {showLogin && <LoginGate path={loginPath ?? '/login'} onDone={finishLogin} />}
    </>
  )
}
