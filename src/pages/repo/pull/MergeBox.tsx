import { useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, ButtonGroup, FormControl, TextInput, Textarea } from '@primer/react'
import {
  AlertFillIcon,
  CheckCircleFillIcon,
  CheckIcon,
  CommentDiscussionIcon,
  DotFillIcon,
  EyeIcon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  SparkleFillIcon,
  SyncIcon,
  TrashIcon,
  TriangleDownIcon,
  XCircleFillIcon,
  XIcon,
} from '@primer/octicons-react'
import { useGitHub, errorMessage, markReadyForReview, type PullRequest } from '../../../lib/github'
import { isNative } from '../../../lib/platform'
import { useRepo } from '../../../lib/repo'
import { useSharedPref } from '../../../lib/storage'
import { AgentOnly, useAgent } from '../../../lib/agent/AgentProvider'
import { CheckStatusIcon } from '../../../components/Status'
import { buildThreads } from '../../../components/Timeline'
import { useChecks, useReviews, useInvalidatePull, useReviewComments, useReviewThreads, usePullFiles, summarizeChecks, actionsIds, prPrompts, reviewStanding, rerunTargets } from './data'
import { readiness, type BlockerKind, type ReadinessTone } from './status'

type Method = 'merge' | 'squash' | 'rebase'
const METHOD_LABEL: Record<Method, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' }
const METHOD_BUTTON: Record<Method, string> = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' }

const TONE_ICON: Record<ReadinessTone, ReactNode> = {
  success: <GitMergeIcon size={16} />,
  attention: <GitPullRequestIcon size={16} />,
  danger: <GitPullRequestIcon size={16} />,
  neutral: <GitPullRequestDraftIcon size={16} />,
  done: <GitMergeIcon size={16} />,
}

const BLOCKER_ICON: Record<BlockerKind, ReactNode> = {
  draft: <GitPullRequestDraftIcon />,
  conflicts: <AlertFillIcon />,
  checks: <XCircleFillIcon />,
  changes: <XCircleFillIcon />,
  behind: <AlertFillIcon />,
  review: <DotFillIcon />,
  blocked: <AlertFillIcon />,
}

/**
 * Whether the pull request can merge, pinned at the top as github.com's new overview page has it: a title, the signals
 * behind it (checks, reviews, open threads, files viewed), what blocks it with the action that clears each blocker,
 * and the merge button itself, in a fraction of the old merge box's height.
 */
