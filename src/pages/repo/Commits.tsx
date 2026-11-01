import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, AnchoredOverlay, Button, IconButton, Label, Pagination, RelativeTime, Spinner, TextInput, Timeline } from '@primer/react'
import { GitBranchIcon, GitCommitIcon, FileCodeIcon, CodeIcon, EllipsisIcon, GearIcon, SparkleFillIcon, LinkExternalIcon, PeopleIcon, TriangleDownIcon, SearchIcon, XIcon } from '@primer/octicons-react'
import { useGitHub } from '../../lib/github'
import { useRepo, useRefPath, encodePath } from '../../lib/repo'
import { dayLabel, firstLine, plural, restLines, shortSha } from '../../lib/format'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { webUrl } from '../../lib/links'
import { openExternal } from '../../lib/platform'
import { readPref, writePref } from '../../lib/storage'
import { BranchPicker } from '../../components/BranchPicker'
import { Blankslate, CommitHeadline, CopyButton, DiffStat, ErrorBox, Loading, UserAvatar, titleParts } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { scrollContentToTop } from '../../lib/scroll'

const PER_PAGE = 35

export function CommitsPage() {
  const { owner, repo, data } = useRepo()
  const { ref, path: splatPath, resolving } = useRefPath()
  const { octokit, key } = useGitHub()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('page') || 1)
  const path = params.get('path') || splatPath || undefined
  const author = params.get('author') || undefined

  useAgentPageContext({ label: `commit history of ${owner}/${repo}@${ref}${path ? ` for ${path}` : ''}`, owner, repo, details: { ref, path, author } })

  const commits = useQuery({
    queryKey: [key, 'commits', owner, repo, ref, path, author, page],
    enabled: !resolving,
    queryFn: async () => {
      const res = await octokit.rest.repos.listCommits({ owner, repo, sha: ref, path, author, per_page: PER_PAGE, page })
      return { items: res.data, hasNext: /rel="next"/.test(res.headers.link ?? '') }
    },
  })

  const commitsPath = (r: string, p?: string) => `/${owner}/${repo}/commits/${encodePath(r)}${p ? `/${encodePath(p)}` : ''}${author ? `?author=${encodeURIComponent(author)}` : ''}`
  const setAuthor = (login: string | null) =>
    setParams((p) => {
      if (login) p.set('author', login)
      else p.delete('author')
      p.delete('page')
      return p
    })
  const segments = path ? path.split('/') : []

  return (
    <div className="container-xl">
      <h1 className="commits-pagehead">Commits</h1>
      <div className="commits-toolbar">
        {path ? (
          <div className="commits-history-for">
            <span>History for</span>
            <nav aria-label="Breadcrumbs" className="commits-crumbs">
              <Link to={commitsPath(ref)}>{repo}</Link>
              {segments.map((s, i) => (
                <Fragment key={i}>
                  <span className="commits-crumb-sep">/</span>
                  {i === segments.length - 1 ? (
                    <strong aria-current="page">{s}</strong>
                  ) : (
                    <Link to={commitsPath(ref, segments.slice(0, i + 1).join('/'))}>{s}</Link>
                  )}
                </Fragment>
              ))}
            </nav>
            <span>on</span>
            <BranchPicker size="small" owner={owner} repo={repo} value={ref} defaultBranch={data.default_branch} onChange={(r) => navigate(commitsPath(r, path))} />
          </div>
        ) : (
          <BranchPicker owner={owner} repo={repo} value={ref} defaultBranch={data.default_branch} onChange={(r) => navigate(commitsPath(r))} />
        )}
        <UserSelector owner={owner} repo={repo} value={author} onChange={setAuthor} />
      </div>
      {(commits.error as { status?: number } | null)?.status === 409 ? (
        // The API answers 409 "Git Repository is empty."
        <div className="Box mt-2">
          <Blankslate icon={<GitCommitIcon size={24} />} title="This repository is empty." />
        </div>
      ) : commits.error ? (
        <ErrorBox error={commits.error} />
      ) : commits.isLoading || resolving ? (
        <Loading />
      ) : !commits.data?.items.length ? (
        <div className="Box mt-2">
          <Blankslate icon={<GitCommitIcon size={24} />} title="No commits history">
            There isn’t any commit history to show here
          </Blankslate>
        </div>
      ) : (
        <>
          <h2 className="sr-only">Commit history</h2>
          <CommitTimeline owner={owner} repo={repo} commits={commits.data.items} />
          {(page > 1 || commits.data.hasNext) && (
            <Pagination
              pageCount={commits.data.hasNext ? page + 1 : page}
              currentPage={page}
              showPages={false}
              hrefBuilder={(n) => {
                const p = new URLSearchParams(params)
                p.set('page', String(n))
                return `?${p.toString()}`
              }}
              onPageChange={(e, n) => {
                e.preventDefault()
                setParams((p) => (p.set('page', String(n)), p))
                scrollContentToTop()
              }}
            />
          )}
        </>
      )}
    </div>
  )
}

