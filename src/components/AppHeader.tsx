import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Avatar, Button, Dialog, IconButton, NavList, TextInput, Tooltip, UnderlineNav } from '@primer/react'
import {
  ThreeBarsIcon,
  SearchIcon,
  PlusIcon,
  TriangleDownIcon,
  IssueOpenedIcon,
  GitPullRequestIcon,
  InboxIcon,
  SparkleFillIcon,
  CodeIcon,
  PlayIcon,
  CommentDiscussionIcon,
  TableIcon,
  BookIcon,
  ShieldIcon,
  GraphIcon,
  HomeIcon,
  GearIcon,
  PersonIcon,
  RepoIcon,
  SignOutIcon,
  PersonAddIcon,
  DeviceDesktopIcon,
  GitBranchIcon,
  LinkExternalIcon,
  StarIcon,
  CodeSquareIcon,
  OrganizationIcon,
  MarkGithubIcon,
  PeopleIcon,
} from '@primer/octicons-react'
import { useAuth, useAccount } from '../lib/auth'
import { useSwitchAccount, useIsFocusedPane } from '../lib/TabsProvider'
import { canReadNotifications } from '../lib/hosts'
import { useGitHub } from '../lib/github'
import { AgentOnly, useAgent } from '../lib/agent/AgentProvider'
import { isNative, openExternal } from '../lib/platform'
import { useRepoAdvisoryCount, useRepoCounts, useRepoQuery } from '../lib/repo'
import { webUrl } from '../lib/links'
import { useFeature, useFeatures } from '../lib/features'

// 'orgs' is github.com's /orgs/<org> alias, which OrgRedirect sends to /<org>; it is never a repo owner.
const TOP_LEVEL = new Set(['', 'notifications', 'pulls', 'issues', 'settings', 'local', 'search', 'login', 'orgs'])

// A malformed escape (e.g. a lone '%' in a file name) must not throw during render.
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function useRouteRepo() {
  const { pathname } = useLocation()
  const [owner = '', repo = '', section = ''] = pathname.split('/').filter(Boolean).slice(0, 3).map(safeDecode)
  if (TOP_LEVEL.has(owner)) return { owner: '', repo: '', section: '', top: owner }
  return { owner, repo, section, top: '' }
}

export function GhUiMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <g fill="none" stroke="var(--bgColor-default)" strokeWidth="2.4" strokeLinecap="round">
        <circle cx="10" cy="9" r="2.6" />
        <circle cx="10" cy="23" r="2.6" />
        <circle cx="22" cy="23" r="2.6" />
        <path d="M10 11.6v8.8M22 20.4V14a3 3 0 0 0-3-3h-4" />
        <path d="m17 8-2.6 3 2.6 3" />
      </g>
    </svg>
  )
}

