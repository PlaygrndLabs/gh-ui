import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Avatar, Banner, Button, ButtonGroup, CounterLabel, FormControl, IconButton, Label, RelativeTime, SegmentedControl, TextInput, Textarea } from '@primer/react'
import {
  FileDirectoryFillIcon,
  FileIcon,
  FileSubmoduleIcon,
  FileSymlinkFileIcon,
  HistoryIcon,
  GitBranchIcon,
  TagIcon,
  StarIcon,
  StarFillIcon,
  RepoForkedIcon,
  EyeIcon,
  CodeIcon,
  TriangleDownIcon,
  LinkIcon,
  BookIcon,
  PencilIcon,
  SparkleFillIcon,
  DeviceDesktopIcon,
  LinkExternalIcon,
  DownloadIcon,
  LawIcon,
  CopyIcon,
  CheckIcon,
  SearchIcon,
  GearIcon,
} from '@primer/octicons-react'
import { useGitHub, decodeBase64, encodeBase64, errorMessage } from '../../lib/github'
import { useRepo, useRefPath, encodePath } from '../../lib/repo'
import { compactNumber, copyText, firstLine, formatBytes, shortSha, plural } from '../../lib/format'
import { highlightLines, languageFor } from '../../lib/highlight'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { isNative, openExternal } from '../../lib/platform'
import { appPathFromUrl, webUrl } from '../../lib/links'
import { contentElementById } from '../../lib/scroll'
import { useEffectOnChange } from '../../lib/activity'
import { BranchPicker } from '../../components/BranchPicker'
import { Markdown } from '../../components/Markdown'
import { CommitHeadline, CopyButton, ErrorBox, Loading, UserAvatar } from '../../components/Bits'
import { RepoDetailsDialog } from './settings/RepoDetailsDialog'
import { useIsFocusedPane } from '../../lib/TabsProvider'

function RepoTitle() {
  const { owner, repo, data } = useRepo()
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const starred = useQuery({
    queryKey: [key, 'starred', owner, repo],
    queryFn: async () => {
      try {
        await octokit.rest.activity.checkRepoIsStarredByAuthenticatedUser({ owner, repo })
        return true
      } catch {
        return false
      }
    },
  })
  // REST has no archive date; github.com's banner names it.
  const archivedAt = useQuery({
    queryKey: [key, 'repo-archived-at', owner, repo],
    enabled: data.archived,
    staleTime: Infinity,
    queryFn: async () => {
      const res: { repository: { archivedAt: string | null } } = await octokit.graphql(`query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ archivedAt } }`, { owner, repo })
      return res.repository.archivedAt
    },
  })
  const toggleStar = useMutation({
    mutationFn: async () => {
      if (starred.data) await octokit.rest.activity.unstarRepoForAuthenticatedUser({ owner, repo })
      else await octokit.rest.activity.starRepoForAuthenticatedUser({ owner, repo })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [key, 'starred', owner, repo] })
      void qc.invalidateQueries({ queryKey: [key, 'repo', owner, repo] })
    },
  })
  const visibility = data.private ? 'Private' : data.visibility === 'internal' ? 'Internal' : 'Public'
  return (
    <>
      {data.archived && (
        <Banner
          className="mb-3"
          variant="warning"
          hideTitle
          title="Archived repository"
          description={
            <>
              This repository was archived by the owner
              {archivedAt.data && <> on {new Date(archivedAt.data).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>}. It is now read-only.
            </>
          }
        />
      )}
      <div className="repo-title" style={{ padding: '0 0 16px', borderBottom: '1px solid var(--borderColor-muted)', marginBottom: 16 }}>
        <Avatar src={data.owner.avatar_url} size={24} square={data.owner.type === 'Organization'} />
        <h1>
          <strong>
            <Link to={`/${owner}/${repo}`} className="fg-default">
              {repo}
            </Link>
          </strong>
        </h1>
        {/* github.com shows one label: "Public archive" replaces "Public" on an archived repository. */}
        {data.archived ? <Label variant="attention">{visibility} archive</Label> : <Label>{visibility}</Label>}
        {data.fork && data.parent && (
          <span className="text-small fg-muted">
            forked from <Link to={`/${data.parent.full_name}`}>{data.parent.full_name}</Link>
          </span>
        )}
        <div className="repo-actions">
          <Button size="small" leadingVisual={EyeIcon} onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/subscription`))}>
            Watch <CounterLabel>{compactNumber(data.subscribers_count)}</CounterLabel>
          </Button>
          <Button size="small" leadingVisual={RepoForkedIcon} onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/fork`))}>
            Fork <CounterLabel>{compactNumber(data.forks_count)}</CounterLabel>
          </Button>
          <Button size="small" leadingVisual={starred.data ? StarFillIcon : StarIcon} loading={toggleStar.isPending} onClick={() => toggleStar.mutate()}>
            {starred.data ? 'Starred' : 'Star'} <CounterLabel>{compactNumber(data.stargazers_count)}</CounterLabel>
          </Button>
        </div>
      </div>
    </>
  )
}

