import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Banner, Checkbox, Dialog, FormControl, IconButton, TextInput } from '@primer/react'
import { GitBranchIcon, LinkExternalIcon, LinkIcon, RepoCloneIcon, SearchIcon, SparkleFillIcon, SyncIcon, TriangleDownIcon } from '@primer/octicons-react'
import { AgentOnly, useAgent } from '../lib/agent/AgentProvider'
import { useFeatures } from '../lib/features'
import { errorMessage, useGitHub } from '../lib/github'
import { plural } from '../lib/format'
import { webUrl } from '../lib/links'
import { native, openExternal } from '../lib/platform'
import { useRepoCounts, useRepoQuery } from '../lib/repo'
import { useLocalRepo } from '../lib/useLocalRepo'
import { useTabBranch, useTabTitle } from '../lib/TabsProvider'
import { syncAction, useRemoteBranches, useWorkspaceRepos, workspacePath, type SyncKind, type WorkspaceRepo } from '../lib/workspace'
import { repoKeyFromUrl } from '../lib/tabs'
import { CloneDialog } from '../pages/Local'
import { AccountMenu } from './AppHeader'
import { InboxMenu } from './InboxMenu'
import { TabItemPicker } from './HeaderPickers'
import { CopyButton } from './Bits'

const SYNC_LABEL: Record<SyncKind, string> = {
  clone: 'Clone repository',
  'publish-repo': 'Publish repository',
  'publish-branch': 'Publish branch',
  pull: 'Pull origin',
  push: 'Push origin',
  fetch: 'Fetch origin',
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The repository the page in this tab belongs to. */
function useCurrentRepo(): WorkspaceRepo | null {
  const { pathname } = useLocation()
  const { account } = useGitHub()
  const { repos, addGitHubRepo, isLoading } = useWorkspaceRepos()
  const parts = pathname.split('/').filter(Boolean).map(safeDecode)
  const key = repoKeyFromUrl(pathname)
  const isFolder = parts[0] === 'local'
  const known = key ? repos.find((r) => (isFolder ? r.local?.id === parts[1] : !!r.github && `${r.github.owner}/${r.github.repo}`.toLowerCase() === key && r.key === `${account.host}/${key}`.toLowerCase())) : undefined
  const missing = !!key && !isFolder && !known && !isLoading

  // A repository visited through a link joins the list, so it's there to come back to.
  useEffect(() => {
    if (missing) addGitHubRepo({ host: account.host, owner: parts[0], repo: parts[1] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, account.host, key])

  if (known) return known
  if (!key || isFolder) return null
  return { key: `${account.host}/${key}`.toLowerCase(), name: parts[1], location: 'github', local: null, github: { host: account.host, owner: parts[0], repo: parts[1] } }
}

function BranchMenu({ repo }: { repo: WorkspaceRepo }) {
  const local = useLocalRepo(repo.local)
  const info = useRepoQuery(repo.github?.owner ?? '', repo.github?.repo ?? '', !repo.local && !!repo.github)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(false)
  const remote = useRemoteBranches(repo)
  const { picked, setPicked, showBranch, shownBranch } = useTabBranch()
  const all = (repo.local ? local.branches.data : remote.data) ?? []
  const isPicked = (name: string | null): name is string => !!name && all.some((b) => b.name === name)
  // A folder's menu says what's checked out. Without a folder, picking a branch is all there is to do with it.
  const current = local.status.data?.branch ?? (!repo.local && isPicked(picked) ? picked : info.data?.default_branch) ?? '…'
  const shown = current === '…' ? null : current
  useEffect(() => {
    // Compared with the tab's, because moving to the repository's other address clears that.
    if (shown && shown !== shownBranch) showBranch(shown)
  }, [shown, shownBranch, showBranch])
  const name = filter.trim().replace(/\s+/g, '-')
  const branches = all.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
  const exists = local.branches.data?.some((b) => b.name === name)

  const label = (
    <>
      <GitBranchIcon />
      <span className="ws-seg-text">
        <span className="ws-seg-key">{repo.local ? 'Current branch' : current === info.data?.default_branch ? 'Default branch' : 'Branch'}</span>
        <span className="ws-seg-value">{current}</span>
      </span>
    </>
  )
  if (!repo.local && !repo.github) return <div className="ws-seg ws-seg-branch">{label}</div>
  return (
    <>
      <ActionMenu open={open} onOpenChange={setOpen}>
        <ActionMenu.Anchor>
          <button type="button" className="ws-seg ws-seg-branch" aria-label={`Current branch: ${current}`}>
            {label}
            <TriangleDownIcon />
          </button>
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium">
          <div className="ws-menu-filter">
            <TextInput block autoFocus aria-label={repo.local ? 'Filter or name a new branch' : 'Filter branches'} placeholder={repo.local ? 'Filter or name a new branch' : 'Filter branches'} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <ActionList selectionVariant="single" className="ws-menu-list">
            {branches.map((b) => (
              <ActionList.Item
                key={b.name}
                selected={b.name === current}
                onSelect={() => {
                  // What's checked out is what the page should show from here on.
                  setPicked(repo.local ? null : b.name)
                  if (repo.local && !b.current) local.switchBranch(b.name)
                  setFilter('')
                }}
              >
                {b.name}
                <ActionList.Description variant="block">
                  {!repo.local ? (b.name === info.data?.default_branch ? 'Default branch' : 'On GitHub') : [b.location === 'remote' ? 'Only on GitHub' : b.location === 'local' ? 'Only on this Mac' : 'On this Mac and GitHub', b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' · ')}
                </ActionList.Description>
              </ActionList.Item>
            ))}
            {repo.local && name && !exists && (
              <>
                {branches.length > 0 && <ActionList.Divider />}
                <ActionList.Item
                  onSelect={() => {
                    setPicked(null)
                    local.op.mutate(() => local.git!.createBranch(name))
                    setFilter('')
                  }}
                >
                  Create branch {name}
                </ActionList.Item>
              </>
            )}
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {local.error && <Banner className="ws-error" variant="critical" title="Git said" description={local.error} onDismiss={local.clearError} />}
    </>
  )
}

function SyncButton({ repo }: { repo: WorkspaceRepo }) {
  const local = useLocalRepo(repo.local)
  const [publishing, setPublishing] = useState(false)
  const [cloning, setCloning] = useState(false)
  const action = syncAction(repo.location, local.status.data)
  const [fetched, setFetched] = useState<Date | null>(null)
  if (!action) return <div className="ws-seg ws-seg-sync" />
  const run = () => {
    const { git, op } = local
    if (action.kind === 'clone') return setCloning(true)
    if (action.kind === 'publish-repo') return setPublishing(true)
    op.mutate(async () => {
      if (action.kind === 'publish-branch') await git!.publishBranch()
      else if (action.kind === 'pull') await git!.pull()
      else if (action.kind === 'push') await git!.push()
      else await git!.fetch()
      setFetched(new Date())
    })
  }
  const hint = local.op.isPending ? 'Working…' : repo.location === 'github' ? 'Not on this Mac yet' : repo.location === 'local' ? 'Not on GitHub yet' : action.kind === 'publish-branch' ? 'Only on this Mac' : fetched ? `Synced at ${fetched.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not synced this session'
  return (
    <>
      <button type="button" className="ws-seg ws-seg-sync" disabled={local.op.isPending} onClick={run}>
        <SyncIcon />
        <span className="ws-seg-text">
          <span className="ws-seg-key">{hint}</span>
          <span className="ws-seg-value">{SYNC_LABEL[action.kind]}</span>
        </span>
        {action.count > 0 && (
          <span className="ws-seg-count">
            {action.kind === 'pull' ? '↓' : '↑'} {action.count}
          </span>
        )}
      </button>
      {publishing && repo.local && <PublishDialog repo={repo} onClose={() => setPublishing(false)} />}
      {cloning && repo.github && <CloneDialog initial={`${repo.github.owner}/${repo.github.repo}`} onClose={() => setCloning(false)} onCloned={() => setCloning(false)} />}
      {local.error && <Banner className="ws-error" variant="critical" title="Git said" description={local.error} onDismiss={local.clearError} />}
    </>
  )
}

/** Puts a folder that isn't on GitHub yet there: a new repository, then origin, then this branch. */
export function PublishDialog({ repo, onClose }: { repo: WorkspaceRepo; onClose(): void }) {
  const { octokit, account } = useGitHub()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const local = useLocalRepo(repo.local)
  const [name, setName] = useState(repo.name)
  const [isPrivate, setPrivate] = useState(true)
  const publish = useMutation({
    mutationFn: async () => {
      const { data } = await octokit.rest.repos.createForAuthenticatedUser({ name: name.trim(), private: isPrivate })
      await local.git!.addOrigin(`https://${account.host}/${data.full_name}.git`)
      await local.git!.publishBranch()
      return data
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
      local.refresh()
      onClose()
      navigate(`/${data.full_name}`, { replace: true })
    },
  })
  return (
    <Dialog
      title="Publish to GitHub"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: publish.isPending ? 'Publishing…' : 'Publish repository', buttonType: 'primary', disabled: !name.trim() || publish.isPending, onClick: () => publish.mutate() },
      ]}
    >
      <FormControl>
        <FormControl.Label>Name</FormControl.Label>
        <TextInput block value={name} onChange={(e) => setName(e.target.value)} />
      </FormControl>
      <FormControl className="mt-2">
        <Checkbox checked={isPrivate} onChange={() => setPrivate(!isPrivate)} />
        <FormControl.Label>Keep this repository private</FormControl.Label>
      </FormControl>
      {publish.error && <div className="error-box mt-3">{errorMessage(publish.error)}</div>}
    </Dialog>
  )
}

