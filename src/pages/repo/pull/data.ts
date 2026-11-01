import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useGitHub, FULL_BODY, fetchReviewThreads, fetchPullReviewState, type PullRequest, type ReviewComment } from '../../../lib/github'
import type { LooseEvent } from '../../../components/Timeline'
import { isBot } from '../../../components/Bits'
import { anchorKey, lineAnchor } from '../../../components/DiffView'
import { parsePatch } from '../../../lib/diff'

export function usePull(owner: string, repo: string, number: number) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'pull', owner, repo, number],
    queryFn: async () => (await octokit.rest.pulls.get({ owner, repo, pull_number: number, ...FULL_BODY })).data as PullRequest & { body_html?: string },
    // mergeable is computed lazily by GitHub; poll until it settles.
    refetchInterval: (q) => (q.state.data && q.state.data.state === 'open' && q.state.data.mergeable === null ? 3000 : false),
  })
}

export function useTimeline(owner: string, repo: string, number: number) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'timeline', owner, repo, number],
    queryFn: async () =>
      (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, { owner, repo, issue_number: number, per_page: 100, ...FULL_BODY })) as unknown as LooseEvent[],
  })
}

export function useReviewComments(owner: string, repo: string, number: number) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'review-comments', owner, repo, number],
    queryFn: async () => (await octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100, ...FULL_BODY })) as Array<ReviewComment & { body_html?: string }>,
  })
}

export function useReviewThreads(owner: string, repo: string, number: number) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'review-threads', owner, repo, number],
    queryFn: () => fetchReviewThreads(octokit, owner, repo, number),
  })
}

/** The viewer's pending review (started here, on github.com or anywhere) and whether they can commit suggestions. */
export function usePullReviewState(owner: string, repo: string, number: number) {
  const { octokit, key, account } = useGitHub()
  return useQuery({
    queryKey: [key, 'review-state', owner, repo, number],
    queryFn: () => fetchPullReviewState(octokit, owner, repo, number, account.login),
  })
}

export function useReviews(owner: string, repo: string, number: number) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'reviews', owner, repo, number],
    queryFn: async () => octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
  })
}

export function usePullFiles(owner: string, repo: string, number: number) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'pull-files', owner, repo, number],
    queryFn: async () => octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
  })
}

/**
 * Code at each commentable line of a pull request's diff, keyed `${path}|${side}:${line}`. An unchanged line
 * is under RIGHT and LEFT, since github.com's split view lets a comment sit on either side of it.
 */
export function diffLineMap(files: Array<{ filename: string; patch?: string | null }> | undefined) {
  const m = new Map<string, string>()
  for (const f of files ?? []) {
    for (const l of parsePatch(f.patch)) {
      const a = lineAnchor(l)
      if (a) m.set(`${f.filename}|${anchorKey(a.side, a.line)}`, l.content)
      if (l.type === 'context' && l.oldNo !== null) m.set(`${f.filename}|${anchorKey('LEFT', l.oldNo)}`, l.content)
    }
  }
  return m
}

export function useChecks(owner: string, repo: string, sha: string | undefined) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'checks', owner, repo, sha],
    enabled: !!sha,
    queryFn: async () => {
      const [runs, status] = await Promise.all([
        octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: sha!, per_page: 100, filter: 'latest' }),
        octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha! }).then((r) => r.data).catch(() => null),
      ])
      return { runs, statuses: status?.statuses ?? [] }
    },
    refetchInterval: (q) => {
      const d = q.state.data
      const pending = d && (d.runs.some((r) => r.status !== 'completed') || d.statuses.some((s) => s.state === 'pending'))
      return pending ? 10_000 : false
    },
  })
}

export function useInvalidatePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient()
  const { key } = useGitHub()
  return () => {
    for (const k of ['pull', 'timeline', 'review-comments', 'review-threads', 'review-state', 'reviews', 'pull-files', 'pull-commits']) {
      void qc.invalidateQueries({ queryKey: [key, k, owner, repo, number] })
    }
    void qc.invalidateQueries({ queryKey: [key, 'checks', owner, repo] })
    void qc.invalidateQueries({ queryKey: [key, 'repo-counts', owner, repo] })
  }
}