export function AppHeader() {
  const { owner, repo, section, top } = useRouteRepo()
  const navigate = useNavigate()
  const agent = useAgent()
  const account = useAccount()
  const { octokit, key } = useGitHub()
  const [navOpen, setNavOpen] = useState(false)
  const headerShortcuts = useFeature('headerShortcuts')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const unread = useQuery({
    queryKey: [key, 'notifications-unread'],
    // GitHub rejects fine-grained PATs and GitHub App tokens on /notifications, so polling would always fail.
    enabled: canReadNotifications(account.kind),
    queryFn: async () => (await octokit.rest.activity.listNotificationsForAuthenticatedUser({ per_page: 1 })).data.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  // In split view each pane has a header, and only the pane with focus answers the shortcut.
  const focusedPane = useIsFocusedPane()
  useEffect(() => {
    if (!focusedPane) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedPane])

  const submitSearch = () => {
    const q = query.trim()
    if (!q) return
    const repoMatch = q.match(/^([\w.-]+)\/([\w.-]+)$/)
    if (repoMatch) navigate(`/${repoMatch[1]}/${repoMatch[2]}`)
    else navigate(`/search?q=${encodeURIComponent(q)}${repo ? `&repo=${owner}/${repo}` : ''}`)
    setQuery('')
    searchRef.current?.blur()
  }

  const contextTitle =
    top === 'pulls' ? 'Pull requests' : top === 'issues' ? 'Issues' : top === 'notifications' ? 'Notifications' : top === 'settings' ? 'Settings' : top === 'local' ? 'Local repositories' : top === 'search' ? 'Search' : top === '' && !owner ? 'Dashboard' : null

  return (
    <header className={`AppHeader ${repo ? '' : 'no-local'}`}>
      <div className="AppHeader-globalBar">
        <IconButton icon={ThreeBarsIcon} aria-label="Open global navigation menu" onClick={() => setNavOpen(true)} />
        <Link to="/" className="AppHeader-logo" aria-label="Home">
          <GhUiMark />
        </Link>
        <nav className="AppHeader-context" aria-label="Page context">
          {owner ? (
            <>
              <Link to={`/${owner}`}>{owner}</Link>
              {repo && (
                <>
                  <span className="sep">/</span>
                  <Link to={`/${owner}/${repo}`}>{repo}</Link>
                </>
              )}
            </>
          ) : (
            contextTitle && <span className="crumb">{contextTitle}</span>
          )}
        </nav>

        <div className="AppHeader-actions">
          <div className="AppHeader-search">
            <TextInput
              ref={searchRef}
              block
              leadingVisual={SearchIcon}
              placeholder={repo ? `Search ${owner}/${repo} or jump to owner/repo` : 'Type / to search'}
              aria-label="Search or jump to"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
                if (e.key === 'Escape') searchRef.current?.blur()
              }}
              trailingVisual={<span className="kbd">/</span>}
            />
          </div>
          <Tooltip text={agent.open ? 'Close agent' : 'Open agent'}>
            <AgentOnly><Button leadingVisual={SparkleFillIcon} variant={agent.open ? 'primary' : 'default'} onClick={agent.toggle} aria-pressed={agent.open}>
              Agent
            </Button></AgentOnly>
          </Tooltip>
          <ActionMenu>
            <ActionMenu.Anchor>
              <Button leadingVisual={PlusIcon} trailingVisual={TriangleDownIcon} aria-label="Create new…">
                {null}
              </Button>
            </ActionMenu.Anchor>
            <ActionMenu.Overlay width="medium">
              <ActionList>
                {repo && (
                  <>
                    <ActionList.LinkItem as={Link} to={`/${owner}/${repo}/issues/new`}>
                      <ActionList.LeadingVisual>
                        <IssueOpenedIcon />
                      </ActionList.LeadingVisual>
                      New issue
                    </ActionList.LinkItem>
                    <ActionList.LinkItem as={Link} to={`/${owner}/${repo}/compare`}>
                      <ActionList.LeadingVisual>
                        <GitPullRequestIcon />
                      </ActionList.LeadingVisual>
                      New pull request
                    </ActionList.LinkItem>
                    <ActionList.LinkItem as={Link} to={`/${owner}/${repo}/branches?new=1`}>
                      <ActionList.LeadingVisual>
                        <GitBranchIcon />
                      </ActionList.LeadingVisual>
                      New branch
                    </ActionList.LinkItem>
                    <ActionList.Divider />
                  </>
                )}
                {isNative && (
                  <ActionList.LinkItem as={Link} to="/local?clone=">
                    <ActionList.LeadingVisual>
                      <DeviceDesktopIcon />
                    </ActionList.LeadingVisual>
                    Clone repository
                  </ActionList.LinkItem>
                )}
                <ActionList.Item onSelect={() => openExternal(webUrl(account.host, '/new'))}>
                  <ActionList.LeadingVisual>
                    <RepoIcon />
                  </ActionList.LeadingVisual>
                  New repository
                  <ActionList.TrailingVisual>
                    <LinkExternalIcon />
                  </ActionList.TrailingVisual>
                </ActionList.Item>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          {headerShortcuts && (
            <>
              <IconButton description="Your issues" as={Link} to="/issues" icon={IssueOpenedIcon} aria-label="Your issues" />
              <IconButton description="Your pull requests" as={Link} to="/pulls" icon={GitPullRequestIcon} aria-label="Your pull requests" />
            </>
          )}
          <IconButton description={unread.data ? 'You have unread notifications' : 'Notifications'} as={Link} to="/notifications" icon={InboxIcon} aria-label="Notifications" className={unread.data ? 'header-dot' : ''} />
          <AccountMenu />
        </div>
      </div>
      {repo && <RepoNav owner={owner} repo={repo} section={section} />}
      {navOpen && <GlobalNav onClose={() => setNavOpen(false)} />}
    </header>
  )
}

