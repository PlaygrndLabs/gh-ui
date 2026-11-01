import { Component, useEffect, type ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Banner } from '@primer/react'
import { reauthPath, useAuth } from './lib/auth'
import { AgentProvider, useAgent } from './lib/agent/AgentProvider'
import { native } from './lib/platform'
import { AppHeader, useRouteRepo } from './components/AppHeader'
import { AgentPanel } from './components/AgentPanel'
import { Loading, Blankslate, ErrorBox } from './components/Bits'
import { LoginPage } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { NotificationsPage } from './pages/Notifications'
import { GlobalListPage } from './pages/GlobalList'
import { SearchPage } from './pages/Search'
import { ProfilePage } from './pages/Profile'
import { SettingsPage } from './pages/Settings'
import { LocalReposPage } from './pages/Local'
import { RepoLayout } from './pages/repo/RepoLayout'
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

function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, active } = useAuth()
  const location = useLocation()
  if (!ready) return <Loading label="Loading accounts" />
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
      variant="critical"
      title={`GitHub no longer accepts the saved token for ${active.login}`}
      description="It expired or was revoked. Sign in again to keep using this account."
      primaryAction={<Banner.PrimaryAction onClick={() => navigate(reauthPath(active, pathname + search))}>Sign in again</Banner.PrimaryAction>}
      secondaryAction={<Banner.SecondaryAction onClick={() => void signOut(active.id)}>Sign out</Banner.SecondaryAction>}
    />
  )
}

/** Keeps one broken page (or the agent panel) from blanking the whole window; resets on navigation. */
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string; title: string }, { error: Error | null }> {
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

function AppShell() {
  const agent = useAgent()
  const navigate = useNavigate()
  const { repo } = useRouteRepo()
  const { pathname } = useLocation()

  useEffect(() => {
    if (!native) return
    return native.onMenu((action) => {
      if (action === 'toggle-agent') agent.toggle()
      else if (action.startsWith('navigate:')) navigate(action.slice('navigate:'.length))
    })
  }, [agent, navigate])

  return (
    <div className="app-shell">
      <AppHeader />
      <RejectedTokenBanner />
      <div className="app-body">
        <main className="app-main">
          <ErrorBoundary resetKey={pathname} title="This page hit an error">
            <Outlet />
          </ErrorBoundary>
        </main>
        {agent.open && (
          <ErrorBoundary resetKey={pathname} title="The agent panel hit an error">
            <AgentPanel withLocalBar={!!repo} />
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AgentProvider>
              <AppShell />
            </AgentProvider>
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="pulls" element={<GlobalListPage kind="pr" />} />
        <Route path="issues" element={<GlobalListPage kind="issue" />} />
        <Route path="search" element={<SearchPage />} />
        {/* Explicit params, not splats: a splat ranks no higher than the :owner/:repo index route. */}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:section" element={<SettingsPage />} />
        <Route path="local" element={<LocalReposPage />} />
        <Route path="local/:id" element={<LocalReposPage />} />
        <Route path="orgs/:org" element={<OrgRedirect />} />
        <Route path="orgs/:org/:tab" element={<OrgRedirect />} />
        <Route path=":owner" element={<ProfilePage />} />
        <Route path=":owner/:repo" element={<RepoLayout />}>
          <Route index element={<CodePage />} />
          <Route path="tree/*" element={<CodePage />} />
          <Route path="blob/*" element={<BlobPage />} />
          <Route path="blame/*" element={<BlobPage />} />
          <Route path="commits/*" element={<CommitsPage />} />
          <Route path="commit/:sha" element={<CommitPage />} />
          {/* The splat carries github.com's view paths: /branches/yours, /active, /stale, /all. */}
          <Route path="branches/*" element={<BranchesPage />} />
          <Route path="pulls" element={<PullsPage />} />
          <Route path="pull/:number/*" element={<PullRequestPage />} />
          <Route path="compare/*" element={<ComparePage />} />
          <Route path="issues" element={<IssuesPage />} />
          <Route path="issues/new" element={<NewIssuePage />} />
          <Route path="issues/:number" element={<IssuePage />} />
          <Route path="actions" element={<ActionsPage />} />
          <Route path="actions/workflows/:workflow" element={<ActionsPage />} />
          <Route path="actions/runs/:runId" element={<RunPage />} />
          <Route path="actions/runs/:runId/job/:jobId" element={<RunPage />} />
          <Route path="releases" element={<ReleasesPage />} />
          <Route path="releases/latest" element={<LatestReleasePage />} />
          <Route path="releases/tag/*" element={<ReleasePage />} />
          <Route path="releases/new" element={<NewReleasePage />} />
          <Route path="releases/edit/*" element={<EditReleasePage />} />
          <Route path="tags" element={<ReleasesPage />} />
          <Route path="discussions" element={<DiscussionsPage />} />
          <Route path="discussions/:number" element={<DiscussionPage />} />
          <Route path="discussions/categories/:slug" element={<DiscussionsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:number" element={<ProjectPage />} />
          <Route path="security/*" element={<SecurityPage />} />
          <Route path="pulse" element={<InsightsPage />} />
          <Route path="graphs/*" element={<InsightsPage />} />
          <Route path="wiki/*" element={<WikiPage />} />
          {/* github.com's settings paths; the layout shows a 404 to anyone without admin access. */}
          <Route path="settings" element={<RepoSettingsLayout />}>
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
    </Routes>
  )
}
