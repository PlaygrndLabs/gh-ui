import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, ButtonGroup, FormControl, TextInput, Textarea } from '@primer/react'
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  CheckCircleFillIcon,
  XCircleFillIcon,
  AlertFillIcon,
  TriangleDownIcon,
  SyncIcon,
  SparkleFillIcon,
  GitPullRequestDraftIcon,
  TrashIcon,
  DotFillIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@primer/octicons-react'
import { useGitHub, errorMessage, markReadyForReview, type PullRequest } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { useAgent } from '../../../lib/agent/AgentProvider'
import { CheckStatusIcon } from '../../../components/Status'
import { useChecks, useReviews, useInvalidatePull, summarizeChecks, actionsIds, prPrompts } from './data'

type Method = 'merge' | 'squash' | 'rebase'
const METHOD_LABEL: Record<Method, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' }
const METHOD_BUTTON: Record<Method, string> = { merge: 'Merge pull request', squash: 'Squash and merge', rebase: 'Rebase and merge' }

export function MergeBox({ pr }: { pr: PullRequest }) {
  const { owner, repo, data: repoData } = useRepo()
  const { octokit, account } = useGitHub()
  const agent = useAgent()
  const checks = useChecks(owner, repo, pr.head.sha)
  const reviews = useReviews(owner, repo, pr.number)
  const invalidate = useInvalidatePull(owner, repo, pr.number)
  const summary = summarizeChecks(checks.data)
  const [showChecks, setShowChecks] = useState(summary.state === 'failure')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const methods = (['merge', 'squash', 'rebase'] as Method[]).filter((m) =>
    m === 'merge' ? repoData.allow_merge_commit !== false : m === 'squash' ? repoData.allow_squash_merge !== false : repoData.allow_rebase_merge !== false,
  )
  const [method, setMethod] = useState<Method>(methods.includes('squash') && repoData.allow_merge_commit === false ? 'squash' : methods[0] ?? 'merge')
  const [commitTitle, setCommitTitle] = useState('')
  const [commitBody, setCommitBody] = useState('')
  const canPush = !!pr.base.repo.permissions?.push || !!repoData.permissions?.push
  const sameRepoHead = pr.head.repo?.full_name === pr.base.repo.full_name

  const latestReviews = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of reviews.data ?? []) {
      if (!r.user || r.state === 'COMMENTED' || r.state === 'PENDING') continue
      m.set(r.user.login, r.state)
    }
    return m
  }, [reviews.data])
  const approvals = [...latestReviews.values()].filter((s) => s === 'APPROVED').length
  const changesRequested = [...latestReviews.entries()].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([u]) => u)

  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: (e) => setError(errorMessage(e)),
  })

  const failedRunIds = [
    ...new Set(
      (checks.data?.runs ?? [])
        .filter((r) => r.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(r.conclusion ?? ''))
        .map((r) => actionsIds(r.details_url)?.runId)
        .filter((x): x is number => !!x),
    ),
  ]

  if (pr.merged) {
    return (
      <div className="merge-box">
        <span className="merge-icon done" style={{ marginLeft: -56 }}>
          <GitMergeIcon size={24} />
        </span>
        <div className="Box" style={{ borderColor: 'var(--borderColor-done-emphasis)' }}>
          <div className="merge-section">
            <div className="flex-1">
              <div className="text-bold">Pull request successfully merged and closed</div>
              <div className="fg-muted text-small">You’re all set — the {pr.head.ref} branch can be safely deleted.</div>
            </div>
            {sameRepoHead && canPush && pr.head.ref !== repoData.default_branch && (
              <Button
                leadingVisual={TrashIcon}
                loading={action.isPending}
                onClick={() => action.mutate(() => octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` }))}
              >
                Delete branch
              </Button>
            )}
          </div>
          {error && <div className="merge-section fg-danger">{error}</div>}
        </div>
      </div>
    )
  }

  if (pr.state === 'closed') {
    return (
      <div className="merge-box">
        <span className="merge-icon danger" style={{ marginLeft: -56 }}>
          <GitPullRequestClosedIcon size={24} />
        </span>
        <div className="Box">
          <div className="merge-section">
            <div className="flex-1">
              <div className="text-bold">Closed with unmerged commits</div>
              <div className="fg-muted text-small">This pull request is closed.</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const ms = pr.mergeable_state
  const blockedByConflicts = ms === 'dirty'
  const iconTone = pr.draft ? 'neutral' : blockedByConflicts || summary.state === 'failure' || changesRequested.length ? 'danger' : ms === 'clean' && summary.state !== 'pending' ? 'success' : 'attention'

  return (
    <div className="merge-box">
      <span className={`merge-icon ${iconTone}`} style={{ marginLeft: -56 }}>
        {pr.draft ? <GitPullRequestDraftIcon size={24} /> : <GitMergeIcon size={24} />}
      </span>
      <div className="Box">
        {/* Reviews */}
        <div className="merge-section">
          {changesRequested.length ? (
            <XCircleFillIcon size={24} className="fg-danger" />
          ) : approvals ? (
            <CheckCircleFillIcon size={24} className="fg-success" />
          ) : (
            <DotFillIcon size={24} className="fg-attention" />
          )}
          <div className="flex-1">
            <div className="text-bold">{changesRequested.length ? 'Changes requested' : approvals ? 'Changes approved' : 'Review required'}</div>
            <div className="fg-muted text-small">
              {changesRequested.length
                ? `${changesRequested.join(', ')} requested changes.`
                : approvals
                  ? `${approvals} approving review${approvals === 1 ? '' : 's'}.`
                  : 'At least one approving review may be required by reviewers with write access.'}
            </div>
          </div>
        </div>

        {/* Checks */}
        <div className="merge-section" style={{ flexWrap: 'wrap' }}>
          {summary.state === 'success' ? (
            <CheckCircleFillIcon size={24} className="fg-success" />
          ) : summary.state === 'failure' ? (
            <XCircleFillIcon size={24} className="fg-danger" />
          ) : summary.state === 'pending' ? (
            <DotFillIcon size={24} className="fg-attention" />
          ) : (
            <CheckCircleFillIcon size={24} className="fg-muted" />
          )}
          <div className="flex-1">
            <div className="text-bold">
              {summary.state === 'success'
                ? 'All checks have passed'
                : summary.state === 'failure'
                  ? 'Some checks were not successful'
                  : summary.state === 'pending'
                    ? 'Some checks haven’t completed yet'
                    : summary.total
                      ? 'Checks completed'
                      : 'No checks reported'}
            </div>
            <div className="fg-muted text-small">
              {[summary.failed && `${summary.failed} failing`, summary.pending && `${summary.pending} in progress`, summary.skipped && `${summary.skipped} skipped`, summary.passed && `${summary.passed} successful`]
                .filter(Boolean)
                .join(', ') || (checks.isLoading ? 'Loading…' : '')}
            </div>
          </div>
          {summary.failed > 0 && (
            <>
              <Button size="small" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(prPrompts(owner, repo, pr).checks)}>
                Fix with agent
              </Button>
              {failedRunIds.length > 0 && canPush && (
                <Button
                  size="small"
                  leadingVisual={SyncIcon}
                  loading={action.isPending}
                  onClick={() => action.mutate(() => Promise.all(failedRunIds.map((id) => octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: id }))))}
                >
                  Re-run failed
                </Button>
              )}
            </>
          )}
          {summary.total > 0 && (
            <Button size="small" variant="invisible" trailingVisual={showChecks ? ChevronUpIcon : ChevronDownIcon} onClick={() => setShowChecks(!showChecks)}>
              {showChecks ? 'Hide' : 'Show'} all checks
            </Button>
          )}
        </div>
        {showChecks && (
          <div className="check-list">
            {(checks.data?.runs ?? []).map((r) => {
              const ids = actionsIds(r.details_url)
              return (
                <div key={r.id} className="check-row">
                  <CheckStatusIcon status={r.status} conclusion={r.conclusion} />
                  <span className="text-bold text-truncate">{r.name}</span>
                  <span className="fg-muted text-truncate flex-1">{r.output?.title ?? (r.app?.name ? `by ${r.app.name}` : '')}</span>
                  {ids ? (
                    <Link to={`/${owner}/${repo}/actions/runs/${ids.runId}${ids.jobId ? `/job/${ids.jobId}` : ''}`}>Details</Link>
                  ) : (
                    <Link to={`/${owner}/${repo}/pull/${pr.number}/checks?run=${r.id}`}>Details</Link>
                  )}
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

        {/* Mergeability */}
        <div className="merge-section">
          {pr.draft ? (
            <AlertFillIcon size={24} className="fg-muted" />
          ) : blockedByConflicts ? (
            <AlertFillIcon size={24} className="fg-danger" />
          ) : ms === 'behind' || ms === 'blocked' ? (
            <AlertFillIcon size={24} className="fg-attention" />
          ) : pr.mergeable === null ? (
            <DotFillIcon size={24} className="fg-attention" />
          ) : (
            <CheckCircleFillIcon size={24} className="fg-success" />
          )}
          <div className="flex-1">
            <div className="text-bold">
              {pr.draft
                ? 'This pull request is still a work in progress'
                : blockedByConflicts
                  ? 'This branch has conflicts that must be resolved'
                  : ms === 'behind'
                    ? 'This branch is out-of-date with the base branch'
                    : ms === 'blocked'
                      ? 'Merging is blocked'
                      : pr.mergeable === null
                        ? 'Checking for the ability to merge automatically…'
                        : 'No conflicts with base branch'}
            </div>
            <div className="fg-muted text-small">
              {pr.draft
                ? 'Draft pull requests cannot be merged.'
                : blockedByConflicts
                  ? 'Resolve conflicts locally or on GitHub, then push.'
                  : ms === 'behind'
                    ? 'Merge the latest changes from the base branch into this branch.'
                    : ms === 'blocked'
                      ? 'Branch protection requires reviews or passing status checks.'
                      : 'Changes can be cleanly merged.'}
            </div>
          </div>
          {pr.draft && (pr.user?.login === account.login || canPush) && (
            <Button loading={action.isPending} onClick={() => action.mutate(() => markReadyForReview(octokit, pr.node_id))}>
              Ready for review
            </Button>
          )}
          {ms === 'behind' && canPush && (
            <Button loading={action.isPending} onClick={() => action.mutate(() => octokit.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha }))}>
              Update branch
            </Button>
          )}
        </div>

        {canPush && !pr.draft && (
          <div className="merge-section" style={{ flexDirection: 'column', alignItems: 'stretch', background: 'var(--bgColor-muted)', borderRadius: '0 0 6px 6px' }}>
            {confirming ? (
              <>
                {method !== 'rebase' && (
                  <>
                    <FormControl>
                      <FormControl.Label>Commit message</FormControl.Label>
                      <TextInput block value={commitTitle} onChange={(e) => setCommitTitle(e.target.value)} />
                    </FormControl>
                    <FormControl>
                      <FormControl.Label>Extended description</FormControl.Label>
                      <Textarea block rows={4} value={commitBody} onChange={(e) => setCommitBody(e.target.value)} />
                    </FormControl>
                  </>
                )}
                <div className="flex-center gap-2">
                  <Button
                    variant="primary"
                    loading={action.isPending}
                    onClick={() =>
                      action.mutate(async () => {
                        await octokit.rest.pulls.merge({
                          owner,
                          repo,
                          pull_number: pr.number,
                          merge_method: method,
                          sha: pr.head.sha,
                          ...(method !== 'rebase' ? { commit_title: commitTitle, commit_message: commitBody } : {}),
                        })
                        setConfirming(false)
                      })
                    }
                  >
                    Confirm {method === 'squash' ? 'squash and merge' : method === 'rebase' ? 'rebase and merge' : 'merge'}
                  </Button>
                  <Button onClick={() => setConfirming(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <div className="flex-center gap-2">
                <ButtonGroup>
                  <Button
                    variant={ms === 'clean' || ms === 'unstable' || ms === 'has_hooks' ? 'primary' : 'default'}
                    disabled={blockedByConflicts || pr.mergeable === false}
                    onClick={() => {
                      setCommitTitle(method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.head.label}`)
                      setCommitBody(method === 'squash' ? '' : pr.title)
                      setConfirming(true)
                    }}
                  >
                    {METHOD_BUTTON[method]}
                  </Button>
                  {methods.length > 1 && (
                    <ActionMenu>
                      <ActionMenu.Anchor>
                        <Button variant={ms === 'clean' || ms === 'unstable' || ms === 'has_hooks' ? 'primary' : 'default'} aria-label="Select merge method" disabled={blockedByConflicts}>
                          <TriangleDownIcon />
                        </Button>
                      </ActionMenu.Anchor>
                      <ActionMenu.Overlay width="medium">
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
                {ms === 'blocked' && <span className="fg-muted text-small">Merging may be blocked until requirements are met.</span>}
              </div>
            )}
          </div>
        )}
        {error && (
          <div className="merge-section">
            <span className="fg-danger">{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}
