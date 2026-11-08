import { Activity, Component, useLayoutEffect, useRef, type FocusEvent, type ReactElement, type ReactNode, type UIEvent } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useNavigationType, useOutlet, useParams } from 'react-router-dom'
import { repoSectionKey } from './lib/tabs'
import { Banner } from '@primer/react'
import { reauthPath, useAuth } from './lib/auth'
import { AgentProvider, useAgent } from './lib/agent/AgentProvider'
import { AppHeader } from './components/AppHeader'
import { WorkspaceHeader } from './components/WorkspaceHeader'
import { AgentPanel } from './components/AgentPanel'
import { AppLoading, Blankslate, ErrorBox } from './components/Bits'
import { LoginPage } from './pages/Login'
import { NotificationsPage } from './pages/Notifications'
import { GlobalListPage } from './pages/GlobalList'
import { SearchPage } from './pages/Search'
import { ProfilePage } from './pages/Profile'
import { SettingsPage } from './pages/Settings'
import { LocalReposPage } from './pages/Local'
import { RepoLayout } from './pages/repo/RepoLayout'
import { HomePage, RepoHome } from './pages/repo/RepoHome'
import { ActionsHome, ActionsLayout } from './pages/workspace/ActionsWorkspace'
import { PullsHome, PullsLayout } from './pages/workspace/PullsWorkspace'
import { CodePage, BlobPage } from './pages/repo/Code'
import { CommitsPage, CommitPage } from './pages/repo/Commits'
import { BranchesPage } from './pages/repo/Branches'
import { PullsPage } from './pages/repo/Pulls'
import { PullRequestPage } from './pages/repo/PullRequest'
import { ComparePage } from './pages/repo/Compare'
import { IssuesPage } from './pages/repo/Issues'
import { IssuePage, NewIssuePage } from './pages/repo/Issue'
import { ActionsPage } from './pages/repo/Actions'
import { RunPage } from './pages/repo/Run'
import { ReleasesPage, ReleasePage, LatestReleasePage } from './pages/repo/Releases'
import { NewReleasePage, EditReleasePage } from './pages/repo/ReleaseForm'
import { DiscussionsPage, DiscussionPage } from './pages/repo/Discussions'
import { ProjectsPage, ProjectPage } from './pages/repo/Projects'
import { SecurityPage } from './pages/repo/Security'
import { InsightsPage } from './pages/repo/Insights'
import { WikiPage } from './pages/repo/Wiki'
import { RepoSettingsLayout } from './pages/repo/settings/SettingsLayout'
import { GeneralSettings } from './pages/repo/settings/General'
import { CollaboratorsSettings } from './pages/repo/settings/Collaborators'
import { BranchProtectionSettings, BranchProtectionRulePage } from './pages/repo/settings/BranchProtection'
import { RulesetsSettings } from './pages/repo/settings/Rulesets'
import { WebhooksSettings, WebhookPage } from './pages/repo/settings/Webhooks'
import { DeployKeysSettings, NewDeployKeyPage } from './pages/repo/settings/DeployKeys'
import { SecretsSettings, SecretFormPage, VariableFormPage } from './pages/repo/settings/Secrets'
import { AlertIcon } from '@primer/octicons-react'
import { FeatureGate } from './components/FeatureGate'

function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, active } = useAuth()
  const location = useLocation()
  if (!ready) return <AppLoading label="Loading accounts" />
  if (!active) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return <>{children}</>
}

/** Says so when GitHub stops accepting the active account's token, instead of every page just failing with "Bad credentials". */
function RejectedTokenBanner() {
  const { active, rejected, signOut } = useAuth()
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  if (!active || !rejected.has(active.id)) return null
  return (
    <Banner
      flush
      className="rejected-token-banner"
      variant="critical"
      title={`GitHub no longer accepts the saved token for ${active.login}`}
      description="It expired or was revoked. Sign in again to keep using this account."
      primaryAction={<Banner.PrimaryAction onClick={() => navigate(reauthPath(active, pathname + search))}>Sign in again</Banner.PrimaryAction>}
      secondaryAction={<Banner.SecondaryAction onClick={() => void signOut(active.id)}>Sign out</Banner.SecondaryAction>}
    />
  )
}

