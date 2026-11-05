import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnchoredOverlay, Button, TextInput } from '@primer/react'
import { DeviceDesktopIcon, MarkGithubIcon, PlusIcon, RepoIcon, XIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../lib/github'
import { webUrl } from '../lib/links'
import { native, openExternal } from '../lib/platform'
import { useTabs } from '../lib/TabsProvider'
import { githubKey, useWorkspaceRepos, workspacePath, type WorkspaceRepo } from '../lib/workspace'

const WHERE: Record<WorkspaceRepo['location'], string> = { both: 'On this Mac and GitHub', local: 'Only on this Mac', github: 'On GitHub' }

/** The + at the end of the tab strip: every repository the workspace knows, and the ways to add another. */
export function RepoPicker() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      anchorRef={anchor}
      renderAnchor={(props) => (
        <button {...props} ref={anchor} type="button" className="tab-new ws-tab-add" aria-label="Open a repository" title="Open a repository">
          <PlusIcon />
        </button>
      )}
      width="medium"
      focusZoneSettings={{ disabled: true }}
    >
      {open && <RepoPickerPanel onDone={() => setOpen(false)} />}
    </AnchoredOverlay>
  )
}

export function RepoPickerPanel({ onDone }: { onDone(): void }) {
  const { octokit, key, account } = useGitHub()
  const tabs = useTabs()
  const qc = useQueryClient()
  const { repos, removeGitHubRepo } = useWorkspaceRepos()
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mine = useQuery({
    queryKey: [key, 'workspace-your-repos'],
    staleTime: 5 * 60_000,
    queryFn: async () => (await octokit.rest.repos.listForAuthenticatedUser({ sort: 'pushed', per_page: 100 })).data,
  })

  const go = (path: string) => {
    // A blank tab has nothing to lose, so the repository takes it over.
    if (tabs.active.url === '/') void tabs.activeRouter().navigate(path)
    else tabs.open(path)
    onDone()
  }
  const q = filter.trim().toLowerCase()
  const matches = (text: string) => text.toLowerCase().includes(q)
  const known = repos.filter((r) => matches(r.github ? `${r.github.owner}/${r.github.repo}` : r.name))
  const here = known.filter((r) => r.local)
  const remote = known.filter((r) => !r.local)
  const knownKeys = new Set(repos.filter((r) => r.github).map((r) => githubKey(r.github!)))
  const others = (mine.data ?? []).filter((r) => matches(r.full_name) && !knownKeys.has(githubKey({ host: account.host, owner: r.owner.login, repo: r.name }))).slice(0, 30)
  const typed = /^[\w.-]+\/[\w.-]+$/.test(filter.trim()) && !known.length && !others.length ? filter.trim() : null

  const row = (repo: WorkspaceRepo) => {
    const path = workspacePath(repo, account.host)
    return (
      <div key={repo.key} className="ws-picker-row">
        <button type="button" className="ws-picker-main" disabled={!path} onClick={() => path && go(path)}>
          {repo.local ? <DeviceDesktopIcon /> : <MarkGithubIcon />}
          <span className="ws-picker-text">
            <span className="ws-picker-name">{repo.github ? `${repo.github.owner}/${repo.github.repo}` : repo.name}</span>
            <span className="ws-picker-sub">{path ? WHERE[repo.location] : `Sign in to ${repo.github?.host} to open this`}</span>
          </span>
        </button>
        {!repo.local && (
          <button type="button" className="ws-picker-remove" aria-label={`Remove ${repo.name} from this list`} title="Remove from this list" onClick={() => removeGitHubRepo(repo.key)}>
            <XIcon size={12} />
          </button>
        )}
      </div>
    )
  }

  const addFolder = async () => {
    setError(null)
    const dir = await native!.pickDirectory('Choose a local git repository')
    if (!dir) return
    try {
      const repo = await native!.repos.add(dir)
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      go(`/local/${repo.id}`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  // The strip keeps focus on the page by cancelling mouse presses; this panel has a field that needs them.
  return (
    <div className="ws-picker" onMouseDown={(e) => e.stopPropagation()}>
      <div className="ws-picker-filter">
        <TextInput block autoFocus aria-label="Filter repositories" placeholder="Filter repositories or type owner/name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="ws-picker-list">
        {here.length > 0 && <div className="ws-picker-heading">On this Mac</div>}
        {here.map(row)}
        {remote.length > 0 && <div className="ws-picker-heading">On GitHub</div>}
        {remote.map(row)}
        {others.length > 0 && <div className="ws-picker-heading">Your repositories</div>}
        {others.map((r) => (
          <div key={r.id} className="ws-picker-row">
            <button type="button" className="ws-picker-main" onClick={() => go(`/${r.full_name}`)}>
              <RepoIcon />
              <span className="ws-picker-text">
                <span className="ws-picker-name">{r.full_name}</span>
              </span>
            </button>
          </div>
        ))}
        {typed && (
          <div className="ws-picker-row">
            <button type="button" className="ws-picker-main" onClick={() => go(`/${typed}`)}>
              <RepoIcon />
              <span className="ws-picker-text">
                <span className="ws-picker-name">Open {typed}</span>
              </span>
            </button>
          </div>
        )}
      </div>
      {error && <div className="error-box" style={{ margin: 8 }}>{error}</div>}
      <div className="ws-picker-actions">
        <Button size="small" onClick={() => void addFolder()}>
          Add local folder
        </Button>
        <Button
          size="small"
          onClick={() => {
            openExternal(webUrl(account.host, '/new'))
            onDone()
          }}
        >
          New
        </Button>
      </div>
    </div>
  )
}
