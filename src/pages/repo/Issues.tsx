import { Link } from 'react-router-dom'
import { Button } from '@primer/react'
import { useRepo } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { IssueList } from '../../components/IssueList'
import { useRepoLabels, useRepoMilestones, useManagePages } from './Pulls'

export function IssuesPage() {
  const { owner, repo, fullName, data } = useRepo()
  const labels = useRepoLabels(owner, repo)
  const milestones = useRepoMilestones(owner, repo)
  const manage = useManagePages(owner, repo)
  useAgentPageContext({
    label: `issues of ${fullName}`,
    owner,
    repo,
    suggestions: [{ label: 'Triage issues', prompt: `Triage the most recent open issues in ${fullName}: likely duplicates, which are bugs vs. feature requests, and which have enough info to act on.` }],
  })
  if (!data.has_issues) {
    return (
      <div className="container-xl">
        <div className="blankslate">
          <h3>Issues are disabled for this repository</h3>
        </div>
      </div>
    )
  }
  return (
    <div className="container-xl">
      <IssueList
        kind="issue"
        scope={`repo:${fullName}`}
        title="Issues"
        labels={labels.data}
        milestones={milestones.data}
        {...manage}
        actions={
          <Button as={Link} to={`/${owner}/${repo}/issues/new`} variant="primary">
            New issue
          </Button>
        }
      />
    </div>
  )
}