function RepoNav({ owner, repo, section }: { owner: string; repo: string; section: string }) {
  const counts = useRepoCounts(owner, repo)
  const info = useRepoQuery(owner, repo)
  // Only public repositories have published advisories; the endpoint answers 404 for private ones.
  const { isOn } = useFeatures()
  const advisories = useRepoAdvisoryCount(owner, repo, isOn('security') && info.data?.private === false)
  const base = `/${owner}/${repo}`
  const current = (names: string[]) => (names.includes(section) ? 'page' : undefined)
  return (
    <div className="AppHeader-localBar">
      <UnderlineNav aria-label="Repository" loadingCounters={counts.isLoading}>
        <UnderlineNav.Item as={Link} to={base} icon={CodeIcon} aria-current={current(['', 'tree', 'blob', 'blame', 'commits', 'commit', 'branches', 'releases', 'tags'])}>
          Code
        </UnderlineNav.Item>
        {isOn('issues') && (
  <UnderlineNav.Item as={Link} to={`${base}/issues`} icon={IssueOpenedIcon} counter={counts.data?.issues} aria-current={current(['issues'])}>
            Issues
          </UnderlineNav.Item>
        )}
        <UnderlineNav.Item as={Link} to={`${base}/pulls`} icon={GitPullRequestIcon} counter={counts.data?.pulls} aria-current={current(['pulls', 'pull', 'compare'])}>
          Pull requests
        </UnderlineNav.Item>
        {isOn('discussions') && info.data?.has_discussions && (
          <UnderlineNav.Item as={Link} to={`${base}/discussions`} icon={CommentDiscussionIcon} aria-current={current(['discussions'])}>
            Discussions
          </UnderlineNav.Item>
        )}
        <UnderlineNav.Item as={Link} to={`${base}/actions`} icon={PlayIcon} aria-current={current(['actions'])}>
          Actions
        </UnderlineNav.Item>
        {isOn('projects') && (
  <UnderlineNav.Item as={Link} to={`${base}/projects`} icon={TableIcon} aria-current={current(['projects'])}>
            Projects
          </UnderlineNav.Item>
        )}
        {isOn('wiki') && info.data?.has_wiki && (
          <UnderlineNav.Item as={Link} to={`${base}/wiki`} icon={BookIcon} aria-current={current(['wiki'])}>
            Wiki
          </UnderlineNav.Item>
        )}
        {isOn('security') && (
  <UnderlineNav.Item as={Link} to={`${base}/security`} icon={ShieldIcon} counter={advisories.data || undefined} aria-current={current(['security'])}>
            Security and quality
          </UnderlineNav.Item>
        )}
        {isOn('insights') && (
  <UnderlineNav.Item as={Link} to={`${base}/pulse`} icon={GraphIcon} aria-current={current(['pulse', 'graphs'])}>
            Insights
          </UnderlineNav.Item>
        )}
        {isOn('repoSettings') && info.data?.permissions?.admin && (
          <UnderlineNav.Item as={Link} to={`${base}/settings`} icon={GearIcon} aria-current={current(['settings'])}>
            Settings
          </UnderlineNav.Item>
        )}
      </UnderlineNav>
    </div>
  )
}

/** The avatar opens a right-hand side panel, like github.com's user navigation. */
export function AccountMenu() {
  const { active } = useAuth()
  const [open, setOpen] = useState(false)
  if (!active) return null
  return (
    <>
      <button type="button" aria-label="Open user navigation menu" aria-haspopup="dialog" className="AppHeader-avatar" onClick={() => setOpen(true)}>
        <Avatar src={active.avatarUrl} size={32} alt={`@${active.login}`} />
      </button>
      {open && <AccountPanel onClose={() => setOpen(false)} />}
    </>
  )
}

