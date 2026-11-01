import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Avatar, Button, IconButton, Label, NavList, RelativeTime, SegmentedControl } from '@primer/react'
import { InboxIcon, GitPullRequestIcon, IssueOpenedIcon, TagIcon, CheckIcon, GitCommitIcon, CommentDiscussionIcon, BellSlashIcon, ReadIcon, PlayIcon, AlertIcon, SparkleFillIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage, type Notification } from '../lib/github'
import { useAgent, useAgentPageContext } from '../lib/agent/AgentProvider'
import { appPathFromApiUrl, webUrl } from '../lib/links'
import { canReadNotifications } from '../lib/hosts'
import { openExternal } from '../lib/platform'
import { Blankslate, ErrorBox, Loading } from '../components/Bits'

const REASON: Record<string, string> = {
  review_requested: 'Review requested',
  mention: 'Mention',
  team_mention: 'Team mention',
  author: 'Author',
  comment: 'Comment',
  assign: 'Assigned',
  state_change: 'State change',
  subscribed: 'Subscribed',
  ci_activity: 'CI activity',
  manual: 'Subscribed',
  security_alert: 'Security alert',
  invitation: 'Invitation',
  approval_requested: 'Approval requested',
}

function SubjectIcon({ type }: { type: string }) {
  switch (type) {
    case 'PullRequest':
      return <GitPullRequestIcon className="fg-success" />
    case 'Issue':
      return <IssueOpenedIcon className="fg-success" />
    case 'Release':
      return <TagIcon />
    case 'Commit':
      return <GitCommitIcon />
    case 'Discussion':
      return <CommentDiscussionIcon />
    case 'CheckSuite':
      return <PlayIcon />
    case 'RepositoryVulnerabilityAlert':
      return <AlertIcon className="fg-danger" />
    default:
      return <InboxIcon />
  }
}