/** Keeps one broken page (or the agent panel) from blanking the whole window; resets on navigation. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string; title: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="container-lg">
        <ErrorBox error={this.state.error} title={this.props.title} />
      </div>
    )
  }
}

/**
 * Browsers do this for a scrolling window, but not for an element: new pages start at the top and Back restores.
 * In the desktop app <Activity> re-runs this layout effect when a hidden tab is shown, with its pathname unchanged. Being
 * hidden (display:none) reset every scroller inside it, so that puts them back, and the focus with them. The last top
 * seen, not the history entry's: a filter changes the entry and leaves the page where it is, with no scroll event.
 */
function useContentScroll() {
  const main = useRef<HTMLElement>(null)
  const { key, pathname } = useLocation()
  const navigationType = useNavigationType()
  const positions = useRef(new Map<string, number>())
  const inner = useRef(new Map<Element, { top: number; left: number }>())
  const lastFocus = useRef<HTMLElement | null>(null)
  const shownPathname = useRef<string | null>(null)
  const lastTop = useRef(0)
  // Each tab of a repository's tab row keeps its page (see KeptSections), and where it was scrolled with it.
  const section = repoSectionKey(pathname)
  const shownSection = useRef<string | null>(null)
  const sections = useRef(new Map<string, { top: number; inner: Map<Element, { top: number; left: number }> }>())
  useLayoutEffect(() => {
    const el = main.current
    if (!el) return
    if (shownPathname.current === pathname) {
      el.scrollTop = lastTop.current
      for (const [node, at] of inner.current) {
        if (!node.isConnected) inner.current.delete(node)
        else if (node !== el) node.scrollTo(at.left, at.top)
      }
    } else if (section && section !== shownSection.current && sections.current.has(section)) {
      // Back to a tab of the repository: its page was kept, so it goes back to where it was.
      const kept = sections.current.get(section)!
      inner.current = kept.inner
      lastFocus.current = null
      lastTop.current = kept.top
      el.scrollTop = kept.top
      for (const [node, at] of kept.inner) {
        if (!node.isConnected) kept.inner.delete(node)
        else node.scrollTo(at.left, at.top)
      }
    } else {
      inner.current = new Map()
      lastFocus.current = null
      lastTop.current = navigationType === 'POP' ? (positions.current.get(key) ?? 0) : 0
      el.scrollTop = lastTop.current
    }
    if (section) sections.current.set(section, { top: lastTop.current, inner: inner.current })
    shownSection.current = section
    shownPathname.current = pathname
    // Arrow keys and Page Down scroll the focused area, so keep it focused unless something else is. A focused
    // element in the tab just hidden still counts as active until the browser next lays out.
    const active = document.activeElement
    if (!active || active === document.body || !active.getClientRects().length) {
      const previous = lastFocus.current
      ;(previous?.isConnected ? previous : el).focus({ preventScroll: true })
    }
  }, [pathname])
  // A new entry on the same page starts where the page is, so Back to it does too.
  useLayoutEffect(() => {
    positions.current.set(key, lastTop.current)
  }, [key])
  // Hiding fires a last scroll event at position 0, which must not overwrite the position to restore.
  const onScroll = (e: UIEvent<HTMLElement>) => {
    const el = main.current
    if (!el || !el.getClientRects().length) return
    if (e.target === el) {
      lastTop.current = el.scrollTop
      positions.current.set(key, el.scrollTop)
      const kept = shownSection.current && sections.current.get(shownSection.current)
      if (kept) kept.top = el.scrollTop
    }
    // A kept page being hidden scrolls to 0 too.
    else if (e.target instanceof Element && e.target.getClientRects().length) inner.current.set(e.target, { top: e.target.scrollTop, left: e.target.scrollLeft })
  }
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (e.target !== main.current) lastFocus.current = e.target
  }
  return { main, onScroll, onFocus }
}

/**
 * The desktop app's pages for one window tab. Each tab of a repository's tab row (Branch, Pull requests, Actions, Code,
 * …) keeps its page while another is shown, hidden in <Activity>, so going back finds it as it was left: the pull
 * request, its files, what was typed. Other pages show as usual.
 */