function AccountPanel({ onClose }: { onClose(): void }) {
  const { accounts, active, rejected, signOut } = useAuth()
  const switchTo = useSwitchAccount()
  const navigate = useNavigate()
  if (!active) return null
  const { login, host } = active
  const go = (to: string) => {
    onClose()
    navigate(to)
  }
  const external = (pathOrUrl: string) => {
    onClose()
    openExternal(/^https:\/\//.test(pathOrUrl) ? pathOrUrl : webUrl(host, pathOrUrl))
  }
  // A plain element, not a wrapper component: ActionList finds slots by element type.
  const externalMark = (
    <ActionList.TrailingVisual>
      <LinkExternalIcon />
    </ActionList.TrailingVisual>
  )
  return (
    <Dialog
      position="right"
      width="small"
      onClose={onClose}
      renderHeader={({ dialogLabelId }) => (
        <Dialog.Header className="account-panel-header">
          <Avatar src={active.avatarUrl} size={32} alt="" />
          <div className="account-panel-who">
            <span id={dialogLabelId} className="text-bold text-truncate">
              {login}
            </span>
            {(active.name || host !== 'github.com') && (
              <span className="fg-muted text-small text-truncate">
                {active.name}
                {active.name && host !== 'github.com' ? ' · ' : ''}
                {host !== 'github.com' ? host : ''}
              </span>
            )}
          </div>
          <Dialog.CloseButton onClose={onClose} />
        </Dialog.Header>
      )}
    >
      <ActionList className="account-panel-list">
        <ActionList.Item onSelect={() => go(`/${login}`)}>
          <ActionList.LeadingVisual>
            <PersonIcon />
          </ActionList.LeadingVisual>
          Your profile
        </ActionList.Item>
        <ActionList.Item onSelect={() => go(`/${login}?tab=repositories`)}>
          <ActionList.LeadingVisual>
            <RepoIcon />
          </ActionList.LeadingVisual>
          Your repositories
        </ActionList.Item>
        <ActionList.Item onSelect={() => go(`/${login}?tab=projects`)}>
          <ActionList.LeadingVisual>
            <TableIcon />
          </ActionList.LeadingVisual>
          Your projects
        </ActionList.Item>
        <ActionList.Item onSelect={() => go(`/${login}?tab=stars`)}>
          <ActionList.LeadingVisual>
            <StarIcon />
          </ActionList.LeadingVisual>
          Your stars
        </ActionList.Item>
        <ActionList.Item onSelect={() => external(host === 'github.com' ? `https://gist.github.com/${login}` : `/gist/${login}`)}>
          <ActionList.LeadingVisual>
            <CodeSquareIcon />
          </ActionList.LeadingVisual>
          Your gists
          {externalMark}
        </ActionList.Item>
        <ActionList.Item onSelect={() => external('/settings/organizations')}>
          <ActionList.LeadingVisual>
            <OrganizationIcon />
          </ActionList.LeadingVisual>
          Your organizations
          {externalMark}
        </ActionList.Item>
        <ActionList.Divider />
        <ActionList.Item onSelect={() => go('/settings')}>
          <ActionList.LeadingVisual>
            <GearIcon />
          </ActionList.LeadingVisual>
          Settings
        </ActionList.Item>
        <ActionList.Divider />
        {accounts.length > 1 && (
          <ActionList.Group selectionVariant="single">
            <ActionList.GroupHeading as="h3">Switch account</ActionList.GroupHeading>
            {accounts.map((a) => (
              <ActionList.Item
                key={a.id}
                selected={a.id === active.id}
                onSelect={() => {
                  void switchTo(a.id)
                  onClose()
                }}
              >
                <ActionList.LeadingVisual>
                  <Avatar src={a.avatarUrl} size={16} />
                </ActionList.LeadingVisual>
                {a.login}
                <ActionList.Description variant="block">{rejected.has(a.id) ? `${a.host} · Token expired or revoked` : a.host}</ActionList.Description>
              </ActionList.Item>
            ))}
          </ActionList.Group>
        )}
        <ActionList.Item onSelect={() => go('/login?add=1')}>
          <ActionList.LeadingVisual>
            <PersonAddIcon />
          </ActionList.LeadingVisual>
          Add account
        </ActionList.Item>
        <ActionList.Divider />
        <ActionList.Item onSelect={() => external('/')}>
          <ActionList.LeadingVisual>
            <MarkGithubIcon />
          </ActionList.LeadingVisual>
          {host === 'github.com' ? 'GitHub Website' : host}
          {externalMark}
        </ActionList.Item>
        <ActionList.Item
          onSelect={() => {
            onClose()
            openExternal('https://docs.github.com')
          }}
        >
          <ActionList.LeadingVisual>
            <BookIcon />
          </ActionList.LeadingVisual>
          GitHub Docs
          {externalMark}
        </ActionList.Item>
        <ActionList.Item
          onSelect={() => {
            onClose()
            openExternal('https://support.github.com')
          }}
        >
          <ActionList.LeadingVisual>
            <PeopleIcon />
          </ActionList.LeadingVisual>
          GitHub Support
          {externalMark}
        </ActionList.Item>
        <ActionList.Divider />
        <ActionList.Item
          onSelect={() => {
            onClose()
            void signOut(active.id)
          }}
        >
          <ActionList.LeadingVisual>
            <SignOutIcon />
          </ActionList.LeadingVisual>
          {accounts.length > 1 ? `Sign out ${login}` : 'Sign out'}
        </ActionList.Item>
      </ActionList>
    </Dialog>
  )
}

function GlobalNav({ onClose }: { onClose(): void }) {
  const { octokit, key } = useGitHub()
  const { pathname } = useLocation()
  const repos = useQuery({
    queryKey: [key, 'top-repos'],
    queryFn: async () => (await octokit.rest.repos.listForAuthenticatedUser({ sort: 'pushed', per_page: 12 })).data,
    staleTime: 5 * 60_000,
  })
  return (
    <Dialog className="global-nav-dialog" title={<GhUiMark size={28} />} position="left" width="small" onClose={onClose}>
      <NavList aria-label="Global">
        <NavList.Item as={Link} to="/" aria-current={pathname === '/' ? 'page' : undefined} onClick={onClose}>
          <NavList.LeadingVisual>
            <HomeIcon />
          </NavList.LeadingVisual>
          Home
        </NavList.Item>
        <NavList.Item as={Link} to="/issues" aria-current={pathname === '/issues' ? 'page' : undefined} onClick={onClose}>
          <NavList.LeadingVisual>
            <IssueOpenedIcon />
          </NavList.LeadingVisual>
          Issues
        </NavList.Item>
        <NavList.Item as={Link} to="/pulls" aria-current={pathname === '/pulls' ? 'page' : undefined} onClick={onClose}>
          <NavList.LeadingVisual>
            <GitPullRequestIcon />
          </NavList.LeadingVisual>
          Pull requests
        </NavList.Item>
        <NavList.Item as={Link} to="/notifications" aria-current={pathname === '/notifications' ? 'page' : undefined} onClick={onClose}>
          <NavList.LeadingVisual>
            <InboxIcon />
          </NavList.LeadingVisual>
          Notifications
        </NavList.Item>
        {isNative && (
          <NavList.Item as={Link} to="/local" aria-current={pathname.startsWith('/local') ? 'page' : undefined} onClick={onClose}>
            <NavList.LeadingVisual>
              <DeviceDesktopIcon />
            </NavList.LeadingVisual>
            Local repositories
          </NavList.Item>
        )}
        <NavList.Item as={Link} to="/settings" aria-current={pathname.startsWith('/settings') ? 'page' : undefined} onClick={onClose}>
          <NavList.LeadingVisual>
            <GearIcon />
          </NavList.LeadingVisual>
          Settings
        </NavList.Item>
        <NavList.Group title="Repositories">
          {(repos.data ?? []).map((r) => (
            <NavList.Item key={r.id} as={Link} to={`/${r.full_name}`} onClick={onClose}>
              <NavList.LeadingVisual>
                <Avatar src={r.owner.avatar_url} size={16} square={r.owner.type === 'Organization'} />
              </NavList.LeadingVisual>
              {r.full_name}
            </NavList.Item>
          ))}
        </NavList.Group>
      </NavList>
    </Dialog>
  )
}
