import { useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, IconButton, SelectPanel } from '@primer/react'
import { GearIcon, CheckIcon, FileDiffIcon, DotFillIcon, CommentIcon, BellIcon, BellSlashIcon, GitBranchIcon, TableIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage, type PullRequest } from '../lib/github'
import { useRepo, encodePath } from '../lib/repo'
import { openExternal } from '../lib/platform'
import { IssueLabel, UserAvatar, isBot, botName } from './Bits'
import { IssueStateIcon, PullStateIcon } from './Status'

/** An issue or pull request another issue points at (Relationships, Development). */
export interface IssueRef {
  number: number
  title: string
  url: string
  state: string
  stateReason?: string | null
  isDraft?: boolean
  merged?: boolean
  repository: { nameWithOwner: string }
}

/** What the REST issue lacks and github.com's issue page shows: from GraphQL, shared by the header, timeline and sidebar. */
export interface IssueExtra {
  id: string
  /** When the description was last edited (null if never): REST updated_at moves on any activity. */
  lastEditedAt: string | null
  viewerSubscription: 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'IGNORED' | null
  viewerCanSubscribe: boolean
  participants: { totalCount: number; nodes: Array<{ login: string; avatarUrl: string }> }
  closedByPullRequestsReferences: { nodes: IssueRef[] } | null
  linkedBranches: { nodes: Array<{ ref: { name: string; repository: { nameWithOwner: string } } | null }> } | null
  timelineItems: {
    nodes: Array<{
      __typename: string
      url?: string
      closer?: { __typename: string; number?: number; oid?: string; repository?: { nameWithOwner: string } } | null
      commit?: { oid: string; messageHeadline: string } | null
      willCloseTarget?: boolean
      source?: { url?: string } | null
    }>
  }
}

/** Issue types and relationships; a separate query so a server without them still gets the rest. */
export interface IssueRelations {
  issueType: { name: string; color: string; description: string | null } | null
  parent: IssueRef | null
  blockedBy: { totalCount: number; nodes: IssueRef[] } | null
  blocking: { totalCount: number; nodes: IssueRef[] } | null
}

const REF_FIELDS = 'number title url state stateReason repository{ nameWithOwner }'

export function useIssueExtra(owner: string, repo: string, number: number, enabled = true) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'issue-extra', owner, repo, number],
    enabled,
    retry: false,
    queryFn: async () => {
      const res: { repository: { issue: IssueExtra } } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){
          id lastEditedAt viewerSubscription viewerCanSubscribe
          participants(first:100){ totalCount nodes{ login avatarUrl } }
          closedByPullRequestsReferences(first:10, includeClosedPrs:true){ nodes{ number title url state isDraft merged repository{ nameWithOwner } } }
          linkedBranches(first:10){ nodes{ ref{ name repository{ nameWithOwner } } } }
          timelineItems(first:100, itemTypes:[CLOSED_EVENT, REFERENCED_EVENT, CROSS_REFERENCED_EVENT]){ nodes{ __typename
            ... on ClosedEvent{ url closer{ __typename ... on PullRequest{ number repository{ nameWithOwner } } ... on Commit{ oid repository{ nameWithOwner } } } }
            ... on ReferencedEvent{ commit{ oid messageHeadline } }
            ... on CrossReferencedEvent{ willCloseTarget source{ ... on PullRequest{ url } ... on Issue{ url } } } } }
        } } }`,
        { owner, repo, number },
      )
      return res.repository.issue
    },
  })
}

function useIssueRelations(owner: string, repo: string, number: number, enabled: boolean) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'issue-relations', owner, repo, number],
    enabled,
    retry: false,
    queryFn: async () => {
      const res: { repository: { issue: IssueRelations } } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){
          issueType{ name color description }
          parent{ ${REF_FIELDS} }
          blockedBy(first:10){ totalCount nodes{ ${REF_FIELDS} } }
          blocking(first:10){ totalCount nodes{ ${REF_FIELDS} } }
        } } }`,
        { owner, repo, number },
      )
      return res.repository.issue
    },
  })
}

interface ProjectItem {
  project: { title: string; url: string }
  status: { name: string } | null
}