function CloneMenu() {
  const { owner, repo, data } = useRepo()
  const navigate = useNavigate()
  const [tab, setTab] = useState(0)
  const urls = [data.clone_url, data.ssh_url, `gh repo clone ${owner}/${repo}`]
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <Button variant="primary" leadingVisual={CodeIcon} trailingVisual={TriangleDownIcon}>
          Code
        </Button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="large" align="end">
        <div style={{ padding: 16 }}>
          <div className="text-bold mb-2">Clone</div>
          <SegmentedControl aria-label="Clone protocol" size="small" onChange={setTab}>
            <SegmentedControl.Button selected={tab === 0}>HTTPS</SegmentedControl.Button>
            <SegmentedControl.Button selected={tab === 1}>SSH</SegmentedControl.Button>
            <SegmentedControl.Button selected={tab === 2}>GitHub CLI</SegmentedControl.Button>
          </SegmentedControl>
          <div className="flex-center gap-1 mt-2">
            <TextInput block readOnly value={urls[tab]} className="text-mono" onFocus={(e) => e.target.select()} aria-label="Clone URL" />
            <CopyButton text={urls[tab]} label="Copy clone URL" size="medium" />
          </div>
        </div>
        <ActionList>
          <ActionList.Divider />
          {isNative && (
            <ActionList.Item onSelect={() => navigate(`/local?clone=${encodeURIComponent(`${owner}/${repo}`)}`)}>
              <ActionList.LeadingVisual>
                <DeviceDesktopIcon />
              </ActionList.LeadingVisual>
              Clone to this computer
            </ActionList.Item>
          )}
          <ActionList.Item onSelect={() => openExternal(`https://${new URL(data.html_url).host}/${owner}/${repo}/archive/refs/heads/${data.default_branch}.zip`)}>
            <ActionList.LeadingVisual>
              <DownloadIcon />
            </ActionList.LeadingVisual>
            Download ZIP
          </ActionList.Item>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

function useCommitCount(owner: string, repo: string, ref: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'commit-count', owner, repo, ref],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await octokit.rest.repos.listCommits({ owner, repo, sha: ref, per_page: 1 })
      const last = res.headers.link?.match(/[?&]page=(\d+)>; rel="last"/)
      return last ? Number(last[1]) : res.data.length
    },
  })
}

/** Exact branch and tag totals (REST would need to page through every ref). */
function useRefCounts(owner: string, repo: string, enabled: boolean) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'ref-counts', owner, repo],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const res: { repository: { branches: { totalCount: number }; tags: { totalCount: number } } } = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ branches: refs(refPrefix:"refs/heads/"){totalCount} tags: refs(refPrefix:"refs/tags/"){totalCount} } }`,
        { owner, repo },
      )
      return { branches: res.repository.branches.totalCount, tags: res.repository.tags.totalCount }
    },
  })
}

/** Last commit touching each entry, like the message/time columns on github.com: one aliased GraphQL query per 50 paths. */
function useLastCommits(owner: string, repo: string, ref: string, paths: string[]) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'last-commits', owner, repo, ref, paths],
    enabled: paths.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, { oid: string; message: string; date: string }> = {}
      const limited = paths.slice(0, 200)
      for (let i = 0; i < limited.length; i += 50) {
        const chunk = limited.slice(i, i + 50)
        const fields = chunk.map((p, j) => `f${j}: history(first:1, path:${JSON.stringify(p)}){ nodes{ oid messageHeadline committedDate } }`).join('\n')
        const res: { repository: { object: Record<string, { nodes: Array<{ oid: string; messageHeadline: string; committedDate: string }> }> | null } } = await octokit.graphql(
          `query($owner:String!,$repo:String!,$expr:String!){ repository(owner:$owner,name:$repo){ object(expression:$expr){ ... on Commit { ${fields} } } } }`,
          { owner, repo, expr: ref },
        )
        const obj = res.repository.object
        if (!obj) break
        chunk.forEach((p, j) => {
          const node = obj[`f${j}`]?.nodes[0]
          if (node) out[p] = { oid: node.oid, message: node.messageHeadline, date: node.committedDate }
        })
      }
      return out
    },
  })
}

/**
 * The latest-commit bar. On the repository root it heads the file table; on
 * /tree and /blob pages github.com shows it as its own bordered box (`standalone`).
 */
function LatestCommit({ owner, repo, ref, path, standalone }: { owner: string; repo: string; ref: string; path: string; standalone?: boolean }) {
  const { octokit, key } = useGitHub()
  const latest = useQuery({
    queryKey: [key, 'latest-commit', owner, repo, ref, path],
    queryFn: async () => (await octokit.rest.repos.listCommits({ owner, repo, sha: ref, path: path || undefined, per_page: 1 })).data[0] ?? null,
  })
  const count = useCommitCount(owner, repo, ref)
  const c = latest.data
  const login = c?.author?.login
  const historyUrl = `/${owner}/${repo}/commits/${encodePath(ref)}${path ? `?path=${encodeURIComponent(path)}` : ''}`
  if (standalone) {
    return (
      <div className="latest-commit-box" aria-label="Latest commit">
        <div className="flex-center gap-2 flex-1">
          {c ? (
            <>
              {login ? (
                <Link to={`/${login}`} className="flex-center" aria-label={`${login}'s profile`}>
                  <UserAvatar login={login} src={c.author?.avatar_url} size={20} />
                </Link>
              ) : (
                <UserAvatar login={c.commit.author?.name} size={20} />
              )}
              {login ? (
                <Link to={`/${login}`} className="latest-commit-author">
                  {login}
                </Link>
              ) : (
                <span className="text-bold no-wrap">{c.commit.author?.name}</span>
              )}
              <CommitTitle owner={owner} repo={repo} sha={c.sha} message={c.commit.message} />
            </>
          ) : (
            <span className="fg-muted">{latest.isLoading ? 'Loading latest commit…' : 'No commits'}</span>
          )}
        </div>
        <div className="flex-center gap-2 no-wrap">
          {c && (
            <span className="text-small fg-muted">
              <Link to={`/${owner}/${repo}/commit/${c.sha}`} className="latest-commit-sha">
                {shortSha(c.sha)}
              </Link>
              {'\u00a0·\u00a0'}
              <RelativeTime date={new Date(c.commit.committer?.date ?? c.commit.author?.date ?? Date.now())} />
            </span>
          )}
          <Link to={historyUrl} className="latest-commit-history">
            <HistoryIcon /> <span className="fg-default">History</span>
          </Link>
        </div>
      </div>
    )
  }
  return (
    <div className="latest-commit">
      {c ? (
        <>
          <UserAvatar login={c.author?.login ?? c.commit.author?.name} src={c.author?.avatar_url} size={20} />
          <span className="text-bold">{c.author?.login ?? c.commit.author?.name}</span>
          <Link to={`/${owner}/${repo}/commit/${c.sha}`} className="fg-muted text-truncate flex-1" title={c.commit.message}>
            {firstLine(c.commit.message)}
          </Link>
          <Link to={`/${owner}/${repo}/commit/${c.sha}`} className="commit-sha">
            {shortSha(c.sha)}
          </Link>
          <span className="fg-muted text-small no-wrap">
            <RelativeTime date={new Date(c.commit.committer?.date ?? c.commit.author?.date ?? Date.now())} />
          </span>
        </>
      ) : (
        <span className="fg-muted flex-1">{latest.isLoading ? 'Loading latest commit…' : 'No commits'}</span>
      )}
      <Link to={historyUrl} className="fg-default text-bold no-wrap flex-center gap-1">
        <HistoryIcon /> {count.data !== undefined && !path ? plural(count.data, 'Commit') : 'History'}
      </Link>
    </div>
  )
}