export type CheckSummary = 'success' | 'failure' | 'pending' | 'neutral' | 'none'

export function summarizeChecks(data: { runs: Array<{ status: string; conclusion: string | null }>; statuses: Array<{ state: string }> } | undefined): {
  state: CheckSummary
  total: number
  failed: number
  pending: number
  passed: number
  skipped: number
} {
  if (!data) return { state: 'none', total: 0, failed: 0, pending: 0, passed: 0, skipped: 0 }
  let failed = 0
  let pending = 0
  let passed = 0
  let skipped = 0
  for (const r of data.runs) {
    if (r.status !== 'completed') pending++
    else if (['failure', 'timed_out', 'startup_failure', 'action_required'].includes(r.conclusion ?? '')) failed++
    else if (r.conclusion === 'cancelled') failed++
    else if (r.conclusion === 'skipped' || r.conclusion === 'neutral') skipped++
    else passed++
  }
  for (const s of data.statuses) {
    if (s.state === 'pending') pending++
    else if (s.state === 'success') passed++
    else failed++
  }
  const total = data.runs.length + data.statuses.length
  const state: CheckSummary = total === 0 ? 'none' : failed ? 'failure' : pending ? 'pending' : passed ? 'success' : 'neutral'
  return { state, total, failed, pending, passed, skipped }
}

/** "…/actions/runs/123/job/456" → run and job ids, for check runs created by GitHub Actions. */
export function actionsIds(detailsUrl: string | null | undefined): { runId: number; jobId: number | null } | null {
  const m = detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/)
  return m ? { runId: Number(m[1]), jobId: m[2] ? Number(m[2]) : null } : null
}

export function botThreadsSummary(comments: ReviewComment[] | undefined, threads: Map<number, { isResolved: boolean }> | undefined) {
  const bots = new Map<string, number>()
  for (const c of comments ?? []) {
    if (c.in_reply_to_id) continue
    if (!isBot(c.user?.login, c.user?.type)) continue
    if (threads?.get(c.id)?.isResolved) continue
    const login = c.user!.login
    bots.set(login, (bots.get(login) ?? 0) + 1)
  }
  return bots
}

export function prPrompts(owner: string, repo: string, pr: PullRequest) {
  const ref = `${owner}/${repo}#${pr.number}`
  const head = `head branch ${pr.head.ref} (head SHA ${pr.head.sha}${pr.head.repo && pr.head.repo.full_name !== `${owner}/${repo}` ? `, in fork ${pr.head.repo.full_name}` : ''})`
  return {
    review: `Review pull request ${ref}. Read the full diff and the surrounding code it touches, then report real problems (bugs, security, broken behavior, missing tests for risky logic) ranked by severity with file:line references. Do not post anything yet; I'll decide what to submit.`,
    bots: `Work through the unresolved review threads on ${ref} left by automated reviewers (CodeRabbit, Greptile, Copilot and similar). For each one, verify the claim against the code at the ${head}. Fix the valid ones with as few commits as sensible on ${pr.head.ref} (use expected_head_sha), then reply in each thread saying what changed with the commit SHA, and resolve it. For invalid or out-of-scope ones, reply briefly with the reasoning and leave them open. Finish with a table of what you did per thread.`,
    checks: `Find the failing or stuck checks on ${ref} (${head}). Read the relevant job logs, explain the root cause, and either fix it with a commit to ${pr.head.ref} if the code is at fault or re-run the failed jobs if it looks flaky. Tell me which you chose and why.`,
    summary: `Summarize ${ref}: what it changes and why, the riskiest parts, the state of reviews and CI, and any open questions in the discussion.`,
    description: `Draft a clear pull request description for ${ref} from its diff and commits (summary, motivation, notable changes, testing notes). Show me the draft; don't update the PR.`,
  }
}
