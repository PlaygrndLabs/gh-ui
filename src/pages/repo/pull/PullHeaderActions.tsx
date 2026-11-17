import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, TextInput } from '@primer/react'
import { EyeIcon, GitBranchIcon, GitPullRequestClosedIcon, GitPullRequestIcon, RepoIcon, TriangleDownIcon } from '@primer/octicons-react'
import { CopyButton } from '../../../components/Bits'
import { checkoutPlan } from '../../../lib/checkout'
import { errorMessage, markReadyForReview, useGitHub, type PullRequest } from '../../../lib/github'
import { parseRemote } from '../../../lib/links'
import { native, type LocalRepo } from '../../../lib/platform'
import { useInvalidatePull } from './data'

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

/**
 * Ready for review, Close and Reopen, which github.com's new overview page moved up into the header: nobody has to
 * scroll past the whole conversation to find them.
 */
export function PullStateActions({ pr, owner, repo }: { pr: PullRequest; owner: string; repo: string }) {
  const { octokit, account } = useGitHub()
  const invalidate = useInvalidatePull(owner, repo, pr.number)
  const allowed = pr.user?.login === account.login || !!pr.base.repo.permissions?.push
  const change = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: invalidate })
  if (!allowed || pr.merged) return null
  const setState = (state: 'open' | 'closed') => change.mutate(() => octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, state }))
  return (
    <>
      {pr.state === 'open' && pr.draft && (
        <Button size="small" leadingVisual={EyeIcon} loading={change.isPending} onClick={() => change.mutate(() => markReadyForReview(octokit, pr.node_id))}>
          Ready for review
        </Button>
      )}
      {pr.state === 'open' ? (
        <Button size="small" leadingVisual={GitPullRequestClosedIcon} loading={change.isPending} onClick={() => setState('closed')}>
          Close
        </Button>
      ) : (
        <Button size="small" leadingVisual={GitPullRequestIcon} loading={change.isPending} onClick={() => setState('open')}>
          Reopen
        </Button>
      )}
      {change.isError && <span className="fg-danger text-small">{errorMessage(change.error)}</span>}
    </>
  )
}