/** The "All users" filter beside the branch picker; lists the repository's contributors. */
function UserSelector({ owner, repo, value, onChange }: { owner: string; repo: string; value?: string; onChange(login: string | null): void }) {
  const { octokit, key } = useGitHub()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const contributors = useQuery({
    queryKey: [key, 'contributors', owner, repo],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => (await octokit.rest.repos.listContributors({ owner, repo, per_page: 100 })).data,
  })
  const users = useMemo(() => {
    const f = filter.toLowerCase()
    return (contributors.data ?? []).filter((u) => u.login && u.login.toLowerCase().includes(f))
  }, [contributors.data, filter])
  const close = () => setOpen(false)
  const pick = (login: string | null) => (onChange(login), close())
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => (setFilter(''), setOpen(true))}
      onClose={close}
      width="medium"
      align="end"
      renderAnchor={(anchorProps) => (
        <Button {...anchorProps} trailingAction={TriangleDownIcon} aria-label={value ? `Commits by ${value}` : 'All users'}>
          <span className="flex-center">
            <span className="flex-center" style={{ marginRight: 8 }}>
              {value ? <UserAvatar login={value} size={16} /> : <PeopleIcon className="fg-muted" />}
            </span>
            <span className="text-truncate" style={{ maxWidth: 125 }}>
              {value ?? 'All users'}
            </span>
          </span>
        </Button>
      )}
    >
      <div className="commits-user-panel">
        <div className="commits-user-header">
          <h2>Select author</h2>
          <IconButton icon={XIcon} variant="invisible" size="small" aria-label="Cancel" className="fg-muted" onClick={close} />
        </div>
        <div className="commits-user-filter">
          <TextInput block autoFocus leadingVisual={SearchIcon} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a user..." aria-label="Filter users" />
        </div>
        <div className="commits-user-list">
          {contributors.isLoading ? (
            <div className="commits-user-empty">
              <Spinner size="medium" aria-label="Loading users..." />
            </div>
          ) : (
            <ActionList selectionVariant="single" role="listbox" aria-label="Users">
              {users.map((u) => (
                <ActionList.Item key={u.login} role="option" selected={u.login === value} onSelect={() => pick(u.login!)}>
                  <ActionList.LeadingVisual>
                    <UserAvatar login={u.login} src={u.avatar_url} size={20} />
                  </ActionList.LeadingVisual>
                  {u.login}
                </ActionList.Item>
              ))}
              {users.length === 0 && <ActionList.Item disabled>Nothing to show</ActionList.Item>}
            </ActionList>
          )}
        </div>
        <button type="button" className="commits-user-footer" onClick={() => pick(null)}>
          View commits for all users
        </button>
      </div>
    </AnchoredOverlay>
  )
}

interface CommitPerson {
  login?: string
  avatar_url?: string
}

/** The shape shared by repos.listCommits, pulls.listCommits and compare commits. */
export interface CommitLike {
  sha: string
  commit: {
    message: string
    author: { name?: string; date?: string } | null
    committer: { name?: string; date?: string } | null
    verification?: { verified: boolean; reason: string } | null
  }
  author: CommitPerson | null
  committer?: CommitPerson | null
}

