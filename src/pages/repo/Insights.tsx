import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Avatar, Button, Label, PageHeader, ProgressBar, RelativeTime } from '@primer/react'
import {
  GitPullRequestIcon,
  GitMergeIcon,
  IssueOpenedIcon,
  IssueClosedIcon,
  TableIcon,
  GraphIcon,
  TagIcon,
  CommentDiscussionIcon,
  LinkExternalIcon,
} from '@primer/octicons-react'
import { useGitHub } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { openExternal } from '../../lib/platform'
import { webBaseFor } from '../../lib/hosts'
import { ErrorBox, Loading, Blankslate, InlineTitle } from '../../components/Bits'

/** GitHub computes repository statistics lazily and answers 202 until ready. */
class StatsPending extends Error {}

function useStats<T>(name: string, fetcher: () => Promise<{ status: number; data: unknown }>, enabled = true) {
  const { key } = useGitHub()
  const { owner, repo } = useRepo()
  return useQuery({
    queryKey: [key, 'stats', name, owner, repo],
    enabled,
    queryFn: async () => {
      const res = await fetcher()
      // 204: empty repository, nothing to compute.
      if (res.status === 204) return [] as unknown as T
      if (res.status === 202 || !Array.isArray(res.data)) throw new StatsPending('GitHub is computing these statistics. Retrying…')
      return res.data as T
    },
    retry: (count, err) => err instanceof StatsPending && count < 8,
    retryDelay: 2500,
    staleTime: 10 * 60_000,
  })
}

type View = 'pulse' | 'contributors' | 'commit-activity' | 'code-frequency'

const longDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
const weekLabel = (ms: number) => {
  const d = new Date(ms)
  return `Week of ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}, ${d.getFullYear()}`
}
const pl = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

export function InsightsPage() {
  const { owner, repo, fullName, data } = useRepo()
  const { account } = useGitHub()
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean).slice(2)
  const view: View = parts[0] === 'pulse' ? 'pulse' : parts[1] === 'commit-activity' ? 'commit-activity' : parts[1] === 'code-frequency' ? 'code-frequency' : 'contributors'
  useAgentPageContext({ label: `insights of ${fullName}`, owner, repo })

  const base = `/${owner}/${repo}`
  const web = `${webBaseFor(account.host)}${base}`
  const items: Array<{ label: string; id?: View; to?: string; href?: string; hidden?: boolean }> = [
    { label: 'Pulse', id: 'pulse', to: `${base}/pulse` },
    { label: 'Contributors', id: 'contributors', to: `${base}/graphs/contributors` },
    { label: 'Community standards', href: `${web}/community`, hidden: data.private },
    { label: 'Commits', id: 'commit-activity', to: `${base}/graphs/commit-activity` },
    { label: 'Code frequency', id: 'code-frequency', to: `${base}/graphs/code-frequency` },
    { label: 'Dependency graph', href: `${web}/network/dependencies`, hidden: data.private },
    { label: 'Network', href: `${web}/network` },
    { label: 'Forks', href: `${web}/forks` },
  ]

  return (
    <div className="container-xl">
      <h1 className="sr-only">Insights: {fullName}</h1>
      <div className="layout-sidebar-left insights-layout">
        <nav className="insights-menu" aria-label="Insights">
          {items
            .filter((i) => !i.hidden)
            .map((i) =>
              i.to ? (
                <Link key={i.label} to={i.to} className="insights-menu-item" aria-current={view === i.id ? 'page' : undefined}>
                  {i.label}
                </Link>
              ) : (
                <a
                  key={i.label}
                  href={i.href}
                  className="insights-menu-item"
                  onClick={(e) => {
                    e.preventDefault()
                    openExternal(i.href!)
                  }}
                >
                  {i.label}
                  <LinkExternalIcon size={12} className="insights-menu-external" />
                </a>
              ),
            )}
        </nav>
        <div style={{ minWidth: 0 }}>
          {view === 'pulse' ? <Pulse /> : view === 'commit-activity' ? <CommitActivity /> : view === 'code-frequency' ? <CodeFrequency /> : <Contributors />}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Pulse */

type Period = 'daily' | 'halfweekly' | 'weekly' | 'monthly'
const PERIODS: Array<[Period, string]> = [
  ['daily', '24 hours'],
  ['halfweekly', '3 days'],
  ['weekly', '1 week'],
  ['monthly', '1 month'],
]

interface PulseItem {
  number: number
  title: string
  date: string
}

interface PulseOverview {
  /** Totals from the search issueCount; the item lists below hold at most the 100 most recent. */
  counts: { merged: number; opened: number; closed: number; issues: number }
  mergedPulls: PulseItem[]
  numAuthorsMergedPulls: number
  newPulls: PulseItem[]
  numAuthorsNewPulls: number
  closedIssues: PulseItem[]
  numAuthorsClosedIssues: number
  newIssues: PulseItem[]
  numAuthorsNewIssues: number
  discussions: Array<PulseItem & { kind: 'issues' | 'pull'; comments: number }>
}

type SearchNode = {
  __typename?: string
  number?: number
  title?: string
  createdAt?: string
  mergedAt?: string | null
  closedAt?: string | null
  author?: { login: string } | null
  timelineItems?: { nodes: Array<{ actor?: { login: string } | null } | null> }
  comments?: { nodes: Array<{ createdAt: string } | null> }
  reviews?: { nodes: Array<{ submittedAt: string | null } | null> }
}

function usePulse(sinceIso: string) {
  const { owner, repo, fullName } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'pulse', owner, repo, sinceIso],
    queryFn: async (): Promise<PulseOverview> => {
      const q = (s: string) => `repo:${fullName} ${s}`
      const res: Record<'merged' | 'opened' | 'closed' | 'issues' | 'talk', { issueCount: number; nodes: Array<SearchNode | null> }> = await octokit.graphql(
        `query($a:String!,$b:String!,$c:String!,$d:String!,$e:String!){
          merged: search(query:$a, type:ISSUE, first:100){ issueCount nodes{ ... on PullRequest{ number title createdAt mergedAt author{login} } } }
          opened: search(query:$b, type:ISSUE, first:100){ issueCount nodes{ ... on PullRequest{ number title createdAt author{login} } } }
          closed: search(query:$c, type:ISSUE, first:100){ issueCount nodes{ ... on Issue{ number title createdAt closedAt author{login} timelineItems(itemTypes:[CLOSED_EVENT], last:1){ nodes{ ... on ClosedEvent{ actor{login} } } } } } }
          issues: search(query:$d, type:ISSUE, first:100){ issueCount nodes{ ... on Issue{ number title createdAt author{login} } } }
          talk: search(query:$e, type:ISSUE, first:100){ issueCount nodes{ __typename
            ... on Issue{ number title createdAt comments(last:30){ nodes{ createdAt } } }
            ... on PullRequest{ number title createdAt comments(last:30){ nodes{ createdAt } } reviews(last:20){ nodes{ submittedAt } } } } }
        }`,
        {
          // Search has no merged/closed sort; merging or closing bumps updated, so the newest come first.
          a: q(`is:pr is:merged merged:>=${sinceIso} sort:updated-desc`),
          b: q(`is:pr is:open created:>=${sinceIso} sort:created-desc`),
          c: q(`is:issue is:closed closed:>=${sinceIso} sort:updated-desc`),
          d: q(`is:issue is:open created:>=${sinceIso} sort:created-desc`),
          e: q(`is:open updated:>=${sinceIso} sort:updated-desc`),
        },
      )
      const nodes = (k: keyof typeof res) => res[k].nodes.filter((n): n is SearchNode => !!n && n.number !== undefined)
      const people = (list: SearchNode[], who: (n: SearchNode) => string | undefined) => new Set(list.map(who).filter(Boolean)).size
      const item = (n: SearchNode, date: string | null | undefined): PulseItem => ({ number: n.number!, title: n.title ?? '', date: date ?? n.createdAt ?? '' })
      const byDate = (dir: 1 | -1) => (a: PulseItem, b: PulseItem) => dir * (Date.parse(a.date) - Date.parse(b.date))

      const merged = nodes('merged')
      const opened = nodes('opened')
      const closed = nodes('closed')
      const issues = nodes('issues')
      const since = Date.parse(sinceIso)
      const discussions = nodes('talk')
        .filter((n) => Date.parse(n.createdAt ?? '') < since)
        .map((n) => {
          const comments = (n.comments?.nodes ?? []).filter((c) => c && Date.parse(c.createdAt) >= since).map((c) => c!.createdAt)
          const reviews = (n.reviews?.nodes ?? []).filter((r) => r?.submittedAt && Date.parse(r.submittedAt) >= since).map((r) => r!.submittedAt!)
          const last = [...comments, ...reviews].sort().at(-1)
          return last ? { ...item(n, last), kind: n.__typename === 'PullRequest' ? ('pull' as const) : ('issues' as const), comments: comments.length } : null
        })
        .filter((d): d is NonNullable<typeof d> => !!d)
        // github.com lists the busiest conversations first.
        .sort((a, b) => b.comments - a.comments || byDate(-1)(a, b))

      return {
        counts: { merged: res.merged.issueCount, opened: res.opened.issueCount, closed: res.closed.issueCount, issues: res.issues.issueCount },
        mergedPulls: merged.map((n) => item(n, n.mergedAt)).sort(byDate(-1)),
        numAuthorsMergedPulls: people(merged, (n) => n.author?.login),
        newPulls: opened.map((n) => item(n, n.createdAt)).sort(byDate(1)),
        numAuthorsNewPulls: people(opened, (n) => n.author?.login),
        closedIssues: closed.map((n) => item(n, n.closedAt)).sort(byDate(-1)),
        numAuthorsClosedIssues: people(closed, (n) => n.timelineItems?.nodes[0]?.actor?.login ?? n.author?.login),
        newIssues: issues.map((n) => item(n, n.createdAt)).sort(byDate(-1)),
        numAuthorsNewIssues: people(issues, (n) => n.author?.login),
        discussions,
      }
    },
    staleTime: 5 * 60_000,
  })
}