function KeptSections() {
  const { pathname } = useLocation()
  const outlet = useOutlet()
  const current = repoSectionKey(pathname)
  const kept = useRef(new Map<string, ReactNode>())
  if (current) {
    // Only the open repository's tabs: going to another repository in this window tab starts it afresh.
    const repo = current.slice(0, current.indexOf('#'))
    for (const k of kept.current.keys()) if (!k.startsWith(`${repo}#`)) kept.current.delete(k)
    kept.current.set(current, outlet)
  }
  return (
    <>
      {[...kept.current].map(([k, page]) => (
        <Activity key={k} mode={k === current ? 'visible' : 'hidden'}>
          <ErrorBoundary resetKey={k === current ? pathname : k} title="This page hit an error">
            {page}
          </ErrorBoundary>
        </Activity>
      ))}
      {!current && (
        <ErrorBoundary resetKey={pathname} title="This page hit an error">
          {outlet}
        </ErrorBoundary>
      )}
    </>
  )
}

/** The app's frame. In the desktop app each tab renders it without the agent panel, which is shared across tabs (see NativeApp). */
export function AppShell({ tabbed = false }: { tabbed?: boolean }) {
  const agent = useAgent()
  const { pathname } = useLocation()
  const { main, onScroll, onFocus } = useContentScroll()

  const page = (
    <main className="app-main" ref={main} tabIndex={-1} onScrollCapture={onScroll} onFocusCapture={onFocus}>
      {tabbed ? (
        <KeptSections />
      ) : (
        <ErrorBoundary resetKey={pathname} title="This page hit an error">
          <Outlet />
        </ErrorBoundary>
      )}
    </main>
  )

  if (tabbed) {
    return (
      <>
        <WorkspaceHeader />
        <RejectedTokenBanner />
        {page}
      </>
    )
  }
  return (
    <div className="app-shell">
      <AppHeader />
      <RejectedTokenBanner />
      <div className="app-body">
        {page}
        {agent.open && (
          <ErrorBoundary resetKey={pathname} title="The agent panel hit an error">
            <AgentPanel />
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}

export function NotFound() {
  return (
    <div className="container-lg">
      <Blankslate icon={<AlertIcon size={32} />} title="Page not found">
        gh-ui does not have a view for this page yet.
      </Blankslate>
    </div>
  )
}

/** github.com/orgs/<org>[/<tab>] is the organization profile, which lives at /<org>?tab=… here. */
function OrgRedirect() {
  const { org = '', tab } = useParams()
  // Keep github.com's filters (/orgs/x/repositories?q=…&type=…): the Repositories tab reads the same names.
  const search = new URLSearchParams(useLocation().search)
  // Tabs gh-ui doesn't have (packages, teams, …) land on the overview.
  if (tab && ['repositories', 'projects', 'people'].includes(tab)) search.set('tab', tab)
  const query = search.toString()
  return <Navigate to={`/${org}${query ? `?${query}` : ''}`} replace />
}

/** Every signed-in page, inside `shell`: the web build's one router and each desktop tab's own router share these. */
export function pageRoutes(shell: ReactElement) {
  return (
    <Route element={shell}>
      <Route index element={<HomePage />} />
      <Route path="notifications" element={<NotificationsPage />} />
      <Route path="pulls" element={<GlobalListPage kind="pr" />} />
      <Route path="issues" element={<GlobalListPage kind="issue" />} />
      <Route path="search" element={<SearchPage />} />
      {/* Explicit params, not splats: a splat ranks no higher than the :owner/:repo index route. */}
      <Route path="settings" element={<SettingsPage />} />
      <Route path="settings/:section" element={<SettingsPage />} />
      <Route path="local" element={<LocalReposPage />} />
      <Route path="local/:id" element={<LocalReposPage />} />
      <Route path="local/:id/:section" element={<LocalReposPage />} />
      <Route path="orgs/:org" element={<OrgRedirect />} />
      <Route path="orgs/:org/:tab" element={<OrgRedirect />} />
      <Route path=":owner" element={<ProfilePage />} />
      <Route path=":owner/:repo" element={<RepoLayout />}>
        <Route index element={<RepoHome />} />
        <Route path="tree/*" element={<CodePage />} />
        <Route path="blob/*" element={<BlobPage />} />
        <Route path="blame/*" element={<BlobPage />} />
        <Route path="commits/*" element={<CommitsPage />} />
        <Route path="commit/:sha" element={<CommitPage />} />
        {/* The splat carries github.com's view paths: /branches/yours, /active, /stale, /all. */}
        <Route path="branches/*" element={<BranchesPage />} />
        <Route element={<PullsLayout />}>
          <Route path="pulls" element={<PullsHome />} />
          <Route path="pull/:number/*" element={<PullRequestPage />} />
        </Route>
        <Route path="pulls/all" element={<PullsPage />} />
        <Route path="compare/*" element={<ComparePage />} />
        <Route path="issues" element={<FeatureGate feature="issues"><IssuesPage /></FeatureGate>} />
        <Route path="issues/new" element={<FeatureGate feature="issues"><NewIssuePage /></FeatureGate>} />
        <Route path="issues/:number" element={<FeatureGate feature="issues"><IssuePage /></FeatureGate>} />
        <Route element={<ActionsLayout />}>
          <Route path="actions" element={<ActionsHome />} />
          <Route path="actions/runs/:runId" element={<RunPage />} />
          <Route path="actions/runs/:runId/job/:jobId" element={<RunPage />} />
        </Route>
        <Route path="actions/all" element={<ActionsPage />} />
        <Route path="actions/workflows/:workflow" element={<ActionsPage />} />
        <Route path="releases" element={<ReleasesPage />} />
        <Route path="releases/latest" element={<LatestReleasePage />} />
        <Route path="releases/tag/*" element={<ReleasePage />} />
        <Route path="releases/new" element={<NewReleasePage />} />
        <Route path="releases/edit/*" element={<EditReleasePage />} />
        <Route path="tags" element={<ReleasesPage />} />
        <Route path="discussions" element={<FeatureGate feature="discussions"><DiscussionsPage /></FeatureGate>} />
        <Route path="discussions/:number" element={<FeatureGate feature="discussions"><DiscussionPage /></FeatureGate>} />
        <Route path="discussions/categories/:slug" element={<FeatureGate feature="discussions"><DiscussionsPage /></FeatureGate>} />
        <Route path="projects" element={<FeatureGate feature="projects"><ProjectsPage /></FeatureGate>} />
        <Route path="projects/:number" element={<FeatureGate feature="projects"><ProjectPage /></FeatureGate>} />
        <Route path="security/*" element={<FeatureGate feature="security"><SecurityPage /></FeatureGate>} />
        <Route path="pulse" element={<FeatureGate feature="insights"><InsightsPage /></FeatureGate>} />
        <Route path="graphs/*" element={<FeatureGate feature="insights"><InsightsPage /></FeatureGate>} />
        <Route path="wiki/*" element={<FeatureGate feature="wiki"><WikiPage /></FeatureGate>} />
        {/* github.com's settings paths; the layout shows a 404 to anyone without admin access. */}
        <Route path="settings" element={<FeatureGate feature="repoSettings"><RepoSettingsLayout /></FeatureGate>}>
          <Route index element={<GeneralSettings />} />
          <Route path="access" element={<CollaboratorsSettings />} />
          <Route path="branches" element={<BranchProtectionSettings />} />
          <Route path="branch_protection_rules/new" element={<BranchProtectionRulePage />} />
          <Route path="branch_protection_rules/:id" element={<BranchProtectionRulePage />} />
          <Route path="rules" element={<RulesetsSettings />} />
          <Route path="hooks" element={<WebhooksSettings />} />
          <Route path="hooks/new" element={<WebhookPage />} />
          <Route path="hooks/:id" element={<WebhookPage />} />
          <Route path="keys" element={<DeployKeysSettings />} />
          <Route path="keys/new" element={<NewDeployKeyPage />} />
          <Route path="secrets" element={<Navigate to="actions" replace />} />
          <Route path="secrets/actions" element={<SecretsSettings />} />
          <Route path="secrets/actions/new" element={<SecretFormPage />} />
          <Route path="secrets/actions/:name" element={<SecretFormPage />} />
          <Route path="variables" element={<Navigate to="actions" replace />} />
          <Route path="variables/actions" element={<SecretsSettings />} />
          <Route path="variables/actions/new" element={<VariableFormPage />} />
          <Route path="variables/actions/:name" element={<VariableFormPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Route>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {pageRoutes(
        <RequireAuth>
          <AgentProvider>
            <AppShell />
          </AgentProvider>
        </RequireAuth>,
      )}
    </Routes>
  )
}
