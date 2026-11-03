import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, TextInput } from '@primer/react'
import { AlertIcon, CheckCircleIcon, CommentDiscussionIcon, DotFillIcon, GitBranchIcon, RepoIcon, SyncIcon, TriangleDownIcon, XCircleIcon } from '@primer/octicons-react'
import { CopyButton } from '../../../components/Bits'
import { checkoutPlan } from '../../../lib/checkout'
import { errorMessage, useGitHub, type PullRequest } from '../../../lib/github'
import { parseRemote } from '../../../lib/links'
import { native, type LocalRepo } from '../../../lib/platform'
import { reviewStanding, rerunTargets, summarizeChecks, useChecks, useInvalidatePull, useReviews } from './data'

/** Local clones of this repository, found by their origin remote. */
function useLocalClones(owner: string, repo: string, host: string) {
  return useQuery({
    queryKey: ['local-clones', host, owner, repo],
    enabled: !!native,
    staleTime: 30_000,
    queryFn: async () => {
      const found: LocalRepo[] = []
      for (const local of await native!.repos.list()) {
        const res = await native!.git(local.id, ['remote', 'get-url', 'origin']).catch(() => null)
        const remote = res?.stdout ? parseRemote(res.stdout.trim()) : null
        if (remote?.host === host && remote.owner.toLowerCase() === owner.toLowerCase() && remote.repo.toLowerCase() === repo.toLowerCase()) found.push(local)
      }
      return found
    },
  })
}

/** Check out the pull request here in the app's own git, or copy the command for a terminal. */
export function CheckoutMenu({ pr, owner, repo }: { pr: PullRequest; owner: string; repo: string }) {
  const { account } = useGitHub()
  const clones = useLocalClones(owner, repo, account.host)
  const fromFork = !!pr.head.repo && pr.head.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
  const [result, setResult] = useState<{ ok: boolean; text: string; repo?: LocalRepo } | null>(null)
  const checkout = useMutation({
    mutationFn: async (local: LocalRepo) => {
      const auth = { token: account.token, host: account.host }
      const current = await native!.git(local.id, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const plan = checkoutPlan({ number: pr.number, headRef: pr.head.ref, fromFork }, current.stdout.trim() || null)
      for (const step of plan.steps) {
        const res = await native!.git(local.id, step, auth)
        if (res.code !== 0) throw new Error(res.stderr.trim() || `git ${step[0]} failed`)
      }
      return { branch: plan.branch, local }
    },
    onMutate: () => setResult(null),
    onSuccess: ({ branch, local }) => setResult({ ok: true, text: `On ${branch} in ${local.name}`, repo: local }),
    onError: (err) => setResult({ ok: false, text: errorMessage(err) }),
  })
  const command = `gh pr checkout ${pr.number}`
  return (
    <>
      <ActionMenu>
        <ActionMenu.Anchor>
          <Button size="small" leadingVisual={GitBranchIcon} trailingVisual={TriangleDownIcon} loading={checkout.isPending}>
            Check out
          </Button>
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium" align="end">
          {native && (
            <ActionList>
              {clones.data?.map((local) => (
                <ActionList.Item key={local.id} onSelect={() => checkout.mutate(local)}>
                  <ActionList.LeadingVisual>
                    <RepoIcon />
                  </ActionList.LeadingVisual>
                  Check out in {local.name}
                  <ActionList.Description variant="block">{local.path}</ActionList.Description>
                </ActionList.Item>
              ))}
              {clones.data?.length === 0 && (
                <ActionList.LinkItem as={Link} to={`/local?clone=${encodeURIComponent(pr.base.repo.clone_url)}`}>
                  Clone this repository…
                  <ActionList.Description variant="block">It isn't in your local repositories yet.</ActionList.Description>
                </ActionList.LinkItem>
              )}
              <ActionList.Divider />
            </ActionList>
          )}
          <div style={{ padding: 12 }}>
            <div className="text-small text-bold mb-1">Check out with GitHub CLI</div>
            <div className="flex-center gap-1">
              <TextInput block readOnly value={command} className="text-mono" aria-label="gh command" />
              <CopyButton text={command} label="Copy command" size="medium" />
            </div>
          </div>
        </ActionMenu.Overlay>
      </ActionMenu>
      {result && (
        <div className={`pr-checkout-result ${result.ok ? 'fg-success' : 'fg-danger'}`} role="status">
          {result.text}
          {result.repo && (
            <Button size="small" variant="invisible" onClick={() => void native!.openInEditor(result.repo!.id)}>
              Open in editor
            </Button>
          )}
          <Button size="small" variant="invisible" onClick={() => setResult(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </>
  )
}

/** The one line that says whether a pull request can move: checks, reviews and conflicts. */
export function PullStatusLine({ pr, owner, repo, canAct }: { pr: PullRequest; owner: string; repo: string; canAct: boolean }) {
  const { octokit } = useGitHub()
  const checks = useChecks(owner, repo, pr.head.sha)
  const reviews = useReviews(owner, repo, pr.number)
  const invalidate = useInvalidatePull(owner, repo, pr.number)
  const summary = summarizeChecks(checks.data)
  const standing = reviewStanding(reviews.data)
  const targets = rerunTargets(checks.data?.runs ?? [])
  const rerun = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled([
        ...targets.actionRuns.map((run_id) => octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id })),
        ...targets.checkRuns.map((check_run_id) => octokit.rest.checks.rerequestRun({ owner, repo, check_run_id })),
      ])
      const failed = results.find((r) => r.status === 'rejected')
      if (failed) throw (failed as PromiseRejectedResult).reason
    },
    onSettled: invalidate,
  })
  const base = `/${owner}/${repo}/pull/${pr.number}`
  const canRerun = canAct && (targets.actionRuns.length > 0 || targets.checkRuns.length > 0)
  const conflicts = pr.mergeable === false || pr.mergeable_state === 'dirty'
  return (
    <div className="pr-status" aria-label="Pull request status">
      {summary.total > 0 && (
        <Link to={`${base}/checks`} className={`pr-status-item ${summary.failed ? 'fg-danger' : summary.pending ? 'fg-attention' : 'fg-success'}`}>
          {summary.failed ? <XCircleIcon /> : summary.pending ? <DotFillIcon /> : <CheckCircleIcon />}
          {summary.failed ? `${summary.failed} failing` : summary.pending ? `${summary.pending} running` : `${summary.passed} passing`}
        </Link>
      )}
      <Link to={base} className={`pr-status-item ${standing.changesRequested ? 'fg-danger' : standing.approvals ? 'fg-success' : 'fg-muted'}`}>
        <CommentDiscussionIcon />
        {standing.changesRequested ? 'Changes requested' : standing.approvals ? `${standing.approvals} approved` : 'No reviews'}
      </Link>
      {conflicts && (
        <Link to={base} className="pr-status-item fg-danger">
          <AlertIcon /> Conflicts
        </Link>
      )}
      {canRerun && (
        <Button size="small" leadingVisual={SyncIcon} loading={rerun.isPending} onClick={() => rerun.mutate()}>
          Re-run failed
        </Button>
      )}
      {rerun.isError && <span className="fg-danger text-small">{errorMessage(rerun.error)}</span>}
    </div>
  )
}