function Search({ repo }: { repo: WorkspaceRepo | null }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const submit = () => {
    const q = query.trim()
    if (!q) return
    const github = repo?.github
    if (/^[\w.-]+\/[\w.-]+$/.test(q)) navigate(`/${q}`)
    else navigate(`/search?q=${encodeURIComponent(q)}${github ? `&repo=${github.owner}/${github.repo}` : ''}`)
    setQuery('')
    input.current?.blur()
  }
  return (
    <TextInput
      ref={input}
      className="ws-search"
      leadingVisual={SearchIcon}
      placeholder="Search or jump to"
      aria-label="Search or jump to"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') input.current?.blur()
      }}
      trailingVisual={<span className="kbd">/</span>}
    />
  )
}

/** What the page shows, for the link buttons' labels. */
function itemName(section: string, parts: string[]) {
  if (section === 'pull' && parts[3]) return `pull request #${parts[3]}`
  if (section === 'issues' && /^\d+$/.test(parts[3] ?? '')) return `issue #${parts[3]}`
  if (section === 'actions' && parts[3] === 'runs' && parts[4]) return 'workflow run'
  if (section === 'releases' && parts[3] === 'tag' && parts[4]) return `release ${safeDecode(parts[4])}`
  if (section === 'pulls' || section === 'actions' || section === 'issues' || section === 'releases') return section === 'pulls' ? 'pull requests' : section
  return section ? 'page' : 'branch'
}

