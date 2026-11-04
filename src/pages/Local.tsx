import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, Checkbox, Dialog, FormControl, IconButton, NavList, RelativeTime, SegmentedControl, TextInput, Textarea, UnderlineNav, useConfirm } from '@primer/react'
import {
  DeviceDesktopIcon,
  RepoIcon,
  PlusIcon,
  GitBranchIcon,
  TriangleDownIcon,
  SyncIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  FileDirectoryIcon,
  TrashIcon,
  SparkleFillIcon,
  CodeIcon,
  HistoryIcon,
  FileDiffIcon,
  MarkGithubIcon,
  UndoIcon,
  RepoPushIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../lib/github'
import { native, type LocalRepo } from '../lib/platform'
import { parseRemote } from '../lib/links'
import { changePaths, isStaged, isUnmerged, localGit, type StatusEntry } from '../lib/git'
import type { FileDiff } from '../lib/diff'
import { firstLine, shortSha } from '../lib/format'
import { readPref, writePref } from '../lib/storage'
import { generateCommitMessage } from '../lib/agent/oneshot'
import { useAgentPageContext } from '../lib/agent/AgentProvider'
import { useEffectOnChange } from '../lib/activity'
import { FileDiffBox } from '../components/DiffView'
import { Blankslate, ErrorBox, Loading } from '../components/Bits'

export function LocalReposPage() {
  if (!native) {
    return (
      <div className="container-lg">
        <Blankslate icon={<DeviceDesktopIcon size={32} />} title="Local repositories need the desktop app">
          Cloning, committing and pushing local repositories works in the gh-ui desktop app (npm run electron:dev or a packaged build). Everything else works here in the browser.
        </Blankslate>
      </div>
    )
  }
  return <LocalShell />
}

function useLocalRepos() {
  return useQuery({ queryKey: ['local-repos'], queryFn: () => native!.repos.list() })
}

function LocalShell() {
  const { id } = useParams()
  const repos = useLocalRepos()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const cloneTarget = params.get('clone')
  const [error, setError] = useState<string | null>(null)
  const selected = repos.data?.find((r) => r.id === id) ?? null

  useEffect(() => {
    if (!id && repos.data?.length) {
      const last = readPref<string | null>('lastLocalRepo', null)
      const target = repos.data.find((r) => r.id === last) ?? repos.data[0]
      // Keep the query so a `?clone=` request (header menu, Code page) still opens the dialog.
      navigate({ pathname: `/local/${target.id}`, search: params.toString() ? `?${params}` : '' }, { replace: true })
    }
  }, [id, repos.data, navigate, params])

  const add = async () => {
    setError(null)
    const dir = await native!.pickDirectory('Choose a local git repository')
    if (!dir) return
    try {
      const repo = await native!.repos.add(dir)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      navigate(`/local/${repo.id}`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="desktop-layout">
      <div className="desktop-sidebar">
        <div className="flex-center gap-2" style={{ padding: 12, borderBottom: '1px solid var(--borderColor-default)' }}>
          <span className="text-bold flex-1">Local repositories</span>
          <ActionMenu>
            <ActionMenu.Anchor>
              <IconButton size="small" icon={PlusIcon} aria-label="Add repository" />
            </ActionMenu.Anchor>
            <ActionMenu.Overlay>
              <ActionList>
                <ActionList.Item onSelect={() => setParams({ clone: '' })}>Clone repository…</ActionList.Item>
                <ActionList.Item onSelect={() => void add()}>Add existing repository…</ActionList.Item>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </div>
        {error && <div className="error-box" style={{ margin: 8 }}>{error}</div>}
        <div className="desktop-file-list">
          {repos.isLoading ? (
            <Loading />
          ) : repos.data?.length ? (
            <NavList aria-label="Local repositories">
              {repos.data.map((r) => (
                <NavList.Item key={r.id} as={Link} to={`/local/${r.id}`} aria-current={r.id === id ? 'page' : undefined}>
                  <NavList.LeadingVisual>
                    <RepoIcon />
                  </NavList.LeadingVisual>
                  {r.name}
                  <NavList.Description variant="block">{r.path}</NavList.Description>
                </NavList.Item>
              ))}
            </NavList>
          ) : (
            <div className="p-3 fg-muted text-small">No local repositories yet. Clone one from GitHub or add a folder that already contains a git repository.</div>
          )}
        </div>
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {selected ? (
          <LocalRepoView key={selected.id} repo={selected} />
        ) : (
          <Blankslate
            icon={<DeviceDesktopIcon size={32} />}
            title="Work on your code locally"
            action={
              <span className="flex-center gap-2" style={{ justifyContent: 'center' }}>
                <Button variant="primary" onClick={() => setParams({ clone: '' })}>
                  Clone a repository
                </Button>
                <Button onClick={() => void add()}>Add an existing repository</Button>
              </span>
            }
          >
            Review and commit changes, switch branches and push — then open a pull request with the agent's help.
          </Blankslate>
        )}
      </div>
      {cloneTarget !== null && <CloneDialog initial={cloneTarget} onClose={() => setParams({})} onCloned={(r) => navigate(`/local/${r.id}`)} />}
    </div>
  )
}

function CloneDialog({ initial, onClose, onCloned }: { initial: string; onClose(): void; onCloned(r: LocalRepo): void }) {
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const [filter, setFilter] = useState(initial)
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(() => readPref('cloneParent', ''))
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mine = useQuery({
    queryKey: [key, 'clone-repos'],
    queryFn: async () => (await octokit.rest.repos.listForAuthenticatedUser({ sort: 'pushed', per_page: 100 })).data,
  })
  useEffectOnChange(() => {
    if (initial && /^[\w.-]+\/[\w.-]+$/.test(initial)) {
      setUrl(`https://${account.host}/${initial}.git`)
      setName(initial.split('/')[1])
    }
  }, [initial, account.host])

  const clone = useMutation({
    mutationFn: async () => native!.repos.clone(url, parent, name, { token: account.token, host: account.host }),
    onSuccess: async (r) => {
      writePref('cloneParent', parent)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      onCloned(r)
      onClose()
    },
    onError: (e) => setError(errorMessage(e)),
  })
  const shown = (mine.data ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase())).slice(0, 50)
  return (
    <Dialog
      title="Clone a repository"
      width="xlarge"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: clone.isPending ? 'Cloning…' : 'Clone', buttonType: 'primary', onClick: () => clone.mutate(), disabled: !url || !parent || !name || clone.isPending },
      ]}
    >
      <TextInput block placeholder="Filter your repositories" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
      <div className="Box mt-2" style={{ maxHeight: 240, overflow: 'auto' }}>
        {mine.isLoading ? (
          <Loading />
        ) : (
          shown.map((r) => (
            <div
              key={r.id}
              className={`Box-row hoverable ${url === r.clone_url ? 'selected' : ''}`}
              style={{ cursor: 'pointer', alignItems: 'center' }}
              onClick={() => {
                setUrl(r.clone_url)
                setName(r.name)
              }}
            >
              <RepoIcon /> <span className="flex-1">{r.full_name}</span>
            </div>
          ))
        )}
      </div>
      <FormControl className="mt-3">
        <FormControl.Label>Repository URL</FormControl.Label>
        <TextInput block value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" />
      </FormControl>
      <FormControl className="mt-2">
        <FormControl.Label>Local path</FormControl.Label>
        <div className="flex gap-2 w-100">
          <TextInput className="flex-1" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Choose a parent folder" />
          <Button
            leadingVisual={FileDirectoryIcon}
            onClick={async () => {
              const dir = await native!.pickDirectory('Choose where to clone')
              if (dir) setParent(dir)
            }}
          >
            Choose…
          </Button>
        </div>
      </FormControl>
      <FormControl className="mt-2">
        <FormControl.Label>Folder name</FormControl.Label>
        <TextInput block value={name} onChange={(e) => setName(e.target.value)} />
      </FormControl>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}