export function MergeReadiness({ pr }: { pr: PullRequest }) {
  const { owner, repo, data: repoData } = useRepo()
  const { octokit, account } = useGitHub()
  const { pathname } = useLocation()
  const agent = useAgent()
  const checks = useChecks(owner, repo, pr.head.sha)
  const reviews = useReviews(owner, repo, pr.number)
  const comments = useReviewComments(owner, repo, pr.number)
  const threadInfo = useReviewThreads(owner, repo, pr.number)
  const files = usePullFiles(owner, repo, pr.number)
  const [viewed] = useSharedPref<Record<string, string>>(`viewed:${owner}/${repo}#${pr.number}`, {})
  const invalidate = useInvalidatePull(owner, repo, pr.number)

  const summary = summarizeChecks(checks.data)
  const standing = reviewStanding(reviews.data)
  const state = readiness({ merged: pr.merged, state: pr.state, draft: pr.draft, mergeable: pr.mergeable, mergeableState: pr.mergeable_state, checks: summary, reviews: standing })
  const threads = useMemo(() => buildThreads(comments.data ?? [], threadInfo.data), [comments.data, threadInfo.data])
  const unresolved = threads.filter((t) => !t.info?.isResolved).length
  const viewedCount = (files.data ?? []).filter((f) => viewed[f.filename] === f.sha).length
  const waitingOn = [...(pr.requested_reviewers ?? []).map((u) => u.login), ...(pr.requested_teams ?? []).map((t) => t.name)]
  const reviewers = useMemo(() => {
    const latest = new Map<string, string>()
    for (const r of reviews.data ?? []) if (r.user && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')) latest.set(r.user.login, r.state)
    return latest
  }, [reviews.data])

  const [open, setOpen] = useState<'checks' | 'reviews' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const methods = (['squash', 'merge', 'rebase'] as Method[]).filter((m) =>
    m === 'merge' ? repoData.allow_merge_commit !== false : m === 'squash' ? repoData.allow_squash_merge !== false : repoData.allow_rebase_merge !== false,
  )
  const [method, setMethod] = useState<Method>(methods[0] ?? 'merge')
  const [commitTitle, setCommitTitle] = useState('')
  const [commitBody, setCommitBody] = useState('')
  const canPush = !!pr.base.repo.permissions?.push || !!repoData.permissions?.push
  const canAct = canPush || pr.user?.login === account.login
  const live = pr.state === 'open' && !pr.merged
  const targets = rerunTargets(checks.data?.runs ?? [])
  const canRerun = canPush && (targets.actionRuns.length > 0 || targets.checkRuns.length > 0)

  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: (e) => setError(errorMessage(e)),
  })
  const rerun = () =>
    action.mutate(() =>
      Promise.all([
        ...targets.actionRuns.map((run_id) => octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id })),
        ...targets.checkRuns.map((check_run_id) => octokit.rest.checks.rerequestRun({ owner, repo, check_run_id })),
      ]),
    )
  const startMerge = () => {
    setCommitTitle(method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.head.label}`)
    setCommitBody(method === 'squash' ? '' : pr.title)
    setConfirming(true)
  }

  const base = `/${owner}/${repo}/pull/${pr.number}`
  // Open threads show in the conversation, which the desktop app keeps beside whichever code tab is open.
  const threadsLink = { pathname: isNative && !pathname.endsWith('/checks') ? pathname : base, search: '?comments=unresolved' }
  const sameRepoHead = pr.head.repo?.full_name === pr.base.repo.full_name

  const blockerAction = (kind: BlockerKind) => {
    if (kind === 'draft' && canAct)
      return (
        <Button size="small" loading={action.isPending} onClick={() => action.mutate(() => markReadyForReview(octokit, pr.node_id))}>
          Ready for review
        </Button>
      )
    if (kind === 'behind' && canPush)
      return (
        <Button size="small" leadingVisual={SyncIcon} loading={action.isPending} onClick={() => action.mutate(() => octokit.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha }))}>
          Update branch
        </Button>
      )
    if (kind === 'checks')
      return (
        <>
          <AgentOnly>
            <Button size="small" variant="invisible" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(prPrompts(owner, repo, pr).checks)}>
              Fix with agent
            </Button>
          </AgentOnly>
          {canRerun && (
            <Button size="small" leadingVisual={SyncIcon} loading={action.isPending} onClick={rerun}>
              Re-run failed
            </Button>
          )}
        </>
      )
    if (kind === 'changes' || kind === 'review')
      return (
        <Button size="small" variant="invisible" onClick={() => setOpen(open === 'reviews' ? null : 'reviews')}>
          See reviews
        </Button>
      )
    return null
  }

  const mergeButton = live && canPush && !pr.draft && !confirming && (
    <ButtonGroup>
      <Button size="small" variant={state.ready ? 'primary' : 'default'} disabled={!state.mergeable} leadingVisual={GitMergeIcon} onClick={startMerge}>
        {METHOD_BUTTON[method]}
      </Button>
      {methods.length > 1 && (
        <ActionMenu>
          <ActionMenu.Anchor>
            <Button size="small" variant={state.ready ? 'primary' : 'default'} aria-label="Select merge method" disabled={!state.mergeable}>
              <TriangleDownIcon />
            </Button>
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="medium" align="end">
            <ActionList selectionVariant="single">
              {methods.map((m) => (
                <ActionList.Item key={m} selected={m === method} onSelect={() => setMethod(m)}>
                  {METHOD_LABEL[m]}
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      )}
    </ButtonGroup>
  )

  const canDeleteBranch = pr.merged && sameRepoHead && canPush && pr.head.ref !== repoData.default_branch
  // A merged or closed pull request's state label already says so; the card only stays for what's left to do.
  if (!live && !canDeleteBranch && !error) return null

  return (
    <section className={`pr-ready pr-ready-${state.tone}`} id="pr-merge" aria-label="Merge readiness">
      <div className="pr-ready-main">
        <span className="pr-ready-icon" aria-hidden>
          {pr.merged ? <GitMergeIcon size={16} /> : pr.state === 'closed' ? <GitPullRequestClosedIcon size={16} /> : TONE_ICON[state.tone]}
        </span>
        <div className="pr-ready-text">
          <div className="pr-ready-title">{state.title}</div>
          {live ? (
            <div className="pr-ready-signals">
              <button type="button" className={`pr-signal ${summary.failed ? 'fg-danger' : summary.pending ? 'fg-attention' : summary.total ? 'fg-success' : ''}`} aria-expanded={open === 'checks'} onClick={() => setOpen(open === 'checks' ? null : 'checks')} disabled={!summary.total}>
                {summary.failed ? <XCircleFillIcon size={12} /> : summary.pending ? <DotFillIcon size={12} /> : <CheckCircleFillIcon size={12} />}
                {!summary.total ? (checks.isLoading ? 'Checks…' : 'No checks') : summary.failed ? `${summary.failed} of ${summary.total} checks failing` : summary.pending ? `${summary.pending} of ${summary.total} checks running` : `${summary.passed} checks passed`}
              </button>
              <button type="button" className={`pr-signal ${standing.changesRequested ? 'fg-danger' : standing.approvals ? 'fg-success' : ''}`} aria-expanded={open === 'reviews'} onClick={() => setOpen(open === 'reviews' ? null : 'reviews')}>
                {standing.changesRequested ? <XCircleFillIcon size={12} /> : standing.approvals ? <CheckIcon size={12} /> : <EyeIcon size={12} />}
                {standing.changesRequested ? 'Changes requested' : standing.approvals ? `${standing.approvals} approval${standing.approvals === 1 ? '' : 's'}` : waitingOn.length ? `Waiting on ${waitingOn.length} reviewer${waitingOn.length === 1 ? '' : 's'}` : 'No reviews'}
              </button>
              <Link className={`pr-signal ${unresolved ? 'fg-attention' : ''}`} to={threadsLink}>
                <CommentDiscussionIcon size={12} />
                {unresolved ? `${unresolved} unresolved` : threads.length ? 'All threads resolved' : 'No review threads'}
              </Link>
              {isNative && (
                <Link className="pr-signal" to={`${base}/files`}>
                  <FileDiffIcon size={12} />
                  {viewedCount} of {pr.changed_files} viewed
                </Link>
              )}
            </div>
          ) : (
            <div className="pr-ready-sub">
              {pr.merged ? `${pr.merged_by?.login ?? 'Someone'} merged ${pr.head.ref} into ${pr.base.ref}.` : 'This pull request was closed without merging.'}
            </div>
          )}
        </div>
        <div className="pr-ready-actions">
          {mergeButton}
          {canDeleteBranch && (
            <Button size="small" leadingVisual={TrashIcon} loading={action.isPending} onClick={() => action.mutate(() => octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` }))}>
              Delete branch
            </Button>
          )}
        </div>
      </div>

      {live && state.blockers.length > 0 && (
        <ul className="pr-ready-blockers">
          {state.blockers.map((b) => (
            <li key={b.kind} className={`pr-blocker ${b.warn ? 'is-warn' : ''} pr-blocker-${b.kind}`}>
              <span className="pr-blocker-icon">{BLOCKER_ICON[b.kind]}</span>
              <span className="pr-blocker-text">
                {b.text}
                {b.warn && <span className="fg-muted"> · not required</span>}
              </span>
              <span className="pr-blocker-actions">{blockerAction(b.kind)}</span>
            </li>
          ))}
        </ul>
      )}

      {open === 'checks' && (
        <div className="pr-ready-detail check-list">
          {(checks.data?.runs ?? []).map((r) => {
            const ids = actionsIds(r.details_url)
            return (
              <div key={r.id} className="check-row">
                <CheckStatusIcon status={r.status} conclusion={r.conclusion} />
                <span className="text-bold text-truncate">{r.name}</span>
                <span className="fg-muted text-truncate flex-1">{r.output?.title ?? (r.app?.name ? `by ${r.app.name}` : '')}</span>
                <Link to={ids ? `/${owner}/${repo}/actions/runs/${ids.runId}${ids.jobId ? `/job/${ids.jobId}` : ''}` : `${base}/checks?run=${r.id}`}>Details</Link>
              </div>
            )
          })}
          {(checks.data?.statuses ?? []).map((s) => (
            <div key={s.id} className="check-row">
              <CheckStatusIcon status={s.state === 'pending' ? 'in_progress' : 'completed'} conclusion={s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure'} />
              <span className="text-bold text-truncate">{s.context}</span>
              <span className="fg-muted text-truncate flex-1">{s.description}</span>
              {s.target_url && (
                <a href={s.target_url} target="_blank" rel="noreferrer">
                  Details
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {open === 'reviews' && (
        <div className="pr-ready-detail check-list">
          {[...reviewers.entries()].map(([login, s]) => (
            <div key={login} className="check-row">
              {s === 'APPROVED' ? <CheckIcon className="fg-success" /> : <XCircleFillIcon className="fg-danger" />}
              <span className="text-bold">{login}</span>
              <span className="fg-muted flex-1">{s === 'APPROVED' ? 'approved' : 'requested changes'}</span>
            </div>
          ))}
          {waitingOn
            .filter((login) => !reviewers.has(login))
            .map((login) => (
              <div key={login} className="check-row">
                <DotFillIcon className="fg-attention" />
                <span className="text-bold">{login}</span>
                <span className="fg-muted flex-1">review requested</span>
              </div>
            ))}
          {!reviewers.size && !waitingOn.length && <div className="check-row fg-muted">Nobody has reviewed or been asked to review yet.</div>}
        </div>
      )}

      {confirming && (
        <div className="pr-ready-confirm">
          {method !== 'rebase' && (
            <>
              <FormControl>
                <FormControl.Label>Commit message</FormControl.Label>
                <TextInput block value={commitTitle} onChange={(e) => setCommitTitle(e.target.value)} />
              </FormControl>
              <FormControl>
                <FormControl.Label>Extended description</FormControl.Label>
                <Textarea block rows={3} value={commitBody} onChange={(e) => setCommitBody(e.target.value)} />
              </FormControl>
            </>
          )}
          <div className="flex-center gap-2">
            <Button
              size="small"
              variant="primary"
              loading={action.isPending}
              onClick={() =>
                action.mutate(async () => {
                  await octokit.rest.pulls.merge({ owner, repo, pull_number: pr.number, merge_method: method, sha: pr.head.sha, ...(method !== 'rebase' ? { commit_title: commitTitle, commit_message: commitBody } : {}) })
                  setConfirming(false)
                })
              }
            >
              Confirm {method === 'squash' ? 'squash and merge' : method === 'rebase' ? 'rebase and merge' : 'merge'}
            </Button>
            <Button size="small" leadingVisual={XIcon} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && <div className="pr-ready-error fg-danger">{error}</div>}
    </section>
  )
}