/** Refetches what the page shows, for when you don't want to wait for it to check again. */
function RefreshButton() {
  const qc = useQueryClient()
  const fetching = useIsFetching() > 0
  return <IconButton size="small" variant="invisible" icon={SyncIcon} className={fetching ? 'ws-refreshing' : undefined} aria-label="Refresh" onClick={() => void qc.invalidateQueries({ type: 'active' })} />
}

function RepoTabs({ repo }: { repo: WorkspaceRepo }) {
  const { pathname } = useLocation()
  const { account, octokit, key } = useGitHub()
  const { isOn } = useFeatures()
  const github = repo.github
  const path = workspacePath(repo, account.host)
  // A second clone has its own page, but its pull requests and runs are the repository's.
  const base = github && github.host.toLowerCase() === account.host.toLowerCase() ? `/${github.owner}/${github.repo}` : null
  const counts = useRepoCounts(github?.owner ?? '', github?.repo ?? '', !!base)
  const info = useRepoQuery(github?.owner ?? '', github?.repo ?? '', !!base)
  const parts = pathname.split('/').filter(Boolean)
  const section = parts[0] === 'local' ? (parts[2] ?? '') : (parts[2] ?? '')
  const failing = useQuery({
    queryKey: [key, 'workspace-failing-runs', github?.owner, github?.repo],
    enabled: !!base,
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async () => (await octokit.rest.actions.listWorkflowRunsForRepo({ owner: github!.owner, repo: github!.repo, per_page: 1 })).data.workflow_runs[0],
  })
  const lastRun = failing.data
  const runMark = lastRun?.status && lastRun.status !== 'completed' ? { glyph: '●', cls: 'ws-run', label: 'A run is in progress' } : lastRun?.conclusion === 'failure' ? { glyph: '✕', cls: 'ws-bad', label: 'The latest run failed' } : lastRun?.conclusion === 'success' ? { glyph: '✓', cls: 'ws-ok', label: 'The latest run passed' } : null
  const local = useLocalRepo(repo.local)
  const changes = local.status.data?.entries.length ?? 0

  const home = path ?? '/'
  // Coming back to Pull requests, Actions, Issues or Releases opens what was open there before.
  const [lastIn, setLastIn] = useState<Record<string, string>>({})
  const group = ['pulls', 'pull', 'compare'].includes(section) ? 'pulls' : section
  useEffect(() => {
    if (base && ['pulls', 'actions', 'issues', 'releases'].includes(group)) setLastIn((m) => (m[group] === pathname ? m : { ...m, [group]: pathname }))
  }, [base, group, pathname])
  const tabTo = (g: string, fallback: string) => lastIn[g] ?? fallback
  // The tab you're on is already open: clicking it again leaves the page as it is.
  const stay = (current: boolean) => (e: React.MouseEvent) => {
    if (current) e.preventDefault()
  }
  // The Branch tab links to the commit picked in it, from its own pane, not from here.
  const link = base && section ? webUrl(account.host, pathname) : null
  const name = itemName(section, parts)
  // Every page the repository has is one click away, so none hides behind a More menu.
  const more: Array<{ label: string; to: string; show: boolean; current: string[] }> = base
    ? [
        { label: 'Code', to: `${base}/tree/${info.data?.default_branch ?? 'HEAD'}`, show: true, current: ['tree', 'blob', 'blame', 'commits', 'commit', 'branches', 'tags'] },
        { label: 'Issues', to: `${base}/issues`, show: isOn('issues'), current: ['issues'] },
        { label: 'Releases', to: `${base}/releases`, show: true, current: ['releases'] },
        { label: 'Discussions', to: `${base}/discussions`, show: isOn('discussions') && !!info.data?.has_discussions, current: ['discussions'] },
        { label: 'Projects', to: `${base}/projects`, show: isOn('projects'), current: ['projects'] },
        { label: 'Wiki', to: `${base}/wiki`, show: isOn('wiki') && !!info.data?.has_wiki, current: ['wiki'] },
        { label: 'Security', to: `${base}/security`, show: isOn('security'), current: ['security'] },
        { label: 'Insights', to: `${base}/pulse`, show: isOn('insights'), current: ['pulse', 'graphs'] },
        { label: 'Repository settings', to: `${base}/settings`, show: isOn('repoSettings') && !!info.data?.permissions?.admin, current: ['settings'] },
      ]
    : []
  return (
    <nav className="ws-tabs" aria-label="Repository">
      <Link className="ws-tab" to={home} aria-current={section === '' ? 'page' : undefined} onClick={stay(section === '')}>
        Branch
        {changes > 0 && (
          <span className="ws-pill" title={plural(changes, 'changed file')}>
            {changes}
          </span>
        )}
      </Link>
      <Link className="ws-tab" to={base ? tabTo('pulls', `${base}/pulls`) : `${home}/pulls`} aria-current={group === 'pulls' ? 'page' : undefined} onClick={stay(group === 'pulls')}>
        Pull requests
        {counts.data && counts.data.pulls > 0 && <span className="ws-pill" title={plural(counts.data.pulls, 'open pull request')}>{counts.data.pulls}</span>}
      </Link>
      <Link className="ws-tab" to={base ? tabTo('actions', `${base}/actions`) : `${home}/actions`} aria-current={section === 'actions' ? 'page' : undefined} onClick={stay(section === 'actions')}>
        Actions
        {runMark && (
          <span className={`ws-mark ${runMark.cls}`} title={runMark.label}>
            {runMark.glyph}
          </span>
        )}
      </Link>
      {more
        .filter((m) => m.show)
        .map((m) => (
          <Link key={m.label} className="ws-tab" to={tabTo(m.current[0], m.to)} aria-current={m.current.includes(section) ? 'page' : undefined} onClick={stay(m.current.includes(section))}>
            {m.label}
            {m.label === 'Issues' && counts.data && counts.data.issues > 0 && <span className="ws-pill" title={plural(counts.data.issues, 'open issue')}>{counts.data.issues}</span>}
          </Link>
        ))}
      <div className="ws-tabs-end">
        <RefreshButton />
        {link && (
          <>
            <CopyButton text={link} icon={LinkIcon} label={`Copy link to ${name}`} />
            <IconButton size="small" variant="invisible" icon={LinkExternalIcon} aria-label={`Open ${name} in browser`} onClick={() => openExternal(link)} />
          </>
        )}
        {repo.local && (
          <>
            <button type="button" className="ws-tab" onClick={() => void native!.openInEditor(repo.local!.id)}>
              Open in editor
            </button>
            <button type="button" className="ws-tab" onClick={() => void native!.revealInFinder(repo.local!.id)}>
              Show in Finder
            </button>
          </>
        )}
      </div>
    </nav>
  )
}