/** Commits grouped by day on a timeline, as on github.com's commit history and compare pages. */
export function CommitTimeline({ owner, repo, commits }: { owner: string; repo: string; commits: CommitLike[] }) {
  const groups: Array<{ day: string; items: CommitLike[] }> = []
  for (const c of commits) {
    const day = dayLabel(c.commit.committer?.date ?? c.commit.author?.date ?? '')
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(c)
    else groups.push({ day, items: [c] })
  }
  return (
    <Timeline clipSidebar className="commits-timeline">
      {groups.map((g, i) => (
        <Timeline.Item key={`${g.day}-${i}`} className="commits-timeline-item">
          <Timeline.Badge className="commits-timeline-badge">
            <GitCommitIcon />
          </Timeline.Badge>
          <Timeline.Body className="commits-timeline-body">
            <h3 className="commits-day">Commits on {g.day}</h3>
            <div className="Box mt-2">
              {g.items.map((c) => (
                <CommitRow key={c.sha} owner={owner} repo={repo} c={c} />
              ))}
            </div>
          </Timeline.Body>
        </Timeline.Item>
      ))}
    </Timeline>
  )
}

/** github.com hides the committer when it is the author or GitHub itself (web-flow). */
function committerShown(c: CommitLike) {
  const a = c.author?.login
  const m = c.committer?.login
  if (m) return m !== a && m !== 'web-flow'
  const an = c.commit.author?.name
  const mn = c.commit.committer?.name
  return !!mn && mn !== an && mn !== 'GitHub'
}

function PersonLink({ owner, repo, login, name, strong }: { owner: string; repo: string; login?: string; name?: string; strong?: boolean }) {
  const cls = strong ? 'commit-author commit-author-strong' : 'commit-author'
  if (!login) return <span className={cls}>{name ?? 'unknown'}</span>
  return (
    <Link to={`/${owner}/${repo}/commits?author=${encodeURIComponent(login)}`} className={cls} aria-label={`commits by ${login}`}>
      {login}
    </Link>
  )
}

/**
 * "avatar author authored [and committer committed] <time>", the attribution line of github.com's commit views.
 * A commit its author pushed directly reads "committed"; one GitHub created (web-flow: merges in the UI) reads "authored".
 */
function CommitAttribution({ owner, repo, c, size, strong }: { owner: string; repo: string; c: CommitLike; size: number; strong?: boolean }) {
  const login = c.author?.login
  const showCommitter = committerShown(c)
  const webFlow = c.committer?.login === 'web-flow' || c.commit.committer?.name === 'GitHub'
  const selfCommitted = !showCommitter && !webFlow && !!(c.committer?.login || c.commit.committer?.name)
  const avatar = (p: CommitPerson | null | undefined, name?: string) => {
    const img = <UserAvatar login={p?.login ?? name} src={p?.avatar_url} size={size} />
    return p?.login && !p.login.endsWith('[bot]') ? (
      <Link to={`/${p.login}`} className="flex-center" aria-label={p.login}>
        {img}
      </Link>
    ) : (
      img
    )
  }
  const date = showCommitter || selfCommitted ? (c.commit.committer?.date ?? c.commit.author?.date) : (c.commit.author?.date ?? c.commit.committer?.date)
  return (
    <span className="commit-attribution">
      <span className="commit-avatars">
        {avatar(c.author, c.commit.author?.name)}
        {showCommitter && avatar(c.committer, c.commit.committer?.name)}
      </span>
      <PersonLink owner={owner} repo={repo} login={login} name={c.commit.author?.name} strong={strong} />
      <span>{showCommitter ? 'authored and' : selfCommitted ? 'committed' : 'authored'}</span>
      {showCommitter && (
        <>
          <PersonLink owner={owner} repo={repo} login={c.committer?.login ?? undefined} name={c.commit.committer?.name} strong={strong} />
          <span>committed</span>
        </>
      )}
      {date && <RelativeTime date={new Date(date)} />}
    </span>
  )
}

function VerifiedLabel({ c }: { c: CommitLike }) {
  const v = c.commit.verification
  if (!v || (!v.verified && v.reason === 'unsigned')) return null
  return v.verified ? (
    <Label variant="success" title="This commit was signed with a verified signature.">
      Verified
    </Label>
  ) : (
    <Label variant="attention" title={`Signature could not be verified (${v.reason.replace(/_/g, ' ')})`}>
      Unverified
    </Label>
  )
}

