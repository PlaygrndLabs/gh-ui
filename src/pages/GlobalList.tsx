import { useAgentPageContext } from '../lib/agent/AgentProvider'
import { IssueList } from '../components/IssueList'

const PR_PRESETS = [
  { label: 'Created', scope: 'author:@me archived:false' },
  { label: 'Assigned', scope: 'assignee:@me archived:false' },
  { label: 'Mentioned', scope: 'mentions:@me archived:false' },
  { label: 'Review requests', scope: 'review-requested:@me archived:false' },
]

const ISSUE_PRESETS = [
  { label: 'Created', scope: 'author:@me archived:false' },
  { label: 'Assigned', scope: 'assignee:@me archived:false' },
  { label: 'Mentioned', scope: 'mentions:@me archived:false' },
]

export function GlobalListPage({ kind }: { kind: 'pr' | 'issue' }) {
  useAgentPageContext({
    label: kind === 'pr' ? 'their pull requests across GitHub' : 'their issues across GitHub',
    suggestions:
      kind === 'pr'
        ? [{ label: 'Prioritize my PRs', prompt: 'Go through my open pull requests and the ones requesting my review. Rank them by what I should do next (merge, address feedback, fix CI, review) with one line each.' }]
        : [{ label: 'Prioritize my issues', prompt: 'Go through the open issues assigned to me and rank them by urgency with one line each.' }],
  })
  return (
    <div className="container-xl">
      <IssueList key={kind} kind={kind} scope="" presets={kind === 'pr' ? PR_PRESETS : ISSUE_PRESETS} showRepo />
    </div>
  )
}