/** The desktop app's header: what the repository is doing, then where you are in it. */
export function WorkspaceHeader() {
  const repo = useCurrentRepo()
  const agent = useAgent()
  const { account } = useGitHub()
  const navigate = useNavigate()
  const [cloning, setCloning] = useState(false)
  // A folder's tab goes by the folder on all of its pages, not only the one that names it.
  useTabTitle(repo?.name)
  const content = useMemo(() => repo && <RepoTabs key={repo.key} repo={repo} />, [repo])
  return (
    <header className="ws-header">
      <div className="ws-toolbar">
        {repo && (
          <>
            <BranchMenu key={`branch-${repo.key}`} repo={repo} />
            <SyncButton key={`sync-${repo.key}`} repo={repo} />
            {repo.github && repo.github.host.toLowerCase() === account.host.toLowerCase() && <TabItemPicker owner={repo.github.owner} repo={repo.github.repo} />}
          </>
        )}
        <div className="ws-toolbar-end">
          <Search repo={repo} />
          {/* Inside a repository the sync button offers what applies: Clone, or Publish for a folder not on GitHub. */}
          {!repo && (
            <button type="button" className="ws-tool" onClick={() => setCloning(true)}>
              <RepoCloneIcon /> Clone
            </button>
          )}
          <InboxMenu />
          <AgentOnly><button type="button" className="ws-tool" aria-pressed={agent.open} onClick={agent.toggle}>
            <SparkleFillIcon /> Claude
          </button></AgentOnly>
          <AccountMenu />
        </div>
      </div>
      {content}
      {cloning && <CloneDialog initial="" onClose={() => setCloning(false)} onCloned={(r) => navigate(`/local/${r.id}`)} />}
    </header>
  )
}