interface Committer {
  login: string | null
  name: string
  avatar: string | null
  commits: number
}

function usePulseCommits(sinceIso: string) {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const branch = data.default_branch
  return useQuery({
    queryKey: [key, 'pulse-commits', owner, repo, branch, sinceIso],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const commits: Array<{ sha: string; parents: Array<{ sha: string }>; author: { login: string; avatar_url: string } | null; commit: { author: { name?: string; email?: string } | null } }> = []
      for await (const page of octokit.paginate.iterator(octokit.rest.repos.listCommits, { owner, repo, sha: branch, since: sinceIso, per_page: 100 })) {
        for (const c of page.data) commits.push({ sha: c.sha, parents: c.parents, author: c.author ? { login: c.author.login, avatar_url: c.author.avatar_url } : null, commit: { author: c.commit.author } })
        if (commits.length >= 1000) break
      }
      const own = commits.filter((c) => c.parents.length <= 1)
      const who = (c: (typeof own)[number]) => c.author?.login ?? c.commit.author?.email ?? c.commit.author?.name ?? 'unknown'

      // Commits on every branch, deduplicated, merges excluded.
      const all = new Set(own.map((c) => c.sha))
      try {
        const res: { repository: { refs: { nodes: Array<{ target: { committedDate?: string; history?: { nodes: Array<{ oid: string; parents: { totalCount: number } }> } } | null }> } } } = await octokit.graphql(
          `query($owner:String!,$repo:String!,$since:GitTimestamp!){ repository(owner:$owner,name:$repo){
            refs(refPrefix:"refs/heads/", first:50, orderBy:{field:TAG_COMMIT_DATE, direction:DESC}){ nodes{ target{ ... on Commit{ committedDate history(first:100, since:$since){ nodes{ oid parents{ totalCount } } } } } } } } }`,
          { owner, repo, since: sinceIso },
        )
        for (const ref of res.repository.refs.nodes) for (const c of ref.target?.history?.nodes ?? []) if (c.parents.totalCount <= 1) all.add(c.oid)
      } catch {
        // Branch histories are best-effort; the default branch numbers stand on their own.
      }

      let files = 0
      let additions = 0
      let deletions = 0
      const baseSha = commits.at(-1)?.parents[0]?.sha
      if (baseSha && commits.length) {
        try {
          const cmp = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${baseSha}...${commits[0].sha}`, per_page: 1 })
          for (const f of cmp.data.files ?? []) {
            files++
            additions += f.additions
            deletions += f.deletions
          }
        } catch {
          // A failed comparison leaves the line counts at zero rather than hiding the summary.
        }
      }

      const byAuthor = new Map<string, Committer>()
      for (const c of own) {
        const k = who(c)
        const cur = byAuthor.get(k) ?? { login: c.author?.login ?? null, name: c.commit.author?.name ?? k, avatar: c.author?.avatar_url ?? null, commits: 0 }
        cur.commits++
        byAuthor.set(k, cur)
      }
      return {
        authorsWithCommits: byAuthor.size,
        masterCommits: own.length,
        totalCommits: all.size,
        filesChanged: files,
        additions,
        deletions,
        defaultBranch: branch,
        comparePath: baseSha && commits.length ? `/${owner}/${repo}/compare/${baseSha}...${branch}` : null,
        committers: [...byAuthor.values()].sort((a, b) => b.commits - a.commits).slice(0, 15),
      }
    },
  })
}

function usePulseReleases(sinceIso: string) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'pulse-releases', owner, repo, sinceIso],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await octokit.rest.repos.listReleases({ owner, repo, per_page: 30 })
      const since = Date.parse(sinceIso)
      const list = data.filter((r) => !r.draft && r.published_at && Date.parse(r.published_at) >= since)
      const releases = list.map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, date: r.published_at! })).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      return { releases, people: new Set(list.map((r) => r.author?.login)).size }
    },
  })
}

function Pulse() {
  const { owner, repo } = useRepo()
  const [params, setParams] = useSearchParams()
  const period: Period = PERIODS.some(([p]) => p === params.get('period')) ? (params.get('period') as Period) : 'weekly'
  const periodLabel = PERIODS.find(([p]) => p === period)![1]
  const { since, now } = useMemo(() => {
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000)
    const since = new Date(now)
    if (period === 'monthly') since.setMonth(since.getMonth() - 1)
    else since.setTime(now.getTime() - { daily: 1, halfweekly: 3, weekly: 7 }[period] * 86_400_000)
    return { since, now }
  }, [period])
  const sinceIso = since.toISOString().slice(0, 19) + 'Z'
  const overview = usePulse(sinceIso)
  const commits = usePulseCommits(sinceIso)
  const releases = usePulseReleases(sinceIso)
  const base = `/${owner}/${repo}`

  return (
    <div className="insights-pulse">
      <PageHeader hasBorder>
        <PageHeader.TitleArea>
          <PageHeader.Title>
            {longDate(since)} – {longDate(now)}
          </PageHeader.Title>
        </PageHeader.TitleArea>
        <PageHeader.Actions>
          <ActionMenu>
            <ActionMenu.Button>
              <span className="flex gap-1">
                <span className="fg-muted">Period:</span>
                <span>{periodLabel}</span>
              </span>
            </ActionMenu.Button>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                {PERIODS.map(([p, label]) => (
                  <ActionList.Item
                    key={p}
                    selected={p === period}
                    onSelect={() =>
                      setParams((prev) => {
                        const next = new URLSearchParams(prev)
                        next.set('period', p)
                        return next
                      })
                    }
                  >
                    {label}
                  </ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </PageHeader.Actions>
      </PageHeader>

      {overview.isLoading ? (
        <div className="Box">
          <div className="Box-header">
            <h3 className="Box-title">Overview</h3>
          </div>
          <Loading />
        </div>
      ) : overview.error ? (
        <ErrorBox error={overview.error} title="Could not load pulse" />
      ) : (
        <PulseOverviewBox data={overview.data!} base={base} />
      )}

      {commits.isLoading ? (
        <div className="pulse-summary">
          <div className="pulse-summary-box">
            <Loading />
          </div>
        </div>
      ) : commits.error ? (
        <ErrorBox error={commits.error} title="Could not load commit activity" />
      ) : commits.data!.masterCommits === 0 && commits.data!.totalCommits === 0 ? (
        <Blankslate title={`There hasn’t been any commit activity on ${owner}/${repo} over the last ${periodLabel}`} />
      ) : (
        <PulseSummary data={commits.data!} />
      )}

      {overview.data && (
        <>
          {releases.data && releases.data.releases.length > 0 && (
            <PulseSection icon={<TagIcon />} id="releases" count={releases.data.releases.length} title={`${pl(releases.data.releases.length, 'release')} published by`} people={releases.data.people}>
              {releases.data.releases.map((r) => (
                <PulseRow key={r.tag} icon={<TagIcon />} to={`${base}/releases/tag/${encodeURIComponent(r.tag)}`} title={`${r.tag} ${r.name}`} meta={<RelativeTime date={new Date(r.date)} />} />
              ))}
            </PulseSection>
          )}
          <PulseList kind="pull" verb="merged" id="merged-pull-requests" items={overview.data.mergedPulls} total={overview.data.counts.merged} people={overview.data.numAuthorsMergedPulls} base={base} />
          <PulseList kind="pull" verb="opened" id="opened-pull-requests" items={overview.data.newPulls} total={overview.data.counts.opened} people={overview.data.numAuthorsNewPulls} base={base} />
          <PulseList kind="issues" verb="closed" id="closed-issues" items={overview.data.closedIssues} total={overview.data.counts.closed} people={overview.data.numAuthorsClosedIssues} base={base} />
          <PulseList kind="issues" verb="opened" id="opened-issues" items={overview.data.newIssues} total={overview.data.counts.issues} people={overview.data.numAuthorsNewIssues} base={base} />
          {overview.data.discussions.length > 0 && (
            <section className="pulse-section">
              <h3 className="pulse-list-heading" id="unresolved-conversations">
                <span className="pulse-list-heading-inner">
                  <CommentDiscussionIcon className="fg-muted" /> <strong className="fg-default">{overview.data.discussions.length}</strong>{' '}
                  {pl(overview.data.discussions.length, 'Unresolved conversation', 'Unresolved conversations')}
                </span>
              </h3>
              <p className="pulse-section-description">Sometimes conversations happen on old items that aren’t yet closed. Here is a list of all the Issues and Pull Requests with unresolved conversations.</p>
              <ul className="pulse-list">
                {overview.data.discussions.map((d) => (
                  <PulseRow
                    key={d.number}
                    icon={<CommentDiscussionIcon className="fg-muted" />}
                    to={`${base}/${d.kind}/${d.number}`}
                    title={d.title}
                    meta={
                      <>
                        <span className="num">#{d.number}</span> commented on <RelativeTime date={new Date(d.date)} /> • {d.comments} {pl(d.comments, 'new comment', 'new comments')}
                      </>
                    }
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function PulseOverviewBox({ data, base }: { data: PulseOverview; base: string }) {
  const c = data.counts
  const totalPulls = c.merged + c.opened
  const totalIssues = c.closed + c.issues
  const ratio = (n: number, of: number) => (of === 0 ? 0 : (n / of) * 100)
  const merged = ratio(c.merged, totalPulls)
  const opened = ratio(c.opened, totalPulls)
  const closed = ratio(c.closed, totalIssues)
  const newer = ratio(c.issues, totalIssues)
  const stats: Array<{ href: string; icon: ReactNode; count: number; label: string }> = [
    { href: '#merged-pull-requests', icon: <GitMergeIcon className="fg-done" />, count: c.merged, label: 'Merged pull requests' },
    { href: '#opened-pull-requests', icon: <GitPullRequestIcon className="fg-success" />, count: c.opened, label: 'Open pull requests' },
    { href: '#closed-issues', icon: <IssueClosedIcon className="fg-done" />, count: c.closed, label: 'Closed issues' },
    { href: '#opened-issues', icon: <IssueOpenedIcon className="fg-success" />, count: c.issues, label: 'New issues' },
  ]
  const bar = (parts: Array<{ value: number; color: string; label: string; to: string }>, total: number, label: string) => (
    <div className="pulse-overview-half">
      <div className="pulse-progress">
        <ProgressBar aria-label={label}>
          {parts.map((p) => (
            <ProgressBar.Item key={p.label} progress={p.value} aria-label={p.label} style={{ backgroundColor: p.color }} />
          ))}
        </ProgressBar>
        {parts.reduce<{ left: number; nodes: ReactNode[] }>(
          (acc, p) => {
            if (p.value > 0) acc.nodes.push(<Link key={p.label} to={p.to} className="pulse-progress-link" style={{ left: `${acc.left}%`, width: `${p.value}%` }} aria-label={`View ${p.label.toLowerCase()}`} />)
            acc.left += p.value
            return acc
          },
          { left: 0, nodes: [] },
        ).nodes}
      </div>
      <div className="mt-2">
        <span className="text-bold fg-default">{total}</span> {label}
      </div>
    </div>
  )
  return (
    <div className="Box">
      <div className="Box-header">
        <h3 className="Box-title">Overview</h3>
      </div>
      <div className="pulse-overview-row">
        {bar(
          [
            { value: merged, color: 'var(--bgColor-done-emphasis)', label: 'Merged pull requests', to: `${base}/pulls?q=${encodeURIComponent('is:pr is:closed')}` },
            { value: opened, color: 'var(--bgColor-success-emphasis)', label: 'Open pull requests', to: `${base}/pulls?q=${encodeURIComponent('is:pr is:open')}` },
          ],
          totalPulls,
          'Active pull requests',
        )}
        {bar(
          [
            { value: closed, color: 'var(--bgColor-danger-emphasis)', label: 'Closed issues', to: `${base}/issues?q=${encodeURIComponent('is:issue is:closed')}` },
            { value: newer, color: 'var(--bgColor-success-emphasis)', label: 'Open issues', to: `${base}/issues?q=${encodeURIComponent('is:issue is:open')}` },
          ],
          totalIssues,
          'Active issues',
        )}
      </div>
      <ul className="pulse-stats">
        {stats.map((s) => (
          <li key={s.href}>
            <a href={s.href} onClick={(e) => {
              e.preventDefault()
              document.getElementById(s.href.slice(1))?.scrollIntoView({ behavior: 'smooth' })
            }}>
              <span className="pulse-stat-count">
                {s.icon} {s.count}
              </span>
              <span className="fg-muted">{s.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PulseSummary({ data }: { data: NonNullable<ReturnType<typeof usePulseCommits>['data']> }) {
  const n = (v: number, one: string) => `${v.toLocaleString()} ${pl(v, one)}`
  const lines = (
    <>
      <strong className="fg-success">{data.additions.toLocaleString()}</strong> <strong className="fg-default">{pl(data.additions, 'addition')}</strong> and{' '}
      <strong className="fg-danger">{data.deletions.toLocaleString()}</strong> <strong className="fg-default">{pl(data.deletions, 'deletion')}</strong>
    </>
  )
  return (
    <div className="pulse-summary">
      <div className="pulse-summary-box">
        <h3 className="pulse-summary-title">Summary</h3>
        <p className="pulse-summary-text">
          Excluding merges, <strong>{n(data.authorsWithCommits, 'author')}</strong> {data.authorsWithCommits === 1 ? 'has' : 'have'} pushed <strong>{n(data.masterCommits, 'commit')}</strong> to {data.defaultBranch} and{' '}
          <strong>{n(data.totalCommits, 'commit')}</strong> to all branches.
        </p>
        <p className="pulse-summary-text">
          On {data.defaultBranch}, <strong>{n(data.filesChanged, 'file')}</strong> {data.filesChanged === 1 ? 'has' : 'have'} changed and there have been{' '}
          {data.comparePath ? (
            <Link to={data.comparePath} className="link-muted">
              {lines}
            </Link>
          ) : (
            lines
          )}
        </p>
      </div>
      <div className="pulse-summary-chart">
        <ChartCard title="Top committers" titleAs="h2">
          <CommitterChart committers={data.committers} />
        </ChartCard>
      </div>
    </div>
  )
}

function CommitterChart({ committers }: { committers: Committer[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 126
  const pad = { top: 8, right: 8, bottom: 26, left: 36 }
  const max = Math.max(1, ...committers.map((c) => c.commits))
  const ticks = niceTicks(0, max, 4)
  const top = ticks.at(-1)!
  const plotW = Math.max(0, width - pad.left - pad.right)
  const slot = plotW / Math.max(1, committers.length)
  const barW = Math.max(2, slot * 0.7)
  const y = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - v / top)
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`Top committers: ${committers.map((c) => `${c.login ?? c.name} ${c.commits}`).join(', ')}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--borderColor-muted)" />
              <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--fgColor-muted)">
                {t < 1000 ? t : `${Math.round(t / 1000)}k`}
              </text>
            </g>
          ))}
          {committers.map((c, i) => {
            const x = pad.left + i * slot + (slot - barW) / 2
            return (
              <g key={c.login ?? c.name} onMouseEnter={() => setHover(i)}>
                <rect x={pad.left + i * slot} y={pad.top} width={slot} height={H - pad.top - pad.bottom} fill="transparent" />
                <rect x={x} y={y(c.commits)} width={barW} height={Math.max(0, y(0) - y(c.commits))} fill="var(--data-green-color-emphasis)" opacity={hover === null || hover === i ? 1 : 0.6} />
              </g>
            )
          })}
        </svg>
      )}
      <div className="pulse-committer-avatars" style={{ left: pad.left, width: plotW }}>
        {committers.map((c) => (
          <span key={c.login ?? c.name} style={{ width: `${100 / Math.max(1, committers.length)}%` }}>
            {c.login ? (
              <Link to={`/${c.login}`} aria-label={c.login}>
                <img src={c.avatar ?? ''} alt={c.login} width={16} height={16} />
              </Link>
            ) : (
              <span className="pulse-committer-unknown" title={c.name} />
            )}
          </span>
        ))}
      </div>
      {hover !== null && committers[hover] && (
        <div role="tooltip" className="insights-tooltip" style={{ left: pad.left + hover * slot + slot / 2, top: 0 }}>
          {committers[hover].commits} {pl(committers[hover].commits, 'commit')} authored by {committers[hover].login ?? committers[hover].name}
        </div>
      )}
    </div>
  )
}

