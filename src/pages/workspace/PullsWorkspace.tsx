import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@primer/react'
import { GitPullRequestIcon } from '@primer/octicons-react'
import { useGitHub, type PullRequest } from '../../lib/github'
import { isNative } from '../../lib/platform'
import { useRepo } from '../../lib/repo'
import { useSharedPref } from '../../lib/storage'
import { buildThreads } from '../../components/Timeline'
import { CommitStatusMark, PullStateIcon, PullStateLabel } from '../../components/Status'
import { ErrorBox, Loading } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { SplitPane } from '../../components/SplitPane'
import { firstLine, shortSha } from '../../lib/format'
import { contentElementById } from '../../lib/scroll'
import { summarizeChecks, useChecks, usePullFiles, useReviews, useReviewComments, useReviewThreads } from '../repo/pull/data'
import { PullsPage } from '../repo/Pulls'
import { CloneDialog } from '../Local'
import { useCheckedOutBranch } from './ActionsWorkspace'

type PullFilter = 'all' | 'review' | 'mine'

interface PullNode {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  headRefName: string
  author: { login: string } | null
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

const REVIEW_NOTE: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }
const QUALIFIER: Record<PullFilter, string> = { all: '', review: 'is:open review-requested:@me', mine: 'is:open author:@me' }