/** Project items of an issue or pull request; a query of its own because it needs the read:project scope. */
function useIssueProjects(owner: string, repo: string, number: number, kind: 'issue' | 'pullRequest') {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'issue-projects', owner, repo, number, kind],
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const res: { repository: Record<string, { projectItems: { nodes: ProjectItem[] } }> } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ item: ${kind}(number:$number){
          projectItems(first:20){ nodes{ project{ title url } status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } }
        } } }`,
        { owner, repo, number },
      )
      return res.repository.item.projectItems.nodes.filter((n) => n?.project)
    },
  })
}

/** github.com's pull request sidebar: the issues merging it may close, and its participants. */
export function usePullExtra(owner: string, repo: string, number: number, enabled: boolean) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'pull-extra', owner, repo, number],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const res: {
        repository: { pullRequest: { lastEditedAt: string | null; participants: IssueExtra['participants']; closingIssuesReferences: { nodes: IssueRef[] } | null } }
      } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){
          lastEditedAt
          participants(first:100){ totalCount nodes{ login avatarUrl } }
          closingIssuesReferences(first:10){ nodes{ number title url state stateReason repository{ nameWithOwner } } }
        } } }`,
        { owner, repo, number },
      )
      return res.repository.pullRequest
    },
  })
}

/** One linked issue or pull request: state icon, title and its reference. */
function RefRow({ item, owner, repo, pull }: { item: IssueRef; owner: string; repo: string; pull?: boolean }) {
  const [o, r] = item.repository.nameWithOwner.split('/')
  const same = item.repository.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase()
  const state = item.state.toLowerCase()
  return (
    <div className="sidebar-ref">
      {pull ? (
        <PullStateIcon pull={{ state: state === 'merged' ? 'closed' : state, merged: item.merged, draft: item.isDraft }} />
      ) : (
        <IssueStateIcon issue={{ state, state_reason: item.stateReason?.toLowerCase() }} />
      )}
      <Link to={`/${o}/${r}/${pull ? 'pull' : 'issues'}/${item.number}`} className="fg-default flex-1">
        {item.title} <span className="fg-muted">{same ? `#${item.number}` : `${item.repository.nameWithOwner}#${item.number}`}</span>
      </Link>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-heading">{title}</div>
      {children}
    </div>
  )
}

type LabelLike = string | { name?: string; color?: string | null; description?: string | null }

interface IssueSidebarProps {
  number: number
  isPull?: boolean
  pull?: PullRequest
  labels: LabelLike[]
  assignees: Array<{ login: string; avatar_url: string }>
  milestone: { title: string; html_url?: string } | null
  onChanged(): void
}

const TYPE_COLORS = new Set(['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'])

interface PickItem {
  id: string
  text: string
  description?: string
  leadingVisual?: React.ElementType
}