function PulseSection({ icon, id, count, title, people, children }: { icon: ReactNode; id: string; count: number; title: string; people: number; children: ReactNode }) {
  return (
    <section className="pulse-section">
      <h3 className="pulse-list-heading" id={id}>
        <span className="pulse-list-heading-inner">
          {icon} <strong className="fg-default">{count}</strong> {title} <strong className="fg-default">{people}</strong> {pl(people, 'person', 'people')}
        </span>
      </h3>
      <ul className="pulse-list">{children}</ul>
    </section>
  )
}

function PulseRow({ icon, to, title, meta }: { icon: ReactNode; to: string; title: string; meta: ReactNode }) {
  return (
    <li className="pulse-row">
      <span className="pulse-row-icon">{icon}</span>
      <div className="pulse-row-body">
        <Link to={to} className="pulse-row-title">
          <InlineTitle text={title} />
        </Link>
        <p className="fg-muted text-small">{meta}</p>
      </div>
    </li>
  )
}

function PulseList({ kind, verb, id, items, total, people, base }: { kind: 'pull' | 'issues'; verb: 'merged' | 'opened' | 'closed'; id: string; items: PulseItem[]; total: number; people: number; base: string }) {
  if (!items.length) return null
  const icon =
    kind === 'pull' ? (
      verb === 'merged' ? <GitMergeIcon className="fg-done" /> : <GitPullRequestIcon className="fg-success" />
    ) : verb === 'opened' ? (
      <IssueOpenedIcon className="fg-success" />
    ) : (
      <IssueClosedIcon className="fg-done" />
    )
  const noun = kind === 'pull' ? 'pull request' : 'issue'
  return (
    <PulseSection icon={icon} id={id} count={Math.max(total, items.length)} title={`${pl(Math.max(total, items.length), noun)} ${verb} by`} people={people}>
      {items.map((it) => (
        <PulseRow
          key={it.number}
          icon={icon}
          to={`${base}/${kind}/${it.number}`}
          title={it.title}
          meta={
            <>
              <span className="num">#{it.number}</span> {verb} <RelativeTime date={new Date(it.date)} />
            </>
          }
        />
      ))}
    </PulseSection>
  )
}

