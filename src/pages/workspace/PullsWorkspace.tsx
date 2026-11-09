import { useEffect, useMemo } from 'react'
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@primer/react'
import { GitPullRequestIcon } from '@primer/octicons-react'
import { useGitHub, type PullRequest } from '../../lib/github'
import { isNative } from '../../lib/platform'
import { useRepo } from '../../lib/repo'
import { useSharedPref } from '../../lib/storage'
import { buildThreads } from '../../components/Timeline'
import { PullStateLabel } from '../../components/Status'
import { ErrorBox, Loading } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { firstLine, shortSha } from '../../lib/format'
import { contentElementById } from '../../lib/scroll'
import { usePullFiles, useReviewComments, useReviewThreads } from '../repo/pull/data'
import { PullStatusLine } from '../repo/pull/PullHeaderActions'
import { PullsPage } from '../repo/Pulls'
import { useCheckedOutBranch } from './ActionsWorkspace'

export type PullFilter = 'all' | 'review' | 'mine'

export interface PullNode {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  headRefName: string
  author: { login: string } | null
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

export const REVIEW_NOTE: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }
const QUALIFIER: Record<PullFilter, string> = { all: '', review: 'is:open review-requested:@me', mine: 'is:open author:@me' }

/** A repository's pull requests, newest activity first, with the checked-out branch's open one on top. */
export function usePullList(owner: string, repo: string, filter: PullFilter) {
  const { octokit, key } = useGitHub()
  const { branch } = useCheckedOutBranch(owner, repo)
  const pulls = useQuery({
    queryKey: [key, 'workspace-pulls', owner, repo, filter],
    enabled: !!owner && !!repo,
    staleTime: 30_000,
    // The header's list stays in view while pull requests open, change and merge, here or anywhere else.
    refetchInterval: 30_000,
    queryFn: async () => {
      const res: { search: { nodes: PullNode[] } } = await octokit.graphql(
        `query($q:String!){ search(query:$q,type:ISSUE,first:50){ nodes{ ... on PullRequest{ number title state isDraft headRefName author{login} reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } }`,
        { q: `repo:${owner}/${repo} is:pr ${QUALIFIER[filter]} sort:updated-desc` },
      )
      return res.search.nodes
    },
  })
  const isMine = (p: PullNode) => p.headRefName === branch && p.state === 'OPEN'
  // The checked-out branch's pull request comes first, wherever it would have sorted. This never changes the branch.
  const rows = useMemo(() => [...(pulls.data ?? [])].sort((a, b) => Number(isMine(b)) - Number(isMine(a))), [pulls.data, branch]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...pulls, rows, isMine }
}

/** The pull request picked in the header, using the window's full width. The web build keeps its full pages. */
export function PullsLayout() {
  const ctx = useRepo()
  const { owner, repo } = ctx
  const { number } = useParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const pulls = usePullList(owner, repo, 'all')
  const first = pulls.rows[0]?.number
  const base = `/${owner}/${repo}`
  // Opening a pull request the list doesn't have, such as one just created, means the list is behind.
  const { refetch } = pulls
  const missing = !!number && !!pulls.data && !pulls.data.some((p) => String(p.number) === number)
  useEffect(() => {
    if (isNative && missing) void refetch()
  }, [missing, number, refetch])
  useEffect(() => {
    if (isNative && first && pathname.replace(/\/$/, '') === `${base}/pulls`) navigate(`${base}/pull/${first}`, { replace: true })
  }, [first, pathname, base, navigate])
  if (!isNative) return <Outlet context={ctx} />
  return (
    <div className="ws-page">
      <Outlet context={ctx} />
    </div>
  )
}

export function PullsHome() {
  const { owner, repo } = useRepo()
  const pulls = usePullList(owner, repo, 'all')
  if (!isNative) return <PullsPage />
  const base = `/${owner}/${repo}`
  return (
    <div className="ws-empty">
      {pulls.isLoading ? (
        <Loading />
      ) : pulls.error ? (
        <ErrorBox error={pulls.error} />
      ) : (
        <div className="ws-empty-body">
          <p>{pulls.rows.length ? 'Choose a pull request from the menu at the top.' : 'No pull requests yet. Push a branch to open one.'}</p>
          <div className="ws-empty-actions">
            <Button as={Link} to={`${base}/compare`} leadingVisual={GitPullRequestIcon}>
              New pull request
            </Button>
            <Button as={Link} to={`${base}/pulls/all`}>
              Search and filter all
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Everything that decides whether this can merge, always in view. */
export function PullStatusBar({ pr }: { pr: PullRequest }) {
  const { owner, repo } = useRepo()
  const comments = useReviewComments(owner, repo, pr.number)
  const threadInfo = useReviewThreads(owner, repo, pr.number)
  const files = usePullFiles(owner, repo, pr.number)
  const [viewed] = useSharedPref<Record<string, string>>(`viewed:${owner}/${repo}#${pr.number}`, {})
  const live = pr.state === 'open' && !pr.merged
  const unresolved = buildThreads(comments.data ?? [], threadInfo.data).filter((t) => !t.info?.isResolved).length
  const viewedCount = (files.data ?? []).filter((f) => viewed[f.filename] === f.sha).length
  const toMerge = () => contentElementById('pr-merge')?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  return (
    <div className="ws-status-bar">
      <PullStateLabel pull={pr} />
      {live && <PullStatusLine pr={pr} owner={owner} repo={repo} canAct={!!pr.base.repo.permissions?.push} />}
      <span className="ws-status-item">
        {unresolved} open thread{unresolved === 1 ? '' : 's'}
      </span>
      <span className="ws-status-item">
        {viewedCount} of {pr.changed_files} files viewed
      </span>
      {live && (
        <span className="ws-status-end">
          <Button size="small" variant={!pr.draft && ['clean', 'unstable', 'has_hooks'].includes(pr.mergeable_state ?? '') ? 'primary' : 'default'} onClick={toMerge}>
            {pr.draft ? 'Ready for review' : 'Merge'}
          </Button>
        </span>
      )}
    </div>
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
            {commit.data?.files?.map((f, i) => (
              <FileDiffBox key={f.filename} eager={i < 3} file={{ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null }} />
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