/** A commit headline as github.com shows it: muted links to the commit, `code` spans, and `#123` references linking to that issue or pull request. */
function CommitTitle({ owner, repo, sha, message }: { owner: string; repo: string; sha: string; message: string }) {
  return (
    <span className="text-truncate" title={message}>
      <CommitHeadline owner={owner} repo={repo} sha={sha} text={firstLine(message)} className="latest-commit-msg" refClassName="latest-commit-ref" />
    </span>
  )
}

/** github.com breadcrumbs: `repo / dir / name` (directories end with a trailing `/`), then a copy-path button. */
function PathCrumbs({ owner, repo, refName, path, isFile }: { owner: string; repo: string; refName: string; path: string; isFile?: boolean }) {
  const parts = path.split('/').filter(Boolean)
  return (
    <nav className="path-crumbs" aria-label="Breadcrumbs">
      <Link to={`/${owner}/${repo}/tree/${encodePath(refName)}`} className="path-crumbs-repo">
        {repo}
      </Link>
      {parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join('/')
        const last = i === parts.length - 1
        return (
          <span key={sub} className="path-crumbs-item">
            <span className="path-crumbs-sep">/</span>
            {last ? (
              <h1 className="path-crumbs-name">{p}</h1>
            ) : (
              <Link to={`/${owner}/${repo}/tree/${encodePath(refName)}/${encodePath(sub)}`}>{p}</Link>
            )}
          </span>
        )
      })}
      {!isFile && parts.length > 0 && <span className="path-crumbs-sep">/</span>}
      <span className="path-crumbs-copy">
        <CopyButton text={path} label="Copy path" />
      </span>
    </nav>
  )
}