export function CommitRow({ owner, repo, c }: { owner: string; repo: string; c: CommitLike }) {
  const [expanded, setExpanded] = useState(false)
  const body = restLines(c.commit.message)
  const short = shortSha(c.sha)
  return (
    <div className="Box-row hoverable commit-row">
      <div className="flex-1">
        <div className="commit-row-title">
          <span className="commit-row-headline">
            <CommitHeadline owner={owner} repo={repo} sha={c.sha} text={firstLine(c.commit.message)} className="commit-row-link" />
          </span>
          {body && (
            <IconButton
              size="small"
              variant="invisible"
              icon={EllipsisIcon}
              aria-label={`${expanded ? 'Hide' : 'Show'} description for ${short}`}
              aria-expanded={expanded}
              className="commit-row-expander"
              onClick={() => setExpanded(!expanded)}
            />
          )}
        </div>
        {expanded && <pre className="commit-row-body">{body}</pre>}
        <div className="commit-row-meta">
          <CommitAttribution owner={owner} repo={repo} c={c} size={16} />
        </div>
      </div>
      <div className="commit-row-actions">
        <VerifiedLabel c={c} />
        <Button as={Link} to={`/${owner}/${repo}/commit/${c.sha}`} size="small" variant="invisible" className="commit-row-sha" title="View commit details">
          {short}
        </Button>
        <CopyButton text={c.sha} label={`Copy full SHA for ${short}`} />
        <IconButton description="Browse repository at this point" as={Link} to={`/${owner}/${repo}/tree/${c.sha}`} size="small" variant="invisible" icon={CodeIcon} aria-label="Browse repository at this point" />
      </div>
    </div>
  )
}

/** Renders `code` spans and #123 references in a commit title, like github.com's commit header. */
function CommitTitle({ owner, repo, text }: { owner: string; repo: string; text: string }) {
  return (
    <>
      {titleParts(text).map((p, i) =>
        p.kind === 'code' ? (
          <code key={i}>{p.value}</code>
        ) : p.kind === 'ref' ? (
          <Link key={i} to={`/${owner}/${repo}/issues/${p.value}`}>
            #{p.value}
          </Link>
        ) : (
          p.value
        ),
      )}
    </>
  )
}