/* ---------------------------------------------------------------- Graphs */

function GraphHeading({ prefix }: { prefix: string }) {
  const { owner, repo } = useRepo()
  return (
    <h2 className="insights-graph-heading">
      <div>
        <span>{prefix}</span>
        <strong>
          {owner}/{repo}
        </strong>
      </div>
    </h2>
  )
}

function CommitActivity() {
  const { owner, repo } = useRepo()
  const { octokit } = useGitHub()
  const activity = useStats<Array<{ week: number; total: number }>>('commit-activity', () => octokit.rest.repos.getCommitActivityStats({ owner, repo }))
  if (activity.isLoading) return <Loading label="GitHub is computing statistics" />
  if (activity.error) return <ErrorBox error={activity.error} />
  const weeks = activity.data!
  if (!weeks.length)
    return (
      <Blankslate icon={<GraphIcon size={24} />} title="Sorry, No Data Found">
        This repository has no recorded commit activity.
      </Blankslate>
    )
  return (
    <>
      <GraphHeading prefix="Commits over the last year of " />
      <TableToggleCard
        title="Commits"
        description="Number of commits per week"
        rows={weeks.map((w) => ({ week: w.week * 1000, values: [w.total] }))}
        columns={['Commits']}
        chart={<ColumnChart height={432} yTitle="Commits" series={[{ name: 'Commits', color: 'var(--data-green-color-emphasis)', points: weeks.map((w) => [w.week * 1000, w.total]) }]} monthTicks />}
      />
    </>
  )
}