export function NotificationsPage() {
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const agent = useAgent()
  const [filter, setFilter] = useState<'all' | 'unread' | 'participating'>('all')
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  // GitHub does not let fine-grained PATs or GitHub App tokens read notifications; every call returns 403.
  const unsupported = !canReadNotifications(account.kind)

  useAgentPageContext({
    label: 'their notifications inbox',
    suggestions: unsupported
      ? []
      : [{ label: 'Triage my inbox', prompt: 'Look at my unread GitHub notifications that are review requests or mentions, and tell me which need action first and why.' }],
  })

  const list = useQuery({
    queryKey: [key, 'notifications', filter],
    enabled: !unsupported,
    queryFn: async () =>
      octokit.paginate(octokit.rest.activity.listNotificationsForAuthenticatedUser, { all: filter === 'all', participating: filter === 'participating', per_page: 50 }, (r, done) => {
        if (r.data.length < 50) done()
        return r.data
      }),
    refetchInterval: 60_000,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [key, 'notifications'] })
    void qc.invalidateQueries({ queryKey: [key, 'notifications-unread'] })
  }
  const act = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: refresh })

  const repos = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of list.data ?? []) m.set(n.repository.full_name, (m.get(n.repository.full_name) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [list.data])

  if (unsupported) {
    return (
      <div className="container-xl">
        <div className="Box">
          <Blankslate
            icon={<InboxIcon size={32} />}
            title="Notifications are not available with this token"
            action={<Button onClick={() => navigate('/login?add=1')}>Add account</Button>}
          >
            GitHub does not support fine-grained personal access tokens or GitHub App tokens for notifications. To see your inbox, add an account that signs in with a classic personal access token, the GitHub CLI session or the device flow with an OAuth App.
          </Blankslate>
        </div>
      </div>
    )
  }

  const shown = (list.data ?? []).filter((n) => (!repoFilter || n.repository.full_name === repoFilter) && (!reason || n.reason === reason))
  const groups = new Map<string, Notification[]>()
  for (const n of shown) groups.set(n.repository.full_name, [...(groups.get(n.repository.full_name) ?? []), n])

  const open = (n: Notification) => {
    if (n.unread) act.mutate(() => octokit.rest.activity.markThreadAsRead({ thread_id: Number(n.id) }))
    const path = appPathFromApiUrl(n.subject.url)
    if (path) navigate(path)
    else openExternal(webUrl(account.host, `/${n.repository.full_name}`))
  }

  return (
    <div className="container-xl">
      <div className="layout-sidebar-left" style={{ gridTemplateColumns: '256px minmax(0,1fr)' }}>
        <div>
          <NavList aria-label="Notification filters">
            <NavList.Item aria-current={!reason && !repoFilter ? 'page' : undefined} onClick={() => (setReason(null), setRepoFilter(null))}>
              <NavList.LeadingVisual>
                <InboxIcon />
              </NavList.LeadingVisual>
              Inbox
            </NavList.Item>
            <NavList.Group title="Reasons">
              {['review_requested', 'mention', 'assign', 'author', 'ci_activity'].map((r) => (
                <NavList.Item key={r} aria-current={reason === r ? 'page' : undefined} onClick={() => setReason(reason === r ? null : r)}>
                  {REASON[r]}
                </NavList.Item>
              ))}
            </NavList.Group>
            {repos.length > 0 && (
              <NavList.Group title="Repositories">
                {repos.slice(0, 15).map(([name, count]) => (
                  <NavList.Item key={name} aria-current={repoFilter === name ? 'page' : undefined} onClick={() => setRepoFilter(repoFilter === name ? null : name)}>
                    {name}
                    <NavList.TrailingVisual>{count}</NavList.TrailingVisual>
                  </NavList.Item>
                ))}
              </NavList.Group>
            )}
          </NavList>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="flex-center gap-2 mb-3 wrap">
            <SegmentedControl aria-label="Filter" onChange={(i) => setFilter((['all', 'unread', 'participating'] as const)[i])}>
              <SegmentedControl.Button selected={filter === 'all'}>All</SegmentedControl.Button>
              <SegmentedControl.Button selected={filter === 'unread'}>Unread</SegmentedControl.Button>
              <SegmentedControl.Button selected={filter === 'participating'}>Participating</SegmentedControl.Button>
            </SegmentedControl>
            <span className="ml-auto flex-center gap-2">
              <Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask('Look at my unread GitHub notifications that are review requests or mentions, and tell me which need action first and why.')}>
                Triage with agent
              </Button>
              <Button leadingVisual={ReadIcon} loading={act.isPending} onClick={() => act.mutate(() => octokit.rest.activity.markNotificationsAsRead({ last_read_at: new Date().toISOString() }))}>
                Mark all as read
              </Button>
            </span>
          </div>
          {act.error && <div className="error-box mb-3">{errorMessage(act.error)}</div>}
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} title="Could not load notifications" />
          ) : shown.length === 0 ? (
            <div className="Box">
              <Blankslate icon={<InboxIcon size={32} />} title="All caught up!">
                Take a break, write some code, do what you do best.
              </Blankslate>
            </div>
          ) : (
            [...groups.entries()].map(([repoName, items]) => (
              <div key={repoName} className="Box mb-3">
                <div className="Box-header compact">
                  <Avatar src={items[0].repository.owner.avatar_url} size={16} square={items[0].repository.owner.type === 'Organization'} />
                  <span className="text-bold">{repoName}</span>
                </div>
                {items.map((n) => (
                  <div key={n.id} className="Box-row hoverable" style={{ alignItems: 'center', cursor: 'pointer' }} onClick={() => open(n)}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: n.unread ? 'var(--bgColor-accent-emphasis)' : 'transparent', flexShrink: 0 }} aria-label={n.unread ? 'Unread' : undefined} />
                    <SubjectIcon type={n.subject.type} />
                    <div className="flex-1">
                      <div className={n.unread ? 'text-bold' : ''}>{n.subject.title}</div>
                      <div className="text-small fg-muted flex-center gap-1">
                        <Label size="small">{REASON[n.reason] ?? n.reason}</Label>
                        <RelativeTime date={new Date(n.updated_at)} />
                      </div>
                    </div>
                    <span className="flex-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {n.unread && (
                        <IconButton description="Mark as read" size="small" variant="invisible" icon={ReadIcon} aria-label="Mark as read" onClick={() => act.mutate(() => octokit.rest.activity.markThreadAsRead({ thread_id: Number(n.id) }))} />
                      )}
                      <IconButton description="Done" size="small" variant="invisible" icon={CheckIcon} aria-label="Mark as done" onClick={() => act.mutate(() => octokit.rest.activity.markThreadAsDone({ thread_id: Number(n.id) }))} />
                      <IconButton description="Unsubscribe" size="small" variant="invisible" icon={BellSlashIcon} aria-label="Unsubscribe" onClick={() => act.mutate(() => octokit.rest.activity.deleteThreadSubscription({ thread_id: Number(n.id) }))} />
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
