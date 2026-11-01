import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@primer/react'
import { useGitHub } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { openExternal } from '../../lib/platform'
import { webUrl } from '../../lib/links'
import { IssueList } from '../../components/IssueList'

export function useRepoLabels(owner: string, repo: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'labels', owner, repo],
    staleTime: 5 * 60_000,
    queryFn: async () => octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 }),
  })
}

export function useRepoMilestones(owner: string, repo: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'milestones', owner, repo],
    staleTime: 5 * 60_000,
    queryFn: async () => octokit.paginate(octokit.rest.issues.listMilestones, { owner, repo, state: 'open', per_page: 100 }),
  })
}

/** Labels and milestones are managed on github.com; the list buttons open those pages. */
export function useManagePages(owner: string, repo: string) {
  const { account } = useGitHub()
  return {
    onOpenLabels: () => openExternal(webUrl(account.host, `/${owner}/${repo}/labels`)),
    onOpenMilestones: () => openExternal(webUrl(account.host, `/${owner}/${repo}/milestones`)),
  }
}

export function PullsPage() {
  const { owner, repo, fullName } = useRepo()
  const labels = useRepoLabels(owner, repo)
  const milestones = useRepoMilestones(owner, repo)
  const manage = useManagePages(owner, repo)
  useAgentPageContext({
    label: `pull requests of ${fullName}`,
    owner,
    repo,
    suggestions: [
      { label: 'Triage open PRs', prompt: `Triage the open pull requests in ${fullName}: group them by readiness (ready to merge, needs review, blocked by CI, stale), one line each.` },
      { label: 'Which PRs have failing CI?', prompt: `Which open pull requests in ${fullName} have failing checks right now? For each, give the failing check and a one-line guess at the cause.` },
    ],
  })
  return (
    <div className="container-xl">
      <IssueList
        kind="pr"
        scope={`repo:${fullName}`}
        title="All pull requests"
        labels={labels.data}
        milestones={milestones.data}
        {...manage}
        actions={
          <Button as={Link} to={`/${owner}/${repo}/compare`} variant="primary">
            New pull request
          </Button>
        }
      />
    </div>
  )
}