function CodeFrequency() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const freq = useQuery({
    queryKey: [key, 'stats', 'code-frequency', owner, repo],
    queryFn: async () => {
      try {
        const res = await octokit.rest.repos.getCodeFrequencyStats({ owner, repo })
        if ((res.status as number) === 204) return { weeks: [] as Array<[number, number, number]>, tooLarge: false }
        if (res.status === 202 || !Array.isArray(res.data)) throw new StatsPending('GitHub is computing these statistics. Retrying…')
        return { weeks: res.data as Array<[number, number, number]>, tooLarge: false }
      } catch (err) {
        // GitHub refuses this graph for repositories with 10,000 or more commits.
        if ((err as { status?: number }).status === 422) return { weeks: [] as Array<[number, number, number]>, tooLarge: true }
        throw err
      }
    },
    retry: (count, err) => err instanceof StatsPending && count < 8,
    retryDelay: 2500,
    staleTime: 10 * 60_000,
  })
  if (freq.isLoading) return <Loading label="GitHub is computing statistics" />
  if (freq.error) return <ErrorBox error={freq.error} />
  if (freq.data!.tooLarge) {
    const docs = 'https://docs.github.com/repositories/viewing-activity-and-data-for-your-repository/analyzing-changes-to-a-repositorys-content'
    return (
      <div className="insights-too-large">
        <h2 className="insights-too-large-title">There are too many commits to generate this graph.</h2>
        <p>
          More information about this data can be found in the{' '}
          <a
            href={docs}
            onClick={(e) => {
              e.preventDefault()
              openExternal(docs)
            }}
          >
            activity documentation
          </a>
          .
        </p>
      </div>
    )
  }
  const weeks = freq.data!.weeks
  if (!weeks.length)
    return (
      <Blankslate icon={<GraphIcon size={24} />} title="Sorry, No Data Found">
        This repository has no recorded code frequency.
      </Blankslate>
    )
  return (
    <>
      <GraphHeading prefix="Code frequency over the history of " />
      <TableToggleCard
        title="Code frequency"
        description="Additions and deletions per week"
        legend={[
          ['Additions', 'var(--data-green-color-emphasis)'],
          ['Deletions', 'var(--data-red-color-emphasis)'],
        ]}
        rows={weeks.map(([w, a, d]) => ({ week: w * 1000, values: [a, d] }))}
        columns={['Additions', 'Deletions']}
        chart={
          <ColumnChart
            height={432}
            yTitle="Frequency"
            series={[
              { name: 'Additions', color: 'var(--data-green-color-emphasis)', points: weeks.map(([w, a]) => [w * 1000, a]) },
              { name: 'Deletions', color: 'var(--data-red-color-emphasis)', points: weeks.map(([w, , d]) => [w * 1000, d]) },
            ]}
          />
        }
      />
    </>
  )
}