function LocalRepoView({ repo }: { repo: LocalRepo }) {
  const { account } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [split, setSplit] = useState(() => readPref('diffSplit', false))
  const auth = { token: account.token, host: account.host }

  useEffect(() => writePref('lastLocalRepo', repo.id), [repo.id])

  const git = localGit(repo.id, auth)

  const status = useQuery({
    queryKey: ['local-status', repo.id],
    queryFn: () => git.status(),
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  })
  const remote = useQuery({
    queryKey: ['local-remote', repo.id],
    queryFn: async () => {
      const url = await git.remoteUrl()
      return url ? parseRemote(url) : null
    },
  })
  const branches = useQuery({
    queryKey: ['local-branches', repo.id],
    queryFn: () => git.branchNames(),
  })

  const entry = status.data?.entries.find((e) => e.path === selectedPath) ?? null
  const diff = useQuery({
    queryKey: ['local-diff', repo.id, selectedPath, entry?.index, entry?.worktree],
    enabled: !!entry,
    queryFn: () => (entry ? git.fileDiff(entry) : null),
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['local-status', repo.id] })
    void qc.invalidateQueries({ queryKey: ['local-diff', repo.id] })
    void qc.invalidateQueries({ queryKey: ['local-branches', repo.id] })
    void qc.invalidateQueries({ queryKey: ['local-log', repo.id] })
  }

  const op = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => (setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  })

  const entries = status.data?.entries ?? []
  const stagedCount = entries.filter(isStaged).length
  const conflictCount = entries.filter(isUnmerged).length
  const st = status.data

  const generate = useMutation({
    mutationFn: async () => {
      const staged = await git.stagedDiff()
      if (!staged.trim()) throw new Error('Stage some changes first.')
      return generateCommitMessage(staged, account)
    },
    onSuccess: (m) => {
      setSummary(m.summary)
      setDescription(m.description)
    },
    onError: (e) => setError(errorMessage(e)),
  })

  useAgentPageContext({
    label: `local repository ${repo.name} at ${repo.path}${remote.data ? ` (GitHub: ${remote.data.owner}/${remote.data.repo})` : ''}`,
    owner: remote.data?.owner,
    repo: remote.data?.repo,
    details: { branch: st?.branch, ahead: st?.ahead, behind: st?.behind, changed_files: entries.length, note: 'Agent GitHub tools see only pushed code, not local changes.' },
  })

  const networkButton = () => {
    if (!st) return null
    if (!st.upstream)
      return (
        <Button leadingVisual={RepoPushIcon} loading={op.isPending} onClick={() => op.mutate(() => git.publishBranch())}>
          Publish branch
        </Button>
      )
    if (st.behind > 0)
      return (
        <Button leadingVisual={ArrowDownIcon} loading={op.isPending} onClick={() => op.mutate(() => git.pull())}>
          Pull origin <span className="counter">{st.behind}</span>
        </Button>
      )
    if (st.ahead > 0)
      return (
        <Button leadingVisual={ArrowUpIcon} loading={op.isPending} onClick={() => op.mutate(() => git.push())}>
          Push origin <span className="counter">{st.ahead}</span>
        </Button>
      )
    return (
      <Button leadingVisual={SyncIcon} loading={op.isPending} onClick={() => op.mutate(() => git.fetch())}>
        Fetch origin
      </Button>
    )
  }

  return (
    <>
      <div className="desktop-toolbar">
        <div className="desktop-toolbar-item" style={{ minWidth: 220 }}>
          <RepoIcon />
          <div style={{ minWidth: 0 }}>
            <div className="text-small fg-muted">Current repository</div>
            <div className="text-bold text-truncate">{repo.name}</div>
          </div>
        </div>
        <div className="desktop-toolbar-item">
          <GitBranchIcon />
          <BranchMenu current={st?.branch ?? '…'} branches={branches.data ?? []} onSwitch={(b) => op.mutate(() => git.switchTo(b))} onCreate={(b) => op.mutate(() => git.createBranch(b))} />
        </div>
        <div className="desktop-toolbar-item">{networkButton()}</div>
        <div className="desktop-toolbar-item ml-auto" style={{ borderRight: 0, borderLeft: '1px solid var(--borderColor-default)' }}>
          {remote.data && (
            <>
              <IconButton description="Open repository in gh-ui" as={Link} to={`/${remote.data.owner}/${remote.data.repo}`} icon={MarkGithubIcon} aria-label="Open repository in gh-ui" />
              {st?.branch && st.upstream && (
                <IconButton description="Create pull request for this branch" as={Link} to={`/${remote.data.owner}/${remote.data.repo}/compare/${encodeURIComponent(st.branch)}`} icon={GitPullRequestIcon} aria-label="Create pull request" />
              )}
            </>
          )}
          <IconButton description="Open in editor" icon={CodeIcon} aria-label="Open in editor" onClick={() => void native!.openInEditor(repo.id)} />
          <IconButton description="Show in file manager" icon={FileDirectoryIcon} aria-label="Show in file manager" onClick={() => void native!.revealInFinder(repo.id)} />
          <IconButton description="Remove from gh-ui (files stay on disk)"
              icon={TrashIcon}
              aria-label="Remove repository from list"
              onClick={async () => {
                if (await confirm({ title: `Remove ${repo.name}?`, content: 'It is removed from gh-ui only; the folder stays on disk.', confirmButtonContent: 'Remove' })) {
                  await native!.repos.remove(repo.id)
                  void qc.invalidateQueries({ queryKey: ['local-repos'] })
                }
              }}
            />
        </div>
      </div>
      {error && <div className="error-box" style={{ margin: 8, whiteSpace: 'pre-wrap' }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', flex: 1, minHeight: 0 }}>
        <div className="desktop-sidebar">
          <UnderlineNav aria-label="Local view">
            <UnderlineNav.Item as="button" icon={FileDiffIcon} counter={entries.length} aria-current={tab === 'changes' ? 'page' : undefined} onSelect={() => setTab('changes')}>
              Changes
            </UnderlineNav.Item>
            <UnderlineNav.Item as="button" icon={HistoryIcon} aria-current={tab === 'history' ? 'page' : undefined} onSelect={() => setTab('history')}>
              History
            </UnderlineNav.Item>
          </UnderlineNav>
          {tab === 'changes' ? (
            <>
              <div className="desktop-file" style={{ cursor: 'default', background: 'var(--bgColor-muted)' }}>
                <Checkbox
                  checked={entries.length > 0 && stagedCount === entries.length}
                  indeterminate={stagedCount > 0 && stagedCount < entries.length}
                  onChange={async () => {
                    if (stagedCount === entries.length) return op.mutate(() => git.unstageAll())
                    if (
                      conflictCount &&
                      !(await confirm({
                        title: 'Mark conflicts as resolved?',
                        content: `Staging all changes also marks ${conflictCount} conflicted file${conflictCount === 1 ? '' : 's'} as resolved. Make sure no conflict markers are left.`,
                        confirmButtonContent: 'Stage all',
                      }))
                    )
                      return
                    op.mutate(() => git.stageAll())
                  }}
                  aria-label="Stage all"
                />
                <span className="text-small">
                  {entries.length} changed file{entries.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="desktop-file-list">
                {status.error ? (
                  <div className="p-3">
                    <ErrorBox error={status.error} />
                  </div>
                ) : (
                  entries.map((e) => (
                    <div key={e.path} className={`desktop-file ${selectedPath === e.path ? 'selected' : ''}`} onClick={() => setSelectedPath(e.path)}>
                      <span onClick={(ev) => ev.stopPropagation()}>
                        <Checkbox
                          checked={isStaged(e)}
                          aria-label={isUnmerged(e) ? `Mark ${e.path} as resolved` : `Stage ${e.path}`}
                          onChange={() => op.mutate(() => (isStaged(e) ? git.unstage(e) : git.stage(e)))}
                        />
                      </span>
                      <span className="flex-1 text-truncate text-mono" title={e.path} style={{ direction: 'rtl', textAlign: 'left' }}>
                        {e.path}
                      </span>
                      <ChangeBadge e={e} />
                    </div>
                  ))
                )}
              </div>
              <div className="desktop-commit">
                {conflictCount > 0 && (
                  <div className="text-small fg-danger">
                    Resolve {conflictCount} conflicted file{conflictCount === 1 ? '' : 's'} and stage {conflictCount === 1 ? 'it' : 'them'} before committing.
                  </div>
                )}
                <div className="flex gap-1">
                  <TextInput className="flex-1" placeholder="Summary (required)" value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Commit summary" />
                  <IconButton description="Write the message with the agent" icon={SparkleFillIcon} aria-label="Generate commit message" disabled={!stagedCount || conflictCount > 0} onClick={() => generate.mutate()} />
                </div>
                <Textarea block rows={3} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Commit description" />
                <Button
                  variant="primary"
                  block
                  disabled={!summary.trim() || !stagedCount || conflictCount > 0}
                  loading={op.isPending || generate.isPending}
                  onClick={() =>
                    op.mutate(async () => {
                      await git.commit(summary, description)
                      setSummary('')
                      setDescription('')
                    })
                  }
                >
                  Commit {stagedCount ? `${stagedCount} file${stagedCount === 1 ? '' : 's'} ` : ''}to {st?.branch ?? '…'}
                </Button>
              </div>
            </>
          ) : (
            <History repoId={repo.id} />
          )}
        </div>
        <div className="desktop-diff p-3">
          {tab === 'changes' ? (
            entry ? (
              <>
                <div className="flex-center gap-2 mb-2">
                  <SegmentedControl aria-label="Diff layout" size="small" onChange={(i) => (setSplit(i === 1), writePref('diffSplit', i === 1))}>
                    <SegmentedControl.Button selected={!split}>Unified</SegmentedControl.Button>
                    <SegmentedControl.Button selected={split}>Split</SegmentedControl.Button>
                  </SegmentedControl>
                  <Button
                    className="ml-auto"
                    size="small"
                    variant="danger"
                    leadingVisual={UndoIcon}
                    onClick={async () => {
                      const paths = changePaths(entry)
                      const from = paths.length > 1 ? ` (renamed from ${paths[0]})` : ''
                      if (!(await confirm({ title: 'Discard changes?', content: `Your changes to ${entry.path}${from} will be lost.`, confirmButtonType: 'danger', confirmButtonContent: 'Discard' }))) return
                      op.mutate(() => git.discard(entry))
                    }}
                  >
                    Discard changes
                  </Button>
                </div>
                {diff.isLoading ? (
                  <Loading />
                ) : diff.data ? (
                  <LocalFileDiff file={diff.data} split={split} />
                ) : (
                  <div className="fg-muted">No textual changes.</div>
                )}
              </>
            ) : (
              <Blankslate icon={<FileDiffIcon size={32} />} title={entries.length ? 'Select a file to see its diff' : 'No local changes'}>
                {entries.length ? '' : 'There are no uncommitted changes in this repository.'}
              </Blankslate>
            )
          ) : (
            <HistoryDetail repoId={repo.id} split={split} />
          )}
        </div>
      </div>
    </>
  )
}

function ChangeBadge({ e }: { e: StatusEntry }) {
  const code = isUnmerged(e) ? '!' : e.index === '?' ? 'U' : e.index !== ' ' ? e.index : e.worktree
  const color = code === 'A' || code === 'U' ? 'fg-success' : code === 'D' || code === '!' ? 'fg-danger' : code === 'R' ? 'fg-accent' : 'fg-attention'
  return (
    <span className={`text-mono text-small text-bold ${color}`} title={{ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Copied', '!': 'Conflicted' }[code] ?? code}>
      {code}
    </span>
  )
}

function LocalFileDiff({ file, split }: { file: FileDiff; split: boolean }) {
  return (
    <FileDiffBox
      file={{ path: file.newPath, previousPath: file.oldPath !== file.newPath ? file.oldPath : null, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.binary ? null : file.patch }}
      split={split}
    />
  )
}

function BranchMenu({ current, branches, onSwitch, onCreate }: { current: string; branches: string[]; onSwitch(b: string): void; onCreate(b: string): void }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  return (
    <>
      <ActionMenu>
        <ActionMenu.Anchor>
          <Button variant="invisible" trailingVisual={TriangleDownIcon}>
            <span className="text-small fg-muted" style={{ display: 'block', textAlign: 'left' }}>
              Current branch
            </span>
            <span className="text-bold">{current}</span>
          </Button>
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium">
          <ActionList selectionVariant="single">
            <ActionList.Item onSelect={() => setCreating(true)}>
              <ActionList.LeadingVisual>
                <PlusIcon />
              </ActionList.LeadingVisual>
              New branch…
            </ActionList.Item>
            <ActionList.Divider />
            {branches.map((b) => (
              <ActionList.Item key={b} selected={b === current} onSelect={() => b !== current && onSwitch(b)}>
                {b}
              </ActionList.Item>
            ))}
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {creating && (
        <Dialog
          title="Create a branch"
          onClose={() => setCreating(false)}
          footerButtons={[
            { content: 'Cancel', onClick: () => setCreating(false) },
            { content: 'Create branch', buttonType: 'primary', disabled: !name.trim(), onClick: () => (onCreate(name.trim()), setCreating(false), setName('')) },
          ]}
        >
          <FormControl>
            <FormControl.Label>Name</FormControl.Label>
            <TextInput block autoFocus value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '-'))} />
            <FormControl.Caption>Created from {current} and checked out.</FormControl.Caption>
          </FormControl>
        </Dialog>
      )}
    </>
  )
}

function useLog(repoId: string) {
  return useQuery({ queryKey: ['local-log', repoId], queryFn: () => localGit(repoId).log() })
}

function History({ repoId }: { repoId: string }) {
  const log = useLog(repoId)
  const [params, setParams] = useSearchParams()
  const selected = params.get('commit')
  return (
    <div className="desktop-file-list">
      {log.isLoading ? (
        <Loading />
      ) : (
        log.data?.map((c) => (
          <div key={c.sha} className={`desktop-file ${selected === c.sha ? 'selected' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '8px 12px' }} onClick={() => setParams({ commit: c.sha })}>
            <span className="text-bold text-truncate w-100">{firstLine(c.subject)}</span>
            <span className="text-small fg-muted">
              {c.author} · <RelativeTime date={new Date(c.date)} /> · <span className="text-mono">{shortSha(c.sha)}</span>
            </span>
          </div>
        ))
      )}
    </div>
  )
}

function HistoryDetail({ repoId, split }: { repoId: string; split: boolean }) {
  const [params] = useSearchParams()
  const sha = params.get('commit')
  const show = useQuery({
    queryKey: ['local-show', repoId, sha],
    enabled: !!sha,
    queryFn: () => localGit(repoId).show(sha!),
  })
  const files = useMemo(() => show.data?.files ?? [], [show.data])
  if (!sha) return <Blankslate icon={<HistoryIcon size={32} />} title="Select a commit" />
  if (show.isLoading) return <Loading />
  return (
    <>
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--fontStack-sansSerif)', fontSize: 14, marginTop: 0 }} className="text-bold">
        {show.data?.message}
      </pre>
      {files.map((f) => (
        <LocalFileDiff key={f.newPath} file={f} split={split} />
      ))}
    </>
  )
}