function PickerSection({
  title,
  canEdit,
  items,
  loading,
  selectedIds,
  onApply,
  children,
}: {
  title: string
  canEdit: boolean
  items: PickItem[]
  loading?: boolean
  selectedIds: string[]
  onApply(next: string[]): Promise<void>
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [selection, setSelection] = useState<string[]>(selectedIds)
  const [error, setError] = useState<string | null>(null)
  const visible = items.filter((i) => i.text.toLowerCase().includes(filter.toLowerCase()))
  const selectedItems = visible.filter((i) => selection.includes(i.id))
  return (
    <div className="sidebar-section">
      <div className="sidebar-heading">
        <span>{title}</span>
        {canEdit && (
          <SelectPanel
            title={`Edit ${title.toLowerCase()}`}
            open={open}
            onOpenChange={async (o) => {
              if (o) {
                setSelection(selectedIds)
                setOpen(true)
                return
              }
              setOpen(false)
              const changed = selection.length !== selectedIds.length || selection.some((s) => !selectedIds.includes(s))
              if (changed) {
                try {
                  setError(null)
                  await onApply(selection)
                } catch (e) {
                  setError(errorMessage(e))
                }
              }
            }}
            renderAnchor={(props) => <IconButton {...props} size="small" variant="invisible" icon={GearIcon} aria-label={`Edit ${title.toLowerCase()}`} />}
            items={visible}
            selected={selectedItems}
            onSelectedChange={(sel: unknown) => {
              // Multi-select panel: always an array of the items passed in.
              const picked = (sel as PickItem[]) ?? []
              const visibleIds = new Set(visible.map((v) => v.id))
              setSelection((prev) => [...prev.filter((p) => !visibleIds.has(p)), ...picked.map((s) => s.id)])
            }}
            filterValue={filter}
            onFilterChange={setFilter}
            loading={loading}
            width="medium"
          />
        )}
      </div>
      {children}
      {error && <div className="fg-danger text-small mt-1">{error}</div>}
    </div>
  )
}

export function IssueSidebar({ number, isPull, pull, labels, assignees, milestone, onChanged }: IssueSidebarProps) {
  const subscriptionId = useId()
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const canEdit = !!data.permissions?.push || !!data.permissions?.triage
  // github.com's issue sidebar also has Type, Projects, Relationships, Development, Notifications and Participants.
  const extra = useIssueExtra(owner, repo, number, !isPull)
  const relations = useIssueRelations(owner, repo, number, !isPull)
  const projects = useIssueProjects(owner, repo, number, isPull ? 'pullRequest' : 'issue')
  const pullExtra = usePullExtra(owner, repo, number, !!isPull)
  const participants = isPull ? pullExtra.data?.participants : extra.data?.participants
  const subscribed = extra.data?.viewerSubscription === 'SUBSCRIBED'
  const subscribe = useMutation({
    mutationFn: async () =>
      octokit.graphql(`mutation($id:ID!,$state:SubscriptionState!){ updateSubscription(input:{subscribableId:$id, state:$state}){ clientMutationId } }`, {
        id: extra.data!.id,
        state: subscribed ? 'UNSUBSCRIBED' : 'SUBSCRIBED',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: [key, 'issue-extra', owner, repo, number] }),
  })
  const labelQuery = (name: string) => `/${owner}/${repo}/${isPull ? 'pulls' : 'issues'}?q=${encodeURIComponent(`${isPull ? 'is:pr ' : ''}state:open label:"${name}"`)}`

  const repoLabels = useQuery({
    queryKey: [key, 'labels', owner, repo],
    enabled: canEdit,
    staleTime: 5 * 60_000,
    queryFn: async () => octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 }),
  })
  const assignable = useQuery({
    queryKey: [key, 'assignees', owner, repo],
    enabled: canEdit,
    staleTime: 5 * 60_000,
    queryFn: async () => octokit.paginate(octokit.rest.issues.listAssignees, { owner, repo, per_page: 100 }),
  })
  const reviews = useQuery({
    queryKey: [key, 'reviews', owner, repo, number],
    enabled: !!isPull,
    queryFn: async () => octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
  })

  const labelNames = labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean)
  const reviewerStates = useMemo(() => {
    const m = new Map<string, { state: string; avatar: string }>()
    for (const r of reviews.data ?? []) {
      if (!r.user || r.user.login === pull?.user?.login) continue
      const prev = m.get(r.user.login)
      if (r.state === 'COMMENTED' && prev && prev.state !== 'COMMENTED') continue
      m.set(r.user.login, { state: r.state, avatar: r.user.avatar_url })
    }
    for (const u of pull?.requested_reviewers ?? []) m.set(u.login, { state: 'REQUESTED', avatar: u.avatar_url })
    return m
  }, [reviews.data, pull])

  const userItems: PickItem[] = (assignable.data ?? []).map((u) => ({ id: u.login, text: u.login }))

  return (
    <aside>
      {isPull && pull && (
        <PickerSection
          title="Reviewers"
          canEdit={canEdit}
          items={userItems.filter((u) => u.id !== pull.user?.login)}
          loading={assignable.isLoading}
          selectedIds={(pull.requested_reviewers ?? []).map((u) => u.login)}
          onApply={async (next) => {
            const current = (pull.requested_reviewers ?? []).map((u) => u.login)
            const add = next.filter((n) => !current.includes(n))
            const remove = current.filter((c) => !next.includes(c))
            if (add.length) await octokit.rest.pulls.requestReviewers({ owner, repo, pull_number: number, reviewers: add })
            if (remove.length) await octokit.rest.pulls.removeRequestedReviewers({ owner, repo, pull_number: number, reviewers: remove })
            onChanged()
          }}
        >
          {reviewerStates.size === 0 && !(pull.requested_teams ?? []).length ? (
            <span className="fg-muted">No reviews</span>
          ) : (
            <div className="flex" style={{ flexDirection: 'column', gap: 6 }}>
              {[...reviewerStates.entries()].map(([login, s]) => (
                <div key={login} className="flex-center gap-2">
                  <UserAvatar login={login} src={s.avatar} size={20} />
                  {isBot(login) ? (
                    <span className="fg-default text-bold flex-1 text-truncate">{botName(login)}</span>
                  ) : (
                    <Link to={`/${login}`} className="fg-default text-bold flex-1 text-truncate">
                      {login}
                    </Link>
                  )}
                  <ReviewMark state={s.state} />
                </div>
              ))}
              {(pull.requested_teams ?? []).map((t) => (
                <div key={t.slug} className="flex-center gap-2">
                  <span className="text-bold flex-1">{t.name}</span>
                  <DotFillIcon className="fg-attention" />
                </div>
              ))}
            </div>
          )}
        </PickerSection>
      )}
      <PickerSection
        title="Assignees"
        canEdit={canEdit}
        items={userItems}
        loading={assignable.isLoading}
        selectedIds={assignees.map((a) => a.login)}
        onApply={async (next) => {
          const current = assignees.map((a) => a.login)
          const add = next.filter((n) => !current.includes(n))
          const remove = current.filter((c) => !next.includes(c))
          if (add.length) await octokit.rest.issues.addAssignees({ owner, repo, issue_number: number, assignees: add })
          if (remove.length) await octokit.rest.issues.removeAssignees({ owner, repo, issue_number: number, assignees: remove })
          onChanged()
        }}
      >
        {assignees.length ? (
          <div className="flex" style={{ flexDirection: 'column', gap: 6 }}>
            {assignees.map((a) => (
              <div key={a.login} className="flex-center gap-2">
                <UserAvatar login={a.login} src={a.avatar_url} size={20} />
                <Link to={`/${a.login}`} className="fg-default text-bold">
                  {a.login}
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <span className="fg-muted">No one assigned</span>
        )}
      </PickerSection>
      <PickerSection
        title="Labels"
        canEdit={canEdit}
        items={(repoLabels.data ?? []).map((l) => ({ id: l.name, text: l.name, description: l.description ?? undefined }))}
        loading={repoLabels.isLoading}
        selectedIds={labelNames}
        onApply={async (next) => {
          await octokit.rest.issues.setLabels({ owner, repo, issue_number: number, labels: next })
          onChanged()
        }}
      >
        {labels.length ? (
          <div className="flex wrap gap-1">
            {labels.map((l) => {
              const name = typeof l === 'string' ? l : l.name ?? ''
              return (
                <Link key={name} to={labelQuery(name)} className="link-plain">
                  {typeof l === 'string' ? <IssueLabel name={l} /> : <IssueLabel name={name} color={l.color} description={l.description} />}
                </Link>
              )
            })}
          </div>
        ) : (
          <span className="fg-muted">{isPull ? 'None yet' : 'No labels'}</span>
        )}
      </PickerSection>
      {!isPull && !relations.isError && (
        <Section title="Type">
          {relations.data?.issueType ? (
            <span
              className="issue-type-token"
              title={relations.data.issueType.description ?? undefined}
              style={
                TYPE_COLORS.has(relations.data.issueType.color.toLowerCase())
                  ? {
                      color: `var(--display-${relations.data.issueType.color.toLowerCase()}-fgColor)`,
                      borderColor: `var(--display-${relations.data.issueType.color.toLowerCase()}-borderColor-emphasis)`,
                    }
                  : undefined
              }
            >
              {relations.data.issueType.name}
            </span>
          ) : (
            <span className="fg-muted">{relations.isLoading ? '…' : 'No type'}</span>
          )}
        </Section>
      )}
      <Section title="Projects">
        {projects.isError ? (
          <span className="fg-muted">{/scope|INSUFFICIENT/i.test(errorMessage(projects.error)) ? 'Projects need the read:project scope' : 'Projects are currently unavailable'}</span>
        ) : projects.data?.length ? (
          <div className="flex" style={{ flexDirection: 'column', gap: 6 }}>
            {projects.data.map((p) => (
              <div key={p.project.url}>
                <a
                  href={p.project.url}
                  className="fg-default text-bold flex-center gap-1"
                  onClick={(ev) => {
                    ev.preventDefault()
                    openExternal(p.project.url)
                  }}
                >
                  <TableIcon className="fg-muted" /> {p.project.title}
                </a>
                {p.status?.name && <div className="fg-muted mt-1">Status: {p.status.name}</div>}
              </div>
            ))}
          </div>
        ) : (
          <span className="fg-muted">{projects.isLoading ? '…' : 'No projects'}</span>
        )}
      </Section>
      <div className="sidebar-section">
        <div className="sidebar-heading">Milestone</div>
        {milestone ? (
          <Link to={`/${owner}/${repo}/${isPull ? 'pulls' : 'issues'}?q=${encodeURIComponent(`${isPull ? 'is:pr ' : ''}milestone:"${milestone.title}"`)}`} className="fg-default text-bold">
            {milestone.title}
          </Link>
        ) : (
          <span className="fg-muted">No milestone</span>
        )}
      </div>
      {!isPull && !relations.isError && (
        <Section title="Relationships">
          {relations.data?.parent || relations.data?.blockedBy?.nodes.length || relations.data?.blocking?.nodes.length ? (
            <div className="flex" style={{ flexDirection: 'column', gap: 8 }}>
              {(
                [
                  ['Parent issue', relations.data.parent ? [relations.data.parent] : []],
                  ['Blocked by', relations.data.blockedBy?.nodes ?? []],
                  ['Is blocking', relations.data.blocking?.nodes ?? []],
                ] as const
              )
                .filter(([, items]) => items.length > 0)
                .map(([label, items]) => (
                  <div key={label}>
                    <div className="fg-muted mb-1">{label}</div>
                    {items.map((it) => (
                      <RefRow key={it.url} item={it} owner={owner} repo={repo} />
                    ))}
                  </div>
                ))}
            </div>
          ) : (
            <span className="fg-muted">{relations.isLoading ? '…' : 'None yet'}</span>
          )}
        </Section>
      )}
      {isPull && !pullExtra.isError && (
        <Section title="Development">
          {pullExtra.data?.closingIssuesReferences?.nodes.length ? (
            <>
              <p className="fg-muted" style={{ margin: '0 0 4px' }}>
                Successfully merging this pull request may close these issues.
              </p>
              {pullExtra.data.closingIssuesReferences.nodes.map((it) => (
                <RefRow key={it.url} item={it} owner={owner} repo={repo} />
              ))}
            </>
          ) : (
            <span className="fg-muted">{pullExtra.isLoading ? '…' : 'None yet'}</span>
          )}
        </Section>
      )}
      {!isPull && !extra.isError && (
        <Section title="Development">
          {extra.data?.closedByPullRequestsReferences?.nodes.length || extra.data?.linkedBranches?.nodes.some((b) => b.ref) ? (
            <div className="flex" style={{ flexDirection: 'column', gap: 4 }}>
              {extra.data.linkedBranches?.nodes
                .filter((b) => b.ref)
                .map((b) => (
                  <div key={`${b.ref!.repository.nameWithOwner}:${b.ref!.name}`} className="sidebar-ref">
                    <GitBranchIcon className="fg-muted" />
                    <Link to={`/${b.ref!.repository.nameWithOwner}/tree/${encodePath(b.ref!.name)}`} className="fg-default flex-1 text-truncate text-mono">
                      {b.ref!.name}
                    </Link>
                  </div>
                ))}
              {extra.data.closedByPullRequestsReferences?.nodes.map((pr) => (
                <RefRow key={pr.url} item={pr} owner={owner} repo={repo} pull />
              ))}
            </div>
          ) : (
            <span className="fg-muted">{extra.isLoading ? '…' : 'No branches or pull requests'}</span>
          )}
        </Section>
      )}
      {!isPull && extra.data?.viewerCanSubscribe && (
        <Section title="Notifications">
          <Button size="small" block leadingVisual={subscribed ? BellSlashIcon : BellIcon} loading={subscribe.isPending} onClick={() => subscribe.mutate()} aria-describedby={subscriptionId}>
            {subscribed ? 'Unsubscribe' : 'Subscribe'}
          </Button>
          <p id={subscriptionId} className="fg-muted mt-2" style={{ marginBottom: 0 }}>
            {subscribed ? 'You’re receiving notifications because you’re subscribed to this thread.' : 'You’re not receiving notifications from this thread.'}
          </p>
          {subscribe.error && <div className="fg-danger mt-1">{errorMessage(subscribe.error)}</div>}
        </Section>
      )}
      {participants && (
        <Section title={isPull ? `${participants.totalCount} ${participants.totalCount === 1 ? 'participant' : 'participants'}` : 'Participants'}>
          {participants.nodes.length ? (
            <div className="flex-center wrap gap-1">
              {participants.nodes.slice(0, 5).map((u) => (
                <Link key={u.login} to={`/${u.login}`} aria-label={u.login} title={u.login}>
                  <UserAvatar login={u.login} src={u.avatarUrl} size={20} />
                </Link>
              ))}
              {participants.totalCount > 5 && <span className="fg-muted">+{participants.totalCount - 5}</span>}
            </div>
          ) : (
            <span className="fg-muted">No participants</span>
          )}
        </Section>
      )}
    </aside>
  )
}

function ReviewMark({ state }: { state: string }) {
  if (state === 'APPROVED') return <CheckIcon className="fg-success" aria-label="Approved" />
  if (state === 'CHANGES_REQUESTED') return <FileDiffIcon className="fg-danger" aria-label="Changes requested" />
  if (state === 'COMMENTED') return <CommentIcon className="fg-muted" aria-label="Commented" />
  return <DotFillIcon className="fg-attention" aria-label="Awaiting review" />
}