export function CodePage() {
  const { owner, repo, data } = useRepo()
  const { ref, path, resolving } = useRefPath()
  const { octokit, key, account } = useGitHub()
  const navigate = useNavigate()
  const isRoot = !path

  useAgentPageContext({
    label: path ? `directory ${path} in ${owner}/${repo}@${ref}` : `repository ${owner}/${repo} (branch ${ref})`,
    owner,
    repo,
    details: { ref, path: path || '/', default_branch: data.default_branch, description: data.description },
    suggestions: [
      { label: 'Explain this repo', prompt: `Give me a tour of ${owner}/${repo}: what it does, how the code is organized, and where to start reading.` },
      { label: 'PRs needing attention', prompt: `List open pull requests in ${owner}/${repo} with failing checks or unresolved bot review comments, most urgent first.` },
      { label: 'Recent CI failures', prompt: `Look at the most recent failed workflow runs in ${owner}/${repo} on ${ref}, explain the root causes, and say which look flaky.` },
    ],
  })

  const contents = useQuery({
    queryKey: [key, 'contents', owner, repo, ref, path],
    enabled: !resolving,
    queryFn: async () => (await octokit.rest.repos.getContent({ owner, repo, path, ref })).data,
  })

  useEffect(() => {
    // A path that turns out to be a file, submodule or symlink: BlobPage renders those.
    const d = contents.data
    if (d && !Array.isArray(d) && (d.type === 'file' || d.type === 'submodule' || d.type === 'symlink')) navigate(`/${owner}/${repo}/blob/${encodePath(ref)}/${encodePath(path)}`, { replace: true })
  }, [contents.data, navigate, owner, repo, ref, path])

  const entries = Array.isArray(contents.data)
    ? // Folders first, then byte order like github.com (".github", "AUTHORS", "COPYING", "ChangeLog", "build.sh").
      [...contents.data].sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    : []
  const readmeEntry = entries.find((e) => e.type === 'file' && /^readme(\.|$)/i.test(e.name))

  const readme = useQuery({
    queryKey: [key, 'readme-html', owner, repo, ref, readmeEntry?.path],
    enabled: !!readmeEntry,
    queryFn: () => fetchRenderedFile(octokit, owner, repo, readmeEntry!.path, ref),
  })

  const refCounts = useRefCounts(owner, repo, isRoot)
  const lastCommits = useLastCommits(owner, repo, ref, entries.map((e) => e.path))

  // `size` is recalculated hourly and reads 0 for new repos with commits, so trust the contents request instead.
  const contentsStatus = (contents.error as { status?: number } | null)?.status
  const isEmpty = isRoot && (contentsStatus === 404 || contentsStatus === 409) && (data.size === 0 || /empty/i.test(errorMessage(contents.error)))

  if (isEmpty) {
    return (
      <div className="container-xl">
        <RepoTitle />
        <div className="Box Box-body">
          <h3 style={{ marginTop: 0 }}>This repository is empty.</h3>
          <p className="fg-muted">Push a commit to get started:</p>
          <pre className="inline-code" style={{ display: 'block', padding: 12 }}>
            git remote add origin {data.clone_url}
            {'\n'}git push -u origin main
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="container-xl">
      {isRoot && <RepoTitle />}
      <div className={isRoot ? 'layout-sidebar' : ''}>
        <div style={{ minWidth: 0 }}>
          <div className="flex-center gap-2 wrap mb-3">
            <BranchPicker owner={owner} repo={repo} value={ref} defaultBranch={data.default_branch} onChange={(r) => navigate(`/${owner}/${repo}/tree/${encodePath(r)}${path ? '/' + encodePath(path) : ''}`)} />
            {isRoot ? (
              <>
                <Link to={`/${owner}/${repo}/branches`} className="fg-muted flex-center gap-1 text-small">
                  <GitBranchIcon /> <strong className="fg-default">{refCounts.data?.branches.toLocaleString() ?? '–'}</strong> Branches
                </Link>
                <Link to={`/${owner}/${repo}/releases`} className="fg-muted flex-center gap-1 text-small">
                  <TagIcon /> <strong className="fg-default">{refCounts.data?.tags.toLocaleString() ?? '–'}</strong> Tags
                </Link>
              </>
            ) : (
              <PathCrumbs owner={owner} repo={repo} refName={ref} path={path} />
            )}
            <span className="ml-auto flex-center gap-2">
              <GoToFile owner={owner} repo={repo} refName={ref} />
              {isRoot && <CloneMenu />}
            </span>
          </div>

          {!contents.error && !isRoot && <LatestCommit owner={owner} repo={repo} ref={ref} path={path} standalone />}
          {contents.error ? (
            <ErrorBox error={contents.error} title="Could not list files" />
          ) : (
            <div className="Box">
              {isRoot && <LatestCommit owner={owner} repo={repo} ref={ref} path={path} />}
              {contents.isLoading || resolving ? (
                <Loading />
              ) : (
                <table className="file-table code-dir-table">
                  <colgroup>
                    <col className="c-name" />
                    <col className="c-msg" />
                    <col className="c-when" />
                  </colgroup>
                  {!isRoot && (
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th className="msg">Last commit message</th>
                        <th className="when">Last commit date</th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {!isRoot && (
                      <tr>
                        <td className="name" colSpan={3}>
                          <Link to={`/${owner}/${repo}/tree/${encodePath(ref)}/${encodePath(path.split('/').slice(0, -1).join('/'))}`.replace(/\/$/, '')} aria-label="Parent directory" className="dir-entry dir-up">
                            <FileDirectoryFillIcon className="dir-entry-icon" />
                            ..
                          </Link>
                        </td>
                      </tr>
                    )}
                    {entries.map((e) => {
                      const submodule = isSubmoduleEntry(e)
                      // Submodules link to the pinned commit of their own repository, as on github.com.
                      const submoduleApp = submodule && e.html_url ? appPathFromUrl(e.html_url, account.host) : null
                      return (
                        <tr key={e.path}>
                          <td className="name">
                            <span className="dir-entry">
                              <span className={`dir-entry-icon ${e.type === 'dir' || submodule ? 'dir' : ''}`}>
                                {e.type === 'dir' ? <FileDirectoryFillIcon /> : submodule ? <FileSubmoduleIcon /> : e.type === 'symlink' ? <FileSymlinkFileIcon /> : <FileIcon />}
                              </span>
                              <Link to={submoduleApp ?? `/${owner}/${repo}/${e.type === 'dir' ? 'tree' : 'blob'}/${encodePath(ref)}/${encodePath(e.path)}`} title={e.name} className="text-truncate">
                                {submodule ? `${e.name} @ ${shortSha(e.sha)}` : e.name}
                              </Link>
                            </span>
                          </td>
                          <td className="msg">
                            {lastCommits.data?.[e.path] && <CommitTitle owner={owner} repo={repo} sha={lastCommits.data[e.path].oid} message={lastCommits.data[e.path].message} />}
                          </td>
                          <td className="when">{lastCommits.data?.[e.path] && <RelativeTime date={new Date(lastCommits.data[e.path].date)} />}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {readmeEntry && (
            <div className="Box mt-3" id={isRoot ? undefined : 'readme'}>
              {isRoot ? (
                <div className="Box-header compact" style={{ background: 'var(--bgColor-default)' }}>
                  <BookIcon />
                  <Link to={`/${owner}/${repo}/blob/${encodePath(ref)}/${encodePath(readmeEntry.path)}`} className="text-bold fg-default">
                    {readmeEntry.name}
                  </Link>
                </div>
              ) : (
                // Folder READMEs on github.com: a plain "README.md" heading that anchors to itself.
                <div className="dir-readme-header">
                  <h2>
                    <a href="#readme">{readmeEntry.name}</a>
                  </h2>
                </div>
              )}
              <div className="Box-body" style={{ padding: 32 }}>
                {readme.isLoading ? <Loading /> : readme.error ? <ErrorBox error={readme.error} /> : <Markdown html={readme.data} base={{ owner, repo, ref, path: readmeEntry.path }} />}
              </div>
            </div>
          )}
        </div>
        {isRoot && <RepoSidebar />}
      </div>
    </div>
  )
}

/**
 * A file's rendered HTML. github.com gives the JSON and HTML variants of a contents URL the same ETag, so once the
 * browser has cached the JSON one (the blob request), the HTML request revalidates to a 304 and gets that JSON
 * back ("[object Object]" in the preview). An extra query parameter keeps the two URLs apart.
 */
async function fetchRenderedFile(octokit: ReturnType<typeof useGitHub>['octokit'], owner: string, repo: string, path: string, ref: string) {
  const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref, rendered: 'html', mediaType: { format: 'html' } })
  return res.data as unknown as string
}

/** Directory listings report submodules as type 'file' (for backwards compatibility), with no download URL and a tree git_url. */
function isSubmoduleEntry(e: { type: string; download_url: string | null; git_url: string | null }) {
  return e.type === 'submodule' || (e.type === 'file' && !e.download_url && (!e.git_url || e.git_url.includes('/git/trees/')))
}

function GoToFile({ owner, repo, refName }: { owner: string; repo: string; refName: string }) {
  const { octokit, key } = useGitHub()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const tree = useQuery({
    queryKey: [key, 'tree', owner, repo, refName],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: refName, recursive: 'true' })
      return data.tree.filter((t) => t.type === 'blob').map((t) => t.path!)
    },
  })
  const matches = useMemo(() => {
    if (!tree.data) return []
    const needle = q.toLowerCase()
    return tree.data.filter((p) => fuzzy(p.toLowerCase(), needle)).slice(0, 40)
  }, [tree.data, q])
  const focusedPane = useIsFocusedPane()
  useEffect(() => {
    if (!focusedPane) return
    // github.com's `t` shortcut opens the file finder.
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedPane])
  return (
    <ActionMenu open={open} onOpenChange={setOpen}>
      <ActionMenu.Anchor>
        {/* Looks like github.com's search field: icon and muted placeholder text. */}
        <Button className="goto-file-anchor" alignContent="start" leadingVisual={SearchIcon}>
          Go to file
        </Button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="large">
        <div style={{ padding: 8 }}>
          <TextInput block autoFocus placeholder="Go to file" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a file" />
        </div>
        <ActionList>
          {tree.isLoading && <ActionList.Item disabled>Loading files…</ActionList.Item>}
          {matches.map((p) => (
            <ActionList.Item key={p} onSelect={() => navigate(`/${owner}/${repo}/blob/${encodePath(refName)}/${encodePath(p)}`)}>
              <ActionList.LeadingVisual>
                <FileIcon />
              </ActionList.LeadingVisual>
              {p}
            </ActionList.Item>
          ))}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

function fuzzy(hay: string, needle: string) {
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i++
  return i === needle.length
}

function RepoSidebar() {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const languages = useQuery({ queryKey: [key, 'languages', owner, repo], queryFn: async () => (await octokit.rest.repos.listLanguages({ owner, repo })).data })
  const release = useQuery({
    queryKey: [key, 'latest-release', owner, repo],
    queryFn: async () => {
      try {
        return (await octokit.rest.repos.getLatestRelease({ owner, repo })).data
      } catch {
        return null
      }
    },
  })
  const [editing, setEditing] = useState(false)
  const total = Object.values(languages.data ?? {}).reduce((a, b) => a + b, 0)
  const langs = Object.entries(languages.data ?? {}).map(([name, bytes]) => ({ name, pct: (bytes / total) * 100, color: LANG_COLORS[name] ?? 'var(--fgColor-muted)' }))
  return (
    <aside>
      <div className="sidebar-section">
        <div className="about-heading">
          <h2 className="text-bold">About</h2>
          {data.permissions?.admin && <IconButton icon={GearIcon} variant="invisible" size="small" aria-label="Edit repository metadata" onClick={() => setEditing(true)} />}
        </div>
        {data.description ? (
          <p style={{ fontSize: 16, margin: '0 0 12px' }}>{data.description}</p>
        ) : (
          // github.com shows the placeholder only when the website and topics are empty too.
          !data.homepage &&
          !data.topics?.length && (
            <p className="fg-muted" style={{ fontStyle: 'italic' }}>
              No description, website, or topics provided.
            </p>
          )
        )}
        {data.homepage && (
          <p className="flex-center gap-1 text-bold" style={{ margin: '0 0 12px' }}>
            <LinkIcon />
            <a href={data.homepage} onClick={(e) => (e.preventDefault(), openExternal(data.homepage!))}>
              {data.homepage.replace(/^https?:\/\//, '')}
            </a>
          </p>
        )}
        {!!data.topics?.length && (
          <div className="flex wrap gap-1 mb-3">
            {data.topics.map((t) => (
              <Label key={t} variant="accent">
                {t}
              </Label>
            ))}
          </div>
        )}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }} className="fg-muted">
          {data.license && (
            <li className="flex-center gap-2">
              <LawIcon /> {data.license.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? `${data.license.spdx_id} license` : data.license.name}
            </li>
          )}
          <li className="flex-center gap-2">
            <StarIcon /> <strong className="fg-default">{compactNumber(data.stargazers_count)}</strong> stars
          </li>
          <li className="flex-center gap-2">
            <EyeIcon /> <strong className="fg-default">{compactNumber(data.subscribers_count)}</strong> watching
          </li>
          <li className="flex-center gap-2">
            <RepoForkedIcon /> <strong className="fg-default">{compactNumber(data.forks_count)}</strong> forks
          </li>
        </ul>
      </div>
      {release.data && (
        <div className="sidebar-section">
          <h2 className="text-bold" style={{ fontSize: 16, margin: '0 0 12px' }}>
            <Link to={`/${owner}/${repo}/releases`} className="fg-default">
              Releases
            </Link>
          </h2>
          <div className="flex gap-2">
            <TagIcon className="fg-success" size={24} />
            <div>
              <a href={release.data.html_url} onClick={(e) => (e.preventDefault(), openExternal(release.data!.html_url))} className="text-bold fg-default">
                {release.data.name || release.data.tag_name}
              </a>{' '}
              <Label variant="success">Latest</Label>
              <div className="text-small fg-muted">
                <RelativeTime date={new Date(release.data.published_at ?? release.data.created_at)} />
              </div>
            </div>
          </div>
        </div>
      )}
      {langs.length > 0 && (
        <div className="sidebar-section">
          <h2 className="text-bold" style={{ fontSize: 16, margin: '0 0 8px' }}>
            Languages
          </h2>
          <div className="lang-bar">
            {langs.map((l) => (
              <span key={l.name} style={{ width: `${l.pct}%`, background: l.color }} title={l.name} />
            ))}
          </div>
          <div className="flex wrap" style={{ gap: '4px 16px' }}>
            {langs.slice(0, 8).map((l) => (
              <span key={l.name} className="text-small">
                <span className="lang-dot" style={{ background: l.color }} />
                <strong>{l.name}</strong> <span className="fg-muted">{l.pct.toFixed(1)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {editing && <RepoDetailsDialog onClose={() => setEditing(false)} />}
    </aside>
  )
}

export const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584', Java: '#b07219', Kotlin: '#A97BFF',
  Swift: '#F05138', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Ruby: '#701516', PHP: '#4F5D95', HTML: '#e34c26', CSS: '#563d7c',
  SCSS: '#c6538c', Shell: '#89e051', Dockerfile: '#384d54', Vue: '#41b883', Svelte: '#ff3e00', Dart: '#00B4AB', Elixir: '#6e4a7e',
  Scala: '#c22d40', Haskell: '#5e5086', Lua: '#000080', 'Objective-C': '#438eff', MDX: '#fcb32c', Nix: '#7e7eff', HCL: '#844FBA',
  Makefile: '#427819', PowerShell: '#012456', Zig: '#ec915c', Astro: '#ff5a03', 'Jupyter Notebook': '#DA5B0B', R: '#198CE7',
}

// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i

export function BlobPage() {
  const { owner, repo, data } = useRepo()
  const { ref, path, resolving } = useRefPath()
  const { octokit, key, account } = useGitHub()
  const navigate = useNavigate()
  const location = useLocation()
  const agent = useAgent()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const [editing, setEditing] = useState(false)
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path)
  const isImage = IMAGE_EXT.test(path)
  // SVG is an image with a source: github.com offers Preview, Code and Blame for it, as for Markdown.
  const isSvg = /\.svg$/i.test(path)
  const hasPreview = isMarkdown || isSvg
  // Like github.com: /blame/<ref>/<path> is the blame view, /blob/ the file; previews come first and `?plain=1` shows the source.
  const blame = location.pathname.split('/')[3] === 'blame'
  const view: BlobView = blame ? 'blame' : hasPreview && params.get('plain') !== '1' ? 'preview' : 'code'
  const views: BlobView[] = hasPreview ? ['preview', 'code', 'blame'] : ['code', 'blame']
  const setView = (v: BlobView) => {
    const filePath = `${encodePath(ref)}/${encodePath(path)}`
    if (v === 'blame') return navigate(`/${owner}/${repo}/blame/${filePath}`)
    navigate(`/${owner}/${repo}/blob/${filePath}${hasPreview && v === 'code' ? '?plain=1' : ''}`)
  }

  useAgentPageContext({
    label: `file ${path} in ${owner}/${repo}@${ref}`,
    owner,
    repo,
    details: { ref, path },
    suggestions: [
      { label: 'Explain this file', prompt: `Explain what ${path} does in ${owner}/${repo} (ref ${ref}) and how it fits into the codebase.` },
      { label: 'Find bugs', prompt: `Review ${path} in ${owner}/${repo} at ${ref} for bugs, edge cases and security issues. Report findings with line numbers; do not change anything.` },
    ],
  })

  const file = useQuery({
    queryKey: [key, 'file', owner, repo, ref, path],
    enabled: !resolving && !!path,
    queryFn: async () => {
      const res = await octokit.rest.repos.getContent({ owner, repo, path, ref })
      if (Array.isArray(res.data)) return { kind: 'dir' as const }
      // Rendered here rather than bounced back to /tree, which would loop with CodePage.
      if (res.data.type === 'submodule') return { kind: 'submodule' as const, sha: res.data.sha, html_url: res.data.html_url, git_url: res.data.submodule_git_url }
      if (res.data.type === 'symlink') return { kind: 'symlink' as const, target: res.data.target }
      const d = res.data
      // The contents API omits content above 1 MB; past 50 MB the blob isn't fetched either.
      const tooLarge = !d.content && d.size >= 50_000_000
      let text: string | null = null
      if ((!isImage || isSvg) && !tooLarge) {
        const raw = d.content ? d.content : (await octokit.rest.git.getBlob({ owner, repo, file_sha: d.sha })).data.content
        const decoded = raw ? decodeBase64(raw) : ''
        text = /\u0000/.test(decoded.slice(0, 8000)) ? null : decoded
      }
      return { kind: 'file' as const, sha: d.sha, size: d.size, download_url: d.download_url, html_url: d.html_url, text, tooLarge }
    },
  })

  const rendered = useQuery({
    queryKey: [key, 'file-html', owner, repo, ref, path],
    enabled: isMarkdown && view === 'preview' && !resolving,
    queryFn: () => fetchRenderedFile(octokit, owner, repo, path, ref),
  })

  useEffect(() => {
    if (file.data?.kind === 'dir') navigate(`/${owner}/${repo}/tree/${encodePath(ref)}/${encodePath(path)}`, { replace: true })
  }, [file.data, navigate, owner, repo, ref, path])

  const text = file.data?.kind === 'file' ? file.data.text : null
  const isText = text !== null && text !== undefined
  const lines = useMemo(() => (text !== null && text !== undefined ? highlightLines(text.replace(/\n$/, ''), languageFor(path)) : []), [text, path])
  // github.com's "N lines (M loc)": loc leaves out blank lines.
  const loc = useMemo(() => (text ? text.replace(/\n$/, '').split('\n').filter((l) => l.trim() !== '').length : 0), [text])
  const range = parseLineHash(location.hash)

  useEffectOnChange(() => {
    if (range && lines.length) contentElementById(`L${range[0]}`)?.scrollIntoView({ block: 'center' })
  }, [range?.[0], lines.length])

  const canEdit = !!data.permissions?.push && isText
  const symlinkPath = file.data?.kind === 'symlink' ? resolveSymlink(path, file.data.target) : null
  const submoduleApp = file.data?.kind === 'submodule' && file.data.html_url ? appPathFromUrl(file.data.html_url, account.host) : null

  const fileData = file.data?.kind === 'file' ? file.data : null
  const fileName = path.split('/').pop() ?? path

  return (
    <div className="container-xl">
      <div className="flex-center gap-2 wrap mb-3">
        <BranchPicker owner={owner} repo={repo} value={ref} defaultBranch={data.default_branch} onChange={(r) => navigate(`/${owner}/${repo}/${blame ? 'blame' : 'blob'}/${encodePath(r)}/${encodePath(path)}`)} />
        <PathCrumbs owner={owner} repo={repo} refName={ref} path={path} isFile />
        <span className="ml-auto flex-center gap-2">
          <GoToFile owner={owner} repo={repo} refName={ref} />
        </span>
      </div>
      {file.error ? (
        <ErrorBox error={file.error} title="Could not load file" />
      ) : (
        <>
          <LatestCommit owner={owner} repo={repo} ref={ref} path={path} standalone />
          <div className="Box">
            <div className="blob-header">
              <div className="flex-center gap-2" style={{ minWidth: 0 }}>
                {(isText || isMarkdown) && !editing && (
                  <SegmentedControl aria-label="File view" size="small" onChange={(i) => setView(views[i])}>
                    {views.map((v) => (
                      <SegmentedControl.Button key={v} selected={view === v}>
                        {v === 'preview' ? 'Preview' : v === 'code' ? 'Code' : 'Blame'}
                      </SegmentedControl.Button>
                    ))}
                  </SegmentedControl>
                )}
                <span className="blob-size text-truncate">
                  {isText && `${lines.length.toLocaleString()} lines (${loc.toLocaleString()} loc) · `}
                  {fileData && formatBytes(fileData.size)}
                </span>
              </div>
              <span className="ml-auto flex-center gap-2">
                  <IconButton description="Ask the agent about this file" size="small" icon={SparkleFillIcon} aria-label="Ask agent about this file" onClick={() => agent.ask(`Explain ${path} in ${owner}/${repo} at ${ref}.`)} />
                {fileData && isText ? (
                  <ButtonGroup>
                    {fileData.download_url && (
                      <Button size="small" onClick={() => openExternal(fileData.download_url!)}>
                        Raw
                      </Button>
                    )}
                    {text && <CopyButtonText text={text} />}
                    <IconButton size="small" icon={DownloadIcon} aria-label="Download raw file" onClick={() => void downloadFile(fileName, fileData.download_url, text)} />
                  </ButtonGroup>
                ) : fileData ? (
                  <IconButton size="small" icon={DownloadIcon} aria-label="Download raw file" onClick={() => void downloadFile(fileName, fileData.download_url, null)} />
                ) : null}
                {canEdit && !editing && (
                  <IconButton description="Edit this file" size="small" icon={PencilIcon} aria-label="Edit file" onClick={() => setEditing(true)} />
                )}
                {!isNative && <IconButton description="Open on GitHub" size="small" icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/blob/${ref}/${path}`))} />}
              </span>
            </div>
            {file.isLoading || resolving ? (
              <Loading />
            ) : file.data?.kind === 'submodule' ? (
              <div className="blankslate">
                <FileSubmoduleIcon size={24} />
                <p>
                  Submodule @ <span className="text-mono">{shortSha(file.data.sha)}</span>
                </p>
                {submoduleApp ? (
                  <Link to={submoduleApp}>{file.data.git_url}</Link>
                ) : file.data.html_url ? (
                  <Button size="small" trailingVisual={LinkExternalIcon} onClick={() => openExternal(file.data?.kind === 'submodule' ? file.data.html_url! : '')}>
                    {file.data.git_url}
                  </Button>
                ) : (
                  <span className="text-mono fg-muted">{file.data.git_url}</span>
                )}
              </div>
            ) : file.data?.kind === 'symlink' ? (
              <div className="blankslate">
                <FileSymlinkFileIcon size={24} />
                <p>
                  Symlink to{' '}
                  {symlinkPath !== null ? (
                    <Link to={`/${owner}/${repo}/tree/${encodePath(ref)}${symlinkPath ? '/' + encodePath(symlinkPath) : ''}`} className="text-mono">
                      {file.data.target}
                    </Link>
                  ) : (
                    <span className="text-mono">{file.data.target}</span>
                  )}
                </p>
              </div>
            ) : editing && text !== null && text !== undefined && file.data?.kind === 'file' ? (
              <FileEditor
                owner={owner}
                repo={repo}
                path={path}
                branch={ref}
                sha={file.data.sha}
                initial={text}
                onDone={(committed) => {
                  setEditing(false)
                  if (committed) void qc.invalidateQueries({ queryKey: [key] })
                }}
              />
            ) : isImage && file.data?.kind === 'file' && (!isSvg || view === 'preview') ? (
              <div className="blob-image">
                <img src={file.data.download_url ?? ''} alt={fileName} style={{ maxWidth: '100%' }} />
              </div>
            ) : isMarkdown && view === 'preview' ? (
              <div className="Box-body" style={{ padding: 32 }}>
                {rendered.isLoading ? <Loading /> : <Markdown html={rendered.data} base={{ owner, repo, ref, path }} />}
              </div>
            ) : file.data?.kind === 'file' && file.data.tooLarge ? (
              <div className="blankslate">
                {file.data.download_url && <ViewRawLink url={file.data.download_url} />}
                <p>(Sorry about that, but we can’t show files that are this big right now.)</p>
              </div>
            ) : text === null ? (
              <div className="blankslate">
                <FileIcon size={24} />
                <p>Binary file not shown.</p>
                {fileData?.download_url && <ViewRawLink url={fileData.download_url} />}
              </div>
            ) : view === 'blame' ? (
              <BlameView owner={owner} repo={repo} refName={ref} path={path} lines={lines} />
            ) : (
              <div className="blob-view">
                <table className="blob-table">
                  <tbody>
                    {lines.map((html, i) => {
                      const n = i + 1
                      const hl = range && n >= range[0] && n <= range[1]
                      return (
                        <tr key={n} className={`blob-line ${hl ? 'highlighted' : ''}`} id={`L${n}`}>
                          <td
                            className="blob-num"
                            onClick={(e) => {
                              const next = e.shiftKey && range ? `#L${Math.min(range[0], n)}-L${Math.max(range[0], n)}` : `#L${n}`
                              navigate({ hash: next }, { replace: true })
                            }}
                          >
                            {n}
                          </td>
                          <td className="blob-code" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {range && text && (
        <div className="mt-2 flex-center gap-2">
          <Button
            size="small"
            leadingVisual={SparkleFillIcon}
            onClick={() => agent.ask(`Explain lines ${range[0]}-${range[1]} of ${path} in ${owner}/${repo} at ${ref}.`)}
          >
            Ask agent about L{range[0]}
            {range[1] !== range[0] ? `–L${range[1]}` : ''}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Copy button for the Raw/copy/download group: a regular (not invisible) button, as on github.com. */
function CopyButtonText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      size="small"
      icon={copied ? CheckIcon : CopyIcon}
      aria-label={copied ? 'Copied!' : 'Copy raw file'}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
      }}
    />
  )
}

function ViewRawLink({ url }: { url: string }) {
  return (
    <a href={url} onClick={(e) => (e.preventDefault(), openExternal(url))}>
      View raw
    </a>
  )
}

/** Saves the file under its own name: the raw bytes when they can be fetched, else the decoded text. */
async function downloadFile(name: string, url: string | null, text: string | null) {
  let blob: Blob | null = null
  if (url) {
    try {
      const res = await fetch(url)
      if (res.ok) blob = await res.blob()
    } catch {
      // Falls back to the text below (or opening the raw URL).
    }
  }
  if (!blob && text !== null) blob = new Blob([text], { type: 'text/plain' })
  if (!blob) {
    if (url) openExternal(url)
    return
  }
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

type BlobView = 'preview' | 'code' | 'blame'

interface BlameRange {
  startingLine: number
  endingLine: number
  commit: { oid: string; messageHeadline: string; committedDate: string; author: { name: string | null; avatarUrl: string | null; user: { login: string } | null } | null }
}

/** github.com's blame recency buckets: the commit's age as a share of the repository's age (capped at two years). */
const BLAME_BUCKETS = [0.007, 0.014, 0.03, 0.049, 0.084, 0.14, 0.23, 0.38, 0.62]
function blameColor(committed: string, repoCreated: string) {
  const date = Date.parse(committed)
  const created = Date.parse(repoCreated)
  let scale = 0
  if (!(date < created)) {
    const now = Date.now()
    const share = (now - date) / Math.min(now - created, 2 * 365 * 24 * 3600 * 1000)
    const bucket = BLAME_BUCKETS.findIndex((b) => share < b)
    scale = bucket === -1 ? 0 : 9 - bucket
  }
  return `var(--display-orange-scale-${scale})`
}

function BlameLegend() {
  return (
    <div className="blame-legend" aria-hidden>
      <span>Older</span>
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className="blame-legend-swatch" style={{ background: `var(--display-orange-scale-${i})` }} />
      ))}
      <span>Newer</span>
    </div>
  )
}

/** Per-line blame from the GraphQL `blame` field: one commit cell per range, then the highlighted lines. */
function BlameView({ owner, repo, refName, path, lines }: { owner: string; repo: string; refName: string; path: string; lines: string[] }) {
  const { octokit, key } = useGitHub()
  const { data: repoData } = useRepo()
  const blame = useQuery({
    queryKey: [key, 'blame', owner, repo, refName, path],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const fields = `blame(path:$path){ ranges{ startingLine endingLine commit{ oid messageHeadline committedDate author{ name avatarUrl user{ login } } } } }`
      const res: { repository: { object: { blame?: { ranges: BlameRange[] }; target?: { blame?: { ranges: BlameRange[] } } } | null } } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$expr:String!,$path:String!){ repository(owner:$owner,name:$repo){ object(expression:$expr){ ... on Commit { ${fields} } ... on Tag { target { ... on Commit { ${fields} } } } } } }`,
        { owner, repo, expr: refName, path },
      )
      const obj = res.repository.object
      return obj?.blame?.ranges ?? obj?.target?.blame?.ranges ?? []
    },
  })
  if (blame.isLoading) return <Loading />
  if (blame.error) {
    return (
      <div className="Box-body">
        <ErrorBox error={blame.error} title="Could not load blame" />
      </div>
    )
  }
  return (
    <div className="blob-view">
      <BlameLegend />
      <table className="blob-table blame-table">
        <tbody>
          {(blame.data ?? []).flatMap((r) => {
            const span = r.endingLine - r.startingLine + 1
            const login = r.commit.author?.user?.login
            return Array.from({ length: span }, (_, i) => {
              const n = r.startingLine + i
              return (
                <tr key={n} id={`L${n}`} className={`blob-line${i === 0 ? ' blame-hunk' : ''}`}>
                  {i === 0 && <td className="blame-age" rowSpan={span} style={{ backgroundColor: blameColor(r.commit.committedDate, repoData.created_at) }} />}
                  {i === 0 && (
                    <td className="blame-commit" rowSpan={span}>
                      <div className="blame-commit-row">
                        <span className="blame-date">
                          <RelativeTime date={new Date(r.commit.committedDate)} />
                        </span>
                        <UserAvatar login={login ?? r.commit.author?.name} src={r.commit.author?.avatarUrl} size={16} />
                        <Link to={`/${owner}/${repo}/commit/${r.commit.oid}`} className="blame-msg" title={r.commit.messageHeadline}>
                          {r.commit.messageHeadline}
                        </Link>
                      </div>
                    </td>
                  )}
                  <td className="blob-num">{n}</td>
                  <td className="blob-code" dangerouslySetInnerHTML={{ __html: lines[n - 1] || ' ' }} />
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Resolves a symlink target against the link's directory; null when it points outside the repo. */
function resolveSymlink(path: string, target: string): string | null {
  if (target.startsWith('/')) return null
  const out = path.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else if (seg && seg !== '.') out.push(seg)
  }
  return out.join('/')
}

function parseLineHash(hash: string): [number, number] | null {
  const m = hash.match(/^#L(\d+)(?:-L(\d+))?$/)
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  return [Math.min(a, b), Math.max(a, b)]
}

function FileEditor({ owner, repo, path, branch, sha, initial, onDone }: { owner: string; repo: string; path: string; branch: string; sha: string; initial: string; onDone(committed: boolean): void }) {
  const { octokit } = useGitHub()
  const [value, setValue] = useState(initial)
  const [message, setMessage] = useState(`Update ${path.split('/').pop()}`)
  const [error, setError] = useState<string | null>(null)
  const commit = useMutation({
    mutationFn: async () =>
      octokit.rest.repos.createOrUpdateFileContents({ owner, repo, path, branch, sha, message, content: encodeBase64(value) }),
    onSuccess: () => onDone(true),
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <div className="Box-body">
      <Textarea
        block
        rows={Math.min(40, Math.max(12, initial.split('\n').length))}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Edit ${path}`}
        style={{ fontFamily: 'var(--fontStack-monospace)', fontSize: 12 }}
        spellCheck={false}
      />
      <div className="Box mt-3">
        <div className="Box-body">
          <FormControl>
            <FormControl.Label>Commit message</FormControl.Label>
            <TextInput block value={message} onChange={(e) => setMessage(e.target.value)} />
            <FormControl.Caption>
              Commits directly to <span className="branch-pill">{branch}</span>.
            </FormControl.Caption>
          </FormControl>
          {error && <div className="error-box mt-2">{error}</div>}
          <div className="flex-center gap-2 mt-3">
            <Button variant="primary" loading={commit.isPending} disabled={value === initial || !message.trim()} onClick={() => commit.mutate()}>
              Commit changes
            </Button>
            <Button onClick={() => onDone(false)}>Cancel</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