function PullList() {
  const { owner, repo, fullName } = useRepo()
  const { octokit, key } = useGitHub()
  const { number } = useParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { branch } = useCheckedOutBranch(owner, repo)
  const [filter, setFilter] = useState<PullFilter>('all')
  const base = `/${owner}/${repo}`
  const pulls = useQuery({
    queryKey: [key, 'workspace-pulls', owner, repo, filter],
    staleTime: 30_000,
    queryFn: async () => {
      const res: { search: { nodes: PullNode[] } } = await octokit.graphql(
        `query($q:String!){ search(query:$q,type:ISSUE,first:50){ nodes{ ... on PullRequest{ number title state isDraft headRefName author{login} reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } }`,
        { q: `repo:${fullName} is:pr ${QUALIFIER[filter]} sort:updated-desc` },
      )
      return res.search.nodes
    },
  })
  // The checked-out branch's pull request comes first, wherever it would have sorted. This never changes the branch.
  const rows = useMemo(() => [...(pulls.data ?? [])].sort((a, b) => Number(b.headRefName === branch && b.state === 'OPEN') - Number(a.headRefName === branch && a.state === 'OPEN')), [pulls.data, branch])
  const first = rows[0]?.number
  useEffect(() => {
    if (first && pathname.replace(/\/$/, '') === `${base}/pulls`) navigate(`${base}/pull/${first}`, { replace: true })
  }, [first, pathname, base, navigate])

  const filters: Array<[PullFilter, string]> = [
    ['all', 'All'],
    ['review', 'To review'],
    ['mine', 'Mine'],
  ]
  return (
    <div className="ws-list">
      <div className="ws-list-head ws-filters" role="group" aria-label="Filter pull requests">
        {filters.map(([id, label]) => (
          <button key={id} type="button" className="ws-filter" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="ws-scroll">
        {pulls.isLoading ? (
          <Loading />
        ) : pulls.error ? (
          <div className="p-3">
            <ErrorBox error={pulls.error} />
          </div>
        ) : rows.length ? (
          rows.map((p) => {
            const check = p.commits.nodes[0]?.commit.statusCheckRollup?.state.toLowerCase() as 'success' | 'failure' | 'pending' | 'error' | undefined
            const review = p.reviewDecision ? REVIEW_NOTE[p.reviewDecision] : ''
            return (
              <Link key={p.number} className={`ws-list-row ${String(p.number) === number ? 'is-selected' : ''}`} to={`${base}/pull/${p.number}`} aria-current={String(p.number) === number ? 'page' : undefined}>
                <PullStateIcon pull={{ state: p.state === 'OPEN' ? 'open' : 'closed', merged: p.state === 'MERGED', draft: p.isDraft }} />
                <span className="ws-list-text">
                  <span className="ws-list-title">{firstLine(p.title)}</span>
                  <span className="ws-row-sub">
                    #{p.number} · {p.author?.login ?? 'ghost'}
                    {review && ` · ${review}`}
                  </span>
                  {p.headRefName === branch && p.state === 'OPEN' && <span className="ws-tag ws-tag-ok ws-list-tag">Current branch</span>}
                </span>
                {check && <CommitStatusMark state={check} />}
              </Link>
            )
          })
        ) : (
          <p className="ws-note p-3">{filter === 'review' ? 'Nothing waiting for your review.' : filter === 'mine' ? 'You have no open pull requests here.' : 'No pull requests yet. Push a branch to open one.'}</p>
        )}
      </div>
      <div className="ws-list-foot">
        <Link to={`${base}/pulls/all`}>Search and filter all</Link>
        <Button size="small" as={Link} to={`${base}/compare`} leadingVisual={GitPullRequestIcon}>
          New
        </Button>
      </div>
    </div>
  )
}

/** Pull requests on the left and the chosen one on the right. The web build keeps its full pages. */
export function PullsLayout() {
  const ctx = useRepo()
  if (!isNative) return <Outlet context={ctx} />
  return (
    <div className="ws-page">
      <SplitPane id="pulls" firstLabel="Pull requests" secondLabel="Pull request" defaultWidth={280} min={180} max={600} first={<PullList />} second={<Outlet context={ctx} />} />
    </div>
  )
}

export function PullsHome() {
  return isNative ? <div className="ws-empty">Choose a pull request to see it here.</div> : <PullsPage />
}

/** Everything that decides whether this can merge, always in view. */
export function PullStatusBar({ pr }: { pr: PullRequest }) {
  const { owner, repo } = useRepo()
  const checks = useChecks(owner, repo, pr.head.sha)
  const summary = summarizeChecks(checks.data)
  const reviews = useReviews(owner, repo, pr.number)
  const comments = useReviewComments(owner, repo, pr.number)
  const threadInfo = useReviewThreads(owner, repo, pr.number)
  const files = usePullFiles(owner, repo, pr.number)
  const [viewed] = useSharedPref<Record<string, string>>(`viewed:${owner}/${repo}#${pr.number}`, {})

  const latest = new Map<string, string>()
  for (const r of reviews.data ?? []) if (r.user && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED')) latest.set(r.user.login, r.state)
  const states = [...latest.values()]
  const review = states.includes('CHANGES_REQUESTED') ? { text: 'Changes requested', cls: 'ws-bad', mark: '✕' } : states.includes('APPROVED') ? { text: 'Approved', cls: 'ws-ok', mark: '✓' } : { text: 'No review yet', cls: '', mark: '○' }
  const check = checks.isLoading ? { text: 'Loading checks', cls: '', mark: '○' } : summary.failed ? { text: `${summary.failed} failing`, cls: 'ws-bad', mark: '✕' } : summary.pending ? { text: `${summary.pending} running`, cls: 'ws-run', mark: '●' } : summary.total ? { text: 'Checks passed', cls: 'ws-ok', mark: '✓' } : { text: 'No checks', cls: '', mark: '○' }
  const live = pr.state === 'open' && !pr.merged
  const conflicts = pr.mergeable_state === 'dirty'
  const unresolved = buildThreads(comments.data ?? [], threadInfo.data).filter((t) => !t.info?.isResolved).length
  const viewedCount = (files.data ?? []).filter((f) => viewed[f.filename] === f.sha).length
  const toMerge = () => contentElementById('pr-merge')?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  return (
    <div className="ws-status-bar">
      <PullStateLabel pull={pr} />
      <span className="ws-status-item">
        <span className={`ws-mark ${review.cls}`}>{review.mark}</span> {review.text}
      </span>
      <span className="ws-status-item">
        <span className={`ws-mark ${check.cls}`}>{check.mark}</span> {check.text}
      </span>
      {live && (
        <span className="ws-status-item">
          <span className={`ws-mark ${conflicts ? 'ws-bad' : pr.mergeable_state === 'unknown' ? '' : 'ws-ok'}`}>{conflicts ? '✕' : pr.mergeable_state === 'unknown' ? '○' : '✓'}</span> {conflicts ? 'Has conflicts' : pr.mergeable_state === 'unknown' ? 'Checking conflicts' : 'No conflicts'}
        </span>
      )}
      <span className="ws-status-item">
        {unresolved} open thread{unresolved === 1 ? '' : 's'}
      </span>
      <span className="ws-status-item">
        {viewedCount} of {pr.changed_files} files viewed
      </span>
      {live && (
        <span className="ws-status-end">
          <Button size="small" onClick={toMerge}>
            {pr.draft ? 'Ready for review' : 'Merge'}
          </Button>
        </span>
      )}
    </div>
  )
}

/** Checks out the pull request's branch, fetching it first; a repository with no folder here offers to clone. */
export function CheckoutButton({ pr }: { pr: PullRequest }) {
  const { owner, repo } = useRepo()
  const { folder, local, branch } = useCheckedOutBranch(owner, repo)
  const [cloning, setCloning] = useState(false)
  const fromFork = pr.head.repo?.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()
  if (fromFork || pr.state !== 'open' || (folder && branch === pr.head.ref)) return null
  if (!folder)
    return (
      <>
        <Button size="small" onClick={() => setCloning(true)}>
          Clone to check out
        </Button>
        {cloning && <CloneDialog initial={`${owner}/${repo}`} onClose={() => setCloning(false)} onCloned={() => setCloning(false)} />}
      </>
    )
  return (
    <Button
      size="small"
      loading={local.op.isPending}
      onClick={() =>
        local.op.mutate(async () => {
          await local.git!.fetch()
          local.switchBranch(pr.head.ref)
        })
      }
    >
      Check out branch
    </Button>
  )
}

/** The pull request's commits, or one commit's changes when its route names it. */
export function PullCommitsPane({ pr }: { pr: PullRequest }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const { '*': rest = '' } = useParams()
  const sha = rest.match(/^commits\/([0-9a-f]+)/i)?.[1] ?? null
  const base = `/${owner}/${repo}/pull/${pr.number}`
  const commits = useQuery({
    queryKey: [key, 'pull-commits', owner, repo, pr.number],
    queryFn: async () => octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: pr.number, per_page: 100 }),
  })
  const commit = useQuery({
    queryKey: [key, 'workspace-commit', owner, repo, sha],
    enabled: !!sha,
    queryFn: async () => (await octokit.rest.repos.getCommit({ owner, repo, ref: sha! })).data,
  })
  if (sha)
    return (
      <div className="ws-scroll ws-diff">
        <div className="ws-commit-head">
          <Link to={`${base}/commits`}>All commits</Link>
          <span className="ws-row-sub text-mono">{shortSha(sha)}</span>
          <Link className="ml-auto" to={`${base}/files`}>
            Show all changes
          </Link>
        </div>
        {commit.isLoading ? (
          <Loading />
        ) : commit.error ? (
          <ErrorBox error={commit.error} />
        ) : (
          <>
            <div className="text-bold mb-2">{firstLine(commit.data?.commit.message ?? '')}</div>
            {commit.data?.files?.map((f) => (
              <FileDiffBox key={f.filename} file={{ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null }} />
            ))}
          </>
        )}
      </div>
    )
  return (
    <div className="ws-scroll">
      {commits.isLoading ? (
        <Loading />
      ) : commits.error ? (
        <ErrorBox error={commits.error} />
      ) : (
        commits.data?.map((c) => (
          <Link key={c.sha} className="ws-list-row" to={`${base}/commits/${c.sha}`}>
            <span className="ws-list-text">
              <span className="ws-list-title">{firstLine(c.commit.message)}</span>
              <span className="ws-row-sub">
                {c.author?.login ?? c.commit.author?.name} · <span className="text-mono">{shortSha(c.sha)}</span>
              </span>
            </span>
          </Link>
        ))
      )}
    </div>
  )
}