type Metric = 'commits' | 'additions' | 'deletions'
const METRICS: Record<Metric, string> = { commits: 'Commits', additions: 'Additions', deletions: 'Deletions' }
const RANGES: Array<{ name: string; months: number }> = [
  { name: 'All', months: 0 },
  { name: 'Last month', months: 1 },
  { name: 'Last 3 months', months: 3 },
  { name: 'Last 6 months', months: 6 },
  { name: 'Last 12 months', months: 12 },
  { name: 'Last 24 months', months: 24 },
]
/** Start of a "Last N months" range as github.com computes it: N months back, snapped to the preceding Saturday. */
function rangeStart(months: number) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setMonth(d.getMonth() - months)
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7))
  return d.getTime()
}
/** github.com writes range dates into the URL as M/D/YYYY. */
const urlDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}
const parseDay = (v: string | null, endOfDay = false) => {
  if (!v) return undefined
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v)
  if (Number.isNaN(d.getTime())) return undefined
  if (endOfDay) d.setHours(23, 59, 59, 999)
  else d.setHours(0, 0, 0, 0)
  return d.getTime()
}

type ContributorStat = { author: { login: string; avatar_url: string } | null; total: number; weeks: Array<{ w?: number; a?: number; d?: number; c?: number }> }

function Contributors() {
  const { owner, repo, data } = useRepo()
  const { octokit } = useGitHub()
  const [params, setParams] = useSearchParams()
  const contributors = useStats<ContributorStat[]>('contributors', () => octokit.rest.repos.getContributorsStats({ owner, repo }))
  const metric: Metric = (Object.keys(METRICS) as Metric[]).find((m) => m === params.get('selectedMetric')) ?? 'commits'
  const fromParam = parseDay(params.get('from'))
  const toParam = parseDay(params.get('to'), true)
  // Like github.com, default to the last three months unless a range (or "all") is in the URL.
  const from = params.has('all') ? 0 : fromParam ?? (toParam ? 0 : rangeStart(3))
  const to = toParam
  const range = RANGES.find((r) => (r.months === 0 ? from === 0 && !to : !to && rangeStart(r.months) === from))
  const update = (fn: (p: URLSearchParams) => void) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      fn(next)
      return next
    })

  const model = useMemo(() => {
    const list = (contributors.data ?? []).filter((c) => c.author)
    const inRange = (w: { w?: number }) => (w.w ?? 0) * 1000 >= from && (!to || (w.w ?? 0) * 1000 <= to)
    const weekMap = new Map<number, { commits: number; additions: number; deletions: number }>()
    const people = list
      .map((c, index) => {
        const weeks = c.weeks.filter(inRange).map((w) => ({ week: (w.w ?? 0) * 1000, commits: w.c ?? 0, additions: w.a ?? 0, deletions: w.d ?? 0 }))
        for (const w of weeks) {
          const cur = weekMap.get(w.week) ?? { commits: 0, additions: 0, deletions: 0 }
          cur.commits += w.commits
          cur.additions += w.additions
          cur.deletions += w.deletions
          weekMap.set(w.week, cur)
        }
        const totals = weeks.reduce((s, w) => ({ commits: s.commits + w.commits, additions: s.additions + w.additions, deletions: s.deletions + w.deletions }), { commits: 0, additions: 0, deletions: 0 })
        return { author: c.author!, weeks, totals, overall: c.total, index }
      })
      .filter((p) => p.totals.commits > 0)
      // Ties go to the bigger all-time contributor, as on github.com.
      .sort((a, b) => b.totals[metric] - a.totals[metric] || b.overall - a.overall || b.index - a.index)
    const weeks = [...weekMap.entries()].sort((a, b) => a[0] - b[0])
    // GitHub stops reporting line counts for repositories past 10,000 commits.
    const onlyCommits = list.length > 0 && list.every((c) => c.weeks.every((w) => !w.a && !w.d))
    const max = Math.max(1, ...people.slice(0, 100).flatMap((p) => p.weeks.map((w) => w[metric])))
    return { people: people.slice(0, 100), weeks, onlyCommits, max }
  }, [contributors.data, from, to, metric])

  const label = METRICS[metric]
  const first = model.weeks[0]?.[0]
  const last = model.weeks.at(-1)?.[0]
  const day = (ms?: number) => (ms === undefined ? '' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))

  return (
    <div className="insights-contributors">
      <div className="contributors-header">
        <div className="contributors-title">
          <h1 className="contributors-heading">Contributors</h1>
          <p className="fg-muted">
            {model.onlyCommits
              ? `Contributions per week to ${data.default_branch}, line counts have been omitted because commit count exceeds 10,000.`
              : `Contributions per week to ${data.default_branch}, excluding merge commits`}
          </p>
        </div>
        <div className="flex gap-2">
          <ActionMenu>
            <ActionMenu.Button>
              <span className="text-bold">Period</span>: {range?.name ?? 'Custom range'}
            </ActionMenu.Button>
            <ActionMenu.Overlay width="auto">
              <ActionList selectionVariant="single">
                {RANGES.map((r) => (
                  <ActionList.Item
                    key={r.name}
                    selected={range?.name === r.name}
                    onSelect={() =>
                      update((p) => {
                        p.delete('from')
                        p.delete('to')
                        p.delete('all')
                        if (r.months === 0) p.set('all', 'true')
                        else p.set('from', urlDay(rangeStart(r.months)))
                      })
                    }
                  >
                    {r.name}
                  </ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          {!model.onlyCommits && (
            <ActionMenu>
              <ActionMenu.Button>
                <span className="fg-muted">Contributions:</span> {label}
              </ActionMenu.Button>
              <ActionMenu.Overlay width="auto">
                <ActionList selectionVariant="single">
                  {(Object.keys(METRICS) as Metric[]).map((m) => (
                    <ActionList.Item key={m} selected={m === metric} onSelect={() => update((p) => (m === 'commits' ? p.delete('selectedMetric') : p.set('selectedMetric', m)))}>
                      {METRICS[m]}
                    </ActionList.Item>
                  ))}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          )}
        </div>
      </div>
      {contributors.isLoading ? (
        <div className="text-center p-3">
          <Loading />
          <p className="fg-muted">Crunching the latest data, just for you. Hang tight…</p>
        </div>
      ) : contributors.error ? (
        <ErrorBox error={contributors.error} title="Graph could not be rendered" />
      ) : !model.people.length ? (
        <Blankslate icon={<GraphIcon size={24} />} title="We don't have enough data to generate this graph" />
      ) : (
        <div className="contributors-body">
          <ChartCard title={`${label} over time`} titleAs="h2" description={`Weekly from ${day(from || first)} to ${day(to ?? last)}`}>
            <ColumnChart height={256} tickPx={29} yTitle="Contributions" series={[{ name: label, color: 'var(--data-blue-color-emphasis)', points: model.weeks.map(([w, v]) => [w, v[metric]]) }]} />
          </ChartCard>
          <ul className="contributors-list">
            {model.people.map((p, i) => (
              <li key={p.author.login}>
                <ChartCard
                  titleAs="h2"
                  title={<Link to={`/${p.author.login}`}>{p.author.login}</Link>}
                  leading={
                    <Link to={`/${p.author.login}`} aria-label={p.author.login}>
                      <Avatar src={p.author.avatar_url} size={40} />
                    </Link>
                  }
                  trailing={<Label>#{i + 1}</Label>}
                  description={
                    <span className="contributors-author-description">
                      <Link to={`/${owner}/${repo}/commits?author=${encodeURIComponent(p.author.login)}`}>
                        {p.totals.commits.toLocaleString()} commit{p.totals.commits > 1 ? 's' : ''}
                      </Link>
                      {!model.onlyCommits && (
                        <span className="contributors-additions-deletions">
                          <span className="fg-success">{p.totals.additions.toLocaleString()} ++</span>
                          <span className="fg-danger">{p.totals.deletions.toLocaleString()} --</span>
                        </span>
                      )}
                    </span>
                  }
                >
                  <ColumnChart height={128} tickPx={25} yMax={model.max} series={[{ name: label, color: 'var(--data-blue-color-emphasis)', points: p.weeks.map((w) => [w.week, w[metric]]) }]} compact />
                </ChartCard>
              </li>
            ))}
            {model.people.length % 2 !== 0 && <li aria-hidden="true" />}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- Chart pieces */

function ChartCard({ title, titleAs: Title = 'h3', description, leading, trailing, actions, children }: { title: ReactNode; titleAs?: 'h2' | 'h3'; description?: ReactNode; leading?: ReactNode; trailing?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="insights-chart-card">
      <div className="insights-chart-card-header">
        <div className="insights-chart-card-content">
          {leading && <div className="insights-chart-card-leading">{leading}</div>}
          <div style={{ minWidth: 0 }}>
            <Title className="insights-chart-card-title">{title}</Title>
            {description && <div className="insights-chart-card-description">{description}</div>}
          </div>
        </div>
        {(trailing || actions) && (
          <div className="insights-chart-card-actions">
            {trailing}
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

/** A chart card with an accessible table view, like github.com's chart "View as table" control. */
function TableToggleCard({ title, description, chart, rows, columns, legend }: { title: string; description: string; chart: ReactNode; rows: Array<{ week: number; values: number[] }>; columns: string[]; legend?: Array<[string, string]> }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <ChartCard
      title={title}
      description={description}
      actions={
        <Button size="small" variant="invisible" leadingVisual={asTable ? GraphIcon : TableIcon} onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Chart' : 'Table'}
        </Button>
      }
    >
      {asTable ? (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <table className="file-table">
            <tbody>
              <tr>
                <td className="text-bold">Week of</td>
                {columns.map((c) => (
                  <td key={c} className="text-bold" style={{ textAlign: 'right' }}>
                    {c}
                  </td>
                ))}
              </tr>
              {[...rows].reverse().map((r) => (
                <tr key={r.week}>
                  <td>{new Date(r.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  {r.values.map((v, i) => (
                    <td key={i} style={{ textAlign: 'right' }}>
                      {v.toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="insights-chart-with-legend">
          <div style={{ flex: 1, minWidth: 0 }}>{chart}</div>
          {legend && (
            <ul className="insights-legend">
              {legend.map(([name, color]) => (
                <li key={name}>
                  <span className="insights-legend-swatch" style={{ background: color }} />
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ChartCard>
  )
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

function niceTicks(min: number, max: number, count: number) {
  const span = Math.max(1, max - min)
  // Counts are whole numbers, so steps never go below 1.
  const raw = Math.max(1, span / count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(Math.round(v))
  if (ticks.length < 2) ticks.push(ticks[0] + step)
  return ticks
}

const compactTick = (v: number) => (Math.abs(v) >= 1_000_000 ? `${Math.round(v / 100_000) / 10}M` : Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v))

/** Weekly column chart: one hue per series on a shared baseline, hover tooltip, sized to its container. */
function ColumnChart({ series: raw, height, yTitle, yMax, monthTicks, compact, tickPx = 60 }: { series: Array<{ name: string; color: string; points: Array<[number, number]> }>; height: number; yTitle?: string; yMax?: number; monthTicks?: boolean; compact?: boolean; tickPx?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  // Small charts in long lists draw only once scrolled into view.
  const [seen, setSeen] = useState(!compact)
  useEffect(() => {
    if (seen || !ref.current) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: '200px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [seen, ref])
  const pad = { top: 8, right: compact ? 36 : 44, bottom: 22, left: yTitle ? 24 : 8 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  // Group weeks (like github.com's data grouping) so every column stays at least 3px wide.
  const allXs = [...new Set(raw.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b)
  const group = plotW > 0 ? Math.max(1, Math.ceil((3 * allXs.length) / plotW)) : 1
  const xs = allXs.filter((_, i) => i % group === 0)
  const bucket = new Map(allXs.map((x, i) => [x, xs[Math.floor(i / group)]]))
  const series = raw.map((s) => {
    const sums = new Map<number, number>()
    for (const [x, v] of s.points) sums.set(bucket.get(x)!, (sums.get(bucket.get(x)!) ?? 0) + v)
    return { ...s, points: [...sums.entries()] as Array<[number, number]> }
  })
  const values = series.flatMap((s) => s.points.map((p) => p[1]))
  const lo = Math.min(0, ...values)
  const hi = Math.max(1, (yMax ?? 0) * (group > 1 ? group : 1), ...values)
  const ticks = niceTicks(lo, hi, Math.max(2, Math.round(plotH / tickPx)))
  const tMin = ticks[0]
  const tMax = ticks.at(-1)!
  const slot = plotW / Math.max(1, xs.length)
  const barW = Math.max(1, slot - (slot > 4 ? 1 : 0))
  const y = (v: number) => pad.top + plotH * (1 - (v - tMin) / (tMax - tMin || 1))
  const index = new Map(xs.map((x, i) => [x, i]))

  // X labels: months for a year or so, otherwise years; keep them at least 48px apart.
  const labels: Array<{ i: number; text: string }> = []
  const span = (xs.at(-1) ?? 0) - (xs[0] ?? 0)
  const byMonth = monthTicks || span < 400 * 86_400_000
  const boundaries: Array<{ i: number; px: number; text: string }> = []
  let lastKey = ''
  xs.forEach((x, i) => {
    const d = new Date(x)
    const keyStr = byMonth ? `${d.getFullYear()}-${d.getMonth()}` : String(d.getFullYear())
    if (keyStr !== lastKey) {
      lastKey = keyStr
      boundaries.push({ i, px: pad.left + i * slot, text: byMonth ? d.toLocaleDateString('en-US', { month: 'short' }) : String(d.getFullYear()) })
    }
  })
  // The first label usually marks a partial period: when it crowds the next boundary, drop it rather than that one.
  if (boundaries.length > 1 && boundaries[1].px - boundaries[0].px < 48) boundaries.shift()
  let lastX = -Infinity
  for (const b of boundaries) {
    if (b.px - lastX < 48) continue
    labels.push({ i: b.i, text: b.text })
    lastX = b.px
  }

  return (
    <div ref={ref} style={{ position: 'relative', minHeight: height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && seen && (
        <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.name).join(' and ')} per week`}>
          {yTitle && (
            <text transform={`translate(10 ${pad.top + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="var(--fgColor-muted)">
              {yTitle}
            </text>
          )}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--borderColor-muted)" />
              <text x={pad.left + plotW + 5} y={y(t) + 4} fontSize={11} fill="var(--fgColor-muted)">
                {compactTick(t)}
              </text>
            </g>
          ))}
          {xs.map((x, i) => (
            <rect key={x} x={pad.left + i * slot} y={pad.top} width={slot} height={plotH} fill={hover === i ? 'var(--bgColor-neutral-muted)' : 'transparent'} onMouseEnter={() => setHover(i)} />
          ))}
          {series.map((s) =>
            s.points.map(([x, v]) => {
              const i = index.get(x)!
              const top = y(Math.max(0, v))
              const h = Math.abs(y(v) - y(0))
              return h > 0 ? <rect key={`${s.name}-${x}`} x={pad.left + i * slot + (slot - barW) / 2} y={top} width={barW} height={h} rx={Math.min(2, barW / 2)} fill={s.color} pointerEvents="none" /> : null
            }),
          )}
          {labels.map((l) => (
            <text key={l.i} x={pad.left + l.i * slot} y={height - 6} fontSize={11} fill="var(--fgColor-muted)">
              {l.text}
            </text>
          ))}
        </svg>
      )}
      {hover !== null && xs[hover] !== undefined && (
        <div role="tooltip" className="insights-tooltip" style={{ left: Math.min(Math.max(pad.left + hover * slot + slot / 2, 80), Math.max(80, width - 80)), top: 0 }}>
          <div>{weekLabel(xs[hover])}</div>
          {series.map((s) => {
            const v = s.points.find((p) => p[0] === xs[hover])?.[1] ?? 0
            return (
              <div key={s.name}>
                <span className="insights-legend-swatch" style={{ background: s.color }} /> {s.name}: <strong>{v.toLocaleString()}</strong>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