export function CommitPage() {
  const { owner, repo } = useRepo()
  const { sha = '' } = useParams()
  const { octokit, key, account } = useGitHub()
  const agent = useAgent()
  const [split, setSplit] = useState(() => readPref('diffSplit', false))
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})

  useAgentPageContext({
    label: `commit ${shortSha(sha)} in ${owner}/${repo}`,
    owner,
    repo,
    details: { sha },
    suggestions: [
      { label: 'Explain this commit', prompt: `Explain commit ${sha} in ${owner}/${repo}: what changed and why it matters.` },
      { label: 'Review this commit', prompt: `Review commit ${sha} in ${owner}/${repo} for bugs or regressions. Report findings only.` },
    ],
  })

  const commit = useQuery({
    queryKey: [key, 'commit', owner, repo, sha],
    queryFn: async () => (await octokit.rest.repos.getCommit({ owner, repo, ref: sha })).data,
  })
  // github.com's "master (#3679)": the branch the commit landed on through its pull request, else the branches it heads.
  const refs = useQuery({
    queryKey: [key, 'commit-refs', owner, repo, sha],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const pulls = (await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha }).catch(() => null))?.data ?? []
      const pr = pulls.find((p) => p.merge_commit_sha && sha.startsWith(p.merge_commit_sha.slice(0, sha.length))) ?? pulls.find((p) => p.base.repo.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase())
      if (pr) return { branches: [pr.base.ref], pull: pr.number }
      const heads = (await octokit.rest.repos.listBranchesForHeadCommit({ owner, repo, commit_sha: sha }).catch(() => null))?.data ?? []
      return { branches: heads.map((b) => b.name), pull: null as number | null }
    },
  })

  if (commit.isLoading) return <Loading />
  if (commit.error || !commit.data)
    return (
      <div className="container-xl">
        <ErrorBox error={commit.error} />
      </div>
    )
  const c = commit.data
  const files = c.files ?? []
  const body = restLines(c.commit.message)
  return (
    <div className="container-xl">
      <div className="commit-header">
        <div className="commit-header-top">
          <h1 className="commit-header-title">
            Commit <span className="commit-header-sha">{shortSha(c.sha)}</span>
          </h1>
          <span className="commit-header-actions">
            <Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Explain commit ${c.sha} in ${owner}/${repo}.`)}>
              Explain
            </Button>
            <Button as={Link} leadingVisual={FileCodeIcon} to={`/${owner}/${repo}/tree/${c.sha}`} title="Browse the repository at this point in the history">
              Browse files
            </Button>
            <IconButton icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/commit/${c.sha}`))} />
          </span>
        </div>
        <div className="commit-header-attribution">
          <CommitAttribution owner={owner} repo={repo} c={c} size={20} strong />
          <VerifiedLabel c={c} />
        </div>
        <div className="Box commit-message-box">
          <div className="commit-message">
            <div className="commit-message-title">
              <CommitTitle owner={owner} repo={repo} text={firstLine(c.commit.message)} />
            </div>
            {body && <div className="commit-message-body">{body}</div>}
          </div>
          <div className="commit-message-refs">
            {refs.data && refs.data.branches.length > 0 ? (
              <span className="commit-refs">
                <GitBranchIcon />
                {refs.data.branches.slice(0, 3).map((b, i) => (
                  <Fragment key={b}>
                    {i > 0 && ', '}
                    <Link to={`/${owner}/${repo}/tree/${encodePath(b)}`}>{b}</Link>
                  </Fragment>
                ))}
                {refs.data.pull && (
                  <span>
                    (<Link to={`/${owner}/${repo}/pull/${refs.data.pull}`}>#{refs.data.pull}</Link>)
                  </span>
                )}
              </span>
            ) : (
              <span />
            )}
            <span className="commit-parents">
              {plural(c.parents.length, 'parent')}
              {c.parents.map((p, i) => (
                <Fragment key={p.sha}>
                  {i > 0 && ' + '}
                  <Link to={`/${owner}/${repo}/commit/${p.sha}`}>{shortSha(p.sha)}</Link>
                </Fragment>
              ))}
              <span>commit</span>
              <span className="fg-default">{shortSha(c.sha)}</span>
              <CopyButton text={c.sha} label={`Copy full SHA for ${shortSha(c.sha)}`} />
            </span>
          </div>
          <div className="commit-files-summary">
            <strong>{plural(files.length, 'file')} changed</strong>
            <DiffStat additions={c.stats?.additions ?? 0} deletions={c.stats?.deletions ?? 0} />
          </div>
        </div>
      </div>
      <div className="commit-diff-toolbar">
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton variant="invisible" icon={GearIcon} aria-label="Open diff view settings" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="small">
            <ActionList>
              <ActionList.Group selectionVariant="single">
                <ActionList.GroupHeading>Diff view</ActionList.GroupHeading>
                {(['Unified', 'Split'] as const).map((label) => (
                  <ActionList.Item key={label} selected={split === (label === 'Split')} onSelect={() => (setSplit(label === 'Split'), writePref('diffSplit', label === 'Split'))}>
                    {label}
                  </ActionList.Item>
                ))}
              </ActionList.Group>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
      {files.map((f, i) => (
        <FileDiffBox
          key={`${i}-${f.filename}`}
          file={{ path: f.filename, previousPath: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch, sha: f.sha }}
          split={split}
          collapsed={collapsed[i]}
          onToggle={() => setCollapsed((s) => ({ ...s, [i]: !s[i] }))}
          actions={
            <Button as={Link} size="small" variant="invisible" to={`/${owner}/${repo}/blob/${c.sha}/${encodePath(f.filename)}`}>
              View file
            </Button>
          }
        />
      ))}
      {files.length === 0 && <div className="Box Box-body fg-muted">No file changes.</div>}
    </div>
  )
}
