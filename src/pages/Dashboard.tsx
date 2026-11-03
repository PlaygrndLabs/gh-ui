import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Avatar, Button, RelativeTime, TextInput } from '@primer/react'
import { PlayIcon, RepoIcon, SparkleFillIcon, EyeIcon, GitPullRequestIcon, IssueOpenedIcon, StarIcon, RepoForkedIcon, GitBranchIcon, TagIcon, CommentIcon, RepoPushIcon, LockIcon } from '@primer/octicons-react'
import { useGitHub } from '../lib/github'
import { useAgent, useAgentPageContext } from '../lib/agent/AgentProvider'
import { CheckStatusIcon, CommitStatusMark, IssueStateIcon, PullStateIcon } from '../components/Status'
import { Blankslate, Loading } from '../components/Bits'
import { useFeature } from '../lib/features'
import { actionsQueue } from '../lib/actionsQueue'

interface Item {
  __typename: 'PullRequest' | 'Issue'
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft?: boolean
  updatedAt: string
  repository: { nameWithOwner: string }
  author: { login: string } | null
  reviewDecision?: string | null
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

const ITEM = `__typename
  ... on PullRequest { number title state isDraft updatedAt repository{nameWithOwner} author{login} reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} }
  ... on Issue { number title state updatedAt repository{nameWithOwner} author{login} }`

export function Dashboard() {
  const activity = useFeature('activityFeed')
  const assigned = useFeature('assignedIssues')
  const actionsOn = useFeature('homeActions')
  const { octokit, key, account } = useGitHub()
  const agent = useAgent()
  const [filter, setFilter] = useState('')

  useAgentPageContext({
    label: 'their gh-ui dashboard',
    suggestions: [
      { label: 'What needs my attention?', prompt: 'Look at the pull requests waiting on my review, my own open pull requests (CI state, unresolved review comments) and issues assigned to me. Give me a prioritized to-do list for today.' },
      { label: 'Bot comments to handle', prompt: 'Across my open pull requests, which have unresolved comments from review bots like CodeRabbit or Greptile? List them with counts.' },
    ],
  })

  const repos = useQuery({
    queryKey: [key, 'dashboard-repos'],
    queryFn: async () => (await octokit.rest.repos.listForAuthenticatedUser({ sort: 'pushed', per_page: 50 })).data,
  })
  const focus = useQuery({
    queryKey: [key, 'dashboard-focus'],
    queryFn: async () => {
      const res: { reviews: { nodes: Item[]; issueCount: number }; mine: { nodes: Item[]; issueCount: number }; assigned: { nodes: Item[]; issueCount: number } } = await octokit.graphql(
        `query{
          reviews: search(query:"is:pr is:open archived:false review-requested:@me sort:updated-desc", type:ISSUE, first:8){ issueCount nodes{ ${ITEM} } }
          mine: search(query:"is:pr is:open archived:false author:@me sort:updated-desc", type:ISSUE, first:8){ issueCount nodes{ ${ITEM} } }
          assigned: search(query:"is:issue is:open archived:false assignee:@me sort:updated-desc", type:ISSUE, first:8){ issueCount nodes{ ${ITEM} } }
        }`,
      )
      return res
    },
  })
  const events = useQuery({
    queryKey: [key, 'dashboard-events'],
    queryFn: async () => (await octokit.rest.activity.listReceivedEventsForUser({ username: account.login, per_page: 30 })).data,
  })

  const shownRepos = (repos.data ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="layout-dashboard">
      <aside className="dashboard-sidebar">
        <div className="flex-center mb-2">
          <h2 className="text-bold flex-1" style={{ fontSize: 14, margin: 0 }}>
            Top repositories
          </h2>
        </div>
        <TextInput block size="small" placeholder="Find a repository…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a repository" className="mb-2" />
        {repos.isLoading ? (
          <Loading />
        ) : (
          shownRepos.slice(0, 30).map((r) => (
            <div key={r.id} className="repo-list-item">
              <Avatar src={r.owner.avatar_url} size={16} square={r.owner.type === 'Organization'} />
              <Link to={`/${r.full_name}`} className="text-truncate">
                {r.full_name}
              </Link>
              {r.private && <LockIcon size={12} className="fg-muted" />}
            </div>
          ))
        )}
      </aside>
      <main className="dashboard-main">
        <div className="flex-center gap-2 mb-3">
          <h2 className="section-title flex-1" style={{ margin: 0 }}>
            Home
          </h2>
          <Button leadingVisual={SparkleFillIcon} variant="primary" onClick={() => agent.ask('Look at the pull requests waiting on my review, my own open pull requests (CI state, unresolved review comments) and issues assigned to me. Give me a prioritized to-do list for today.')}>
            What needs my attention?
          </Button>
        </div>
        <div className="flex wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
          <FocusCard title="Review requests" icon={<EyeIcon />} items={focus.data?.reviews.nodes} total={focus.data?.reviews.issueCount} loading={focus.isLoading} to="/pulls?f=3" empty="No pull requests are waiting on your review." />
          <FocusCard title="Your pull requests" icon={<GitPullRequestIcon />} items={focus.data?.mine.nodes} total={focus.data?.mine.issueCount} loading={focus.isLoading} to="/pulls" empty="You have no open pull requests." />
          {assigned && <FocusCard title="Assigned issues" icon={<IssueOpenedIcon />} items={focus.data?.assigned.nodes} total={focus.data?.assigned.issueCount} loading={focus.isLoading} to="/issues?f=1" empty="No open issues are assigned to you." />}
          {actionsOn && <ActionsCard repos={repos.data} />}
        </div>
        {activity && (
          <>
            <h3 className="text-bold mt-4 mb-2" style={{ fontSize: 16 }}>
              Recent activity
            </h3>
            <div className="Box">
              {events.isLoading ? (
                <Loading />
              ) : events.data?.length ? (
                events.data.map((e) => <EventLine key={e.id} e={e} />)
              ) : (
                <Blankslate title="No recent activity">Follow people and star repositories to fill your feed.</Blankslate>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

const ACTIONS_REPOS = 8
const ACTIONS_RECENT_DAYS = 14

/** GitHub has no list of runs across repositories, so this asks the repositories pushed to most recently, a page each. */
function ActionsCard({ repos }: { repos?: Array<{ full_name: string; owner: { login: string }; name: string; archived?: boolean; pushed_at?: string | null }> }) {
  const { octokit, key } = useGitHub()
  const recent = (repos ?? []).filter((r) => !r.archived && r.pushed_at && Date.now() - Date.parse(r.pushed_at) < ACTIONS_RECENT_DAYS * 86_400_000).slice(0, ACTIONS_REPOS)
  const runs = useQuery({
    queryKey: [key, 'dashboard-actions', recent.map((r) => r.full_name)],
    enabled: !!repos,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const pages = await Promise.allSettled(recent.map((r) => octokit.rest.actions.listWorkflowRunsForRepo({ owner: r.owner.login, repo: r.name, per_page: 20 })))
      return pages.flatMap((p) => (p.status === 'fulfilled' ? p.value.data.workflow_runs : []))
    },
  })
  const queue = actionsQueue(runs.data ?? [], Date.now()).slice(0, 8)
  return (
    <div className="feed-card" style={{ flex: '1 1 320px', minWidth: 0 }}>
      <div className="Box-header compact">
        <PlayIcon />
        <span className="text-bold flex-1">Actions</span>
        <span className="counter">{queue.length}</span>
      </div>
      {runs.isLoading || !repos ? (
        <Loading />
      ) : queue.length ? (
        queue.map((run) => (
          <div key={run.id} className="Box-row hoverable">
            <span style={{ paddingTop: 2 }}>
              <CheckStatusIcon status={run.status} conclusion={run.conclusion} />
            </span>
            <div className="flex-1">
              <Link to={`/${run.repository.full_name}/actions/runs/${run.id}`} className="text-bold fg-default">
                {run.display_title || run.name}
              </Link>
              <div className="text-small fg-muted">
                {run.repository.full_name} · {run.head_branch} · <RelativeTime date={new Date(run.updated_at)} />
              </div>
            </div>
          </div>
        ))
      ) : (
        <div className="Box-row fg-muted text-small">Nothing failing or running in your recent repositories.</div>
      )}
    </div>
  )
}

function FocusCard({ title, icon, items, total, loading, to, empty }: { title: string; icon: React.ReactNode; items?: Item[]; total?: number; loading: boolean; to: string; empty: string }) {
  return (
    <div className="feed-card" style={{ flex: '1 1 320px', minWidth: 0 }}>
      <div className="Box-header compact">
        {icon}
        <span className="text-bold flex-1">{title}</span>
        {total !== undefined && <span className="counter">{total}</span>}
        <Link to={to} className="text-small">
          View all
        </Link>
      </div>
      {loading ? (
        <Loading />
      ) : items?.length ? (
        items.map((n) => {
          const isPr = n.__typename === 'PullRequest'
          const rollup = n.commits?.nodes[0]?.commit.statusCheckRollup?.state
          return (
            <div key={`${n.repository.nameWithOwner}#${n.number}`} className="Box-row hoverable">
              <span style={{ paddingTop: 2 }}>
                {isPr ? <PullStateIcon pull={{ state: 'open', draft: n.isDraft }} /> : <IssueStateIcon issue={{ state: 'open' }} />}
              </span>
              <div className="flex-1">
                <Link to={`/${n.repository.nameWithOwner}/${isPr ? 'pull' : 'issues'}/${n.number}`} className="text-bold fg-default text-break">
                  {n.title}
                </Link>
                <div className="text-small fg-muted">
                  {n.repository.nameWithOwner}#{n.number} · <RelativeTime date={new Date(n.updatedAt)} />
                  {isPr && n.reviewDecision === 'CHANGES_REQUESTED' && <span className="fg-danger"> · Changes requested</span>}
                  {isPr && n.reviewDecision === 'APPROVED' && <span className="fg-success"> · Approved</span>}
                </div>
              </div>
              {rollup && <CommitStatusMark state={rollup === 'SUCCESS' ? 'success' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : 'failure'} />}
            </div>
          )
        })
      ) : (
        <div className="Box-row fg-muted text-small">{empty}</div>
      )}
    </div>
  )
}

type FeedEvent = { id: string; type: string | null; actor: { login: string; avatar_url: string }; repo: { name: string }; payload: Record<string, unknown>; created_at: string | null }

function EventLine({ e }: { e: FeedEvent }) {
  const p = e.payload as {
    action?: string
    ref?: string
    ref_type?: string
    size?: number
    pull_request?: { number: number; title: string }
    issue?: { number: number; title: string; pull_request?: unknown }
    release?: { tag_name: string; name?: string }
    forkee?: { full_name: string }
  }
  let icon = <RepoIcon />
  let text: React.ReactNode = e.type
  const repoLink = <Link to={`/${e.repo.name}`} className="text-bold fg-default">{e.repo.name}</Link>
  switch (e.type) {
    case 'WatchEvent':
      icon = <StarIcon />
      text = <>starred {repoLink}</>
      break
    case 'ForkEvent':
      icon = <RepoForkedIcon />
      text = <>forked {repoLink}{p.forkee && <> to <Link to={`/${p.forkee.full_name}`}>{p.forkee.full_name}</Link></>}</>
      break
    case 'PushEvent':
      icon = <RepoPushIcon />
      text = <>pushed {p.size ? `${p.size} commit${p.size === 1 ? '' : 's'} ` : ''}to <span className="branch-pill">{p.ref?.replace('refs/heads/', '')}</span> in {repoLink}</>
      break
    case 'CreateEvent':
      icon = p.ref_type === 'tag' ? <TagIcon /> : <GitBranchIcon />
      text = <>created {p.ref_type} {p.ref && <span className="branch-pill">{p.ref}</span>} in {repoLink}</>
      break
    case 'PullRequestEvent':
      icon = <GitPullRequestIcon />
      text = p.pull_request && <>{p.action} pull request <Link to={`/${e.repo.name}/pull/${p.pull_request.number}`}>{p.pull_request.title} #{p.pull_request.number}</Link> in {repoLink}</>
      break
    case 'PullRequestReviewEvent':
      icon = <EyeIcon />
      text = p.pull_request && <>reviewed <Link to={`/${e.repo.name}/pull/${p.pull_request.number}`}>{p.pull_request.title} #{p.pull_request.number}</Link> in {repoLink}</>
      break
    case 'IssuesEvent':
      icon = <IssueOpenedIcon />
      text = p.issue && <>{p.action} issue <Link to={`/${e.repo.name}/issues/${p.issue.number}`}>{p.issue.title} #{p.issue.number}</Link> in {repoLink}</>
      break
    case 'IssueCommentEvent':
      icon = <CommentIcon />
      text = p.issue && <>commented on <Link to={`/${e.repo.name}/${p.issue.pull_request ? 'pull' : 'issues'}/${p.issue.number}`}>{p.issue.title} #{p.issue.number}</Link> in {repoLink}</>
      break
    case 'ReleaseEvent':
      icon = <TagIcon />
      text = <>released {p.release?.name || p.release?.tag_name} in {repoLink}</>
      break
    case 'PublicEvent':
      text = <>made {repoLink} public</>
      break
    default:
      text = <>{e.type?.replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} in {repoLink}</>
  }
  return (
    <div className="Box-row" style={{ alignItems: 'center' }}>
      <Avatar src={e.actor.avatar_url} size={32} />
      <span className="fg-muted">{icon}</span>
      <div className="flex-1">
        <Link to={`/${e.actor.login}`} className="text-bold fg-default">
          {e.actor.login}
        </Link>{' '}
        {text}
      </div>
      {e.created_at && (
        <span className="text-small fg-muted no-wrap">
          <RelativeTime date={new Date(e.created_at)} />
        </span>
      )}
    </div>
  )
}
