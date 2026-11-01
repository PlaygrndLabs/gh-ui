import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Avatar, AvatarStack, Button, ButtonGroup, CounterLabel, Label, RelativeTime, TextInput } from '@primer/react'
import { SearchIcon, CommentIcon, ChevronLeftIcon, ChevronRightIcon, IssueOpenedIcon, GitPullRequestIcon, CheckIcon, IssueClosedIcon, TriangleDownIcon, TagIcon, MilestoneIcon } from '@primer/octicons-react'
import { useGitHub } from '../lib/github'
import { Blankslate, ErrorBox, IssueLabel, Loading } from './Bits'
import { CommitStatusMark, IssueStateIcon, PullStateIcon } from './Status'

interface SearchNode {
  __typename: 'PullRequest' | 'Issue'
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  stateReason?: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null
  isDraft?: boolean
  createdAt: string
  closedAt: string | null
  author: { login: string; avatarUrl: string } | null
  authorAssociation: string
  repository: { nameWithOwner: string }
  labels: { nodes: Array<{ name: string; color: string; description: string | null }> }
  comments: { totalCount: number }
  assignees: { nodes: Array<{ login: string; avatarUrl: string }> }
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' } | null } }> }
  headRefName?: string
}

const FIELDS = `
  __typename
  ... on Issue { number title url state stateReason createdAt closedAt author{login avatarUrl} authorAssociation repository{nameWithOwner}
    labels(first:8){nodes{name color description}} comments{totalCount} assignees(first:4){nodes{login avatarUrl}} }
  ... on PullRequest { number title url state isDraft createdAt closedAt headRefName author{login avatarUrl} authorAssociation repository{nameWithOwner}
    labels(first:8){nodes{name color description}} comments{totalCount} assignees(first:4){nodes{login avatarUrl}}
    reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} }
`

const SORTS: Array<[string, string]> = [
  ['created-desc', 'Newest'],
  ['created-asc', 'Oldest'],
  ['comments-desc', 'Most commented'],
  ['updated-desc', 'Recently updated'],
]

interface IssueListProps {
  kind: 'pr' | 'issue'
  /** Fixed qualifiers, e.g. "repo:acme/web" or "review-requested:@me". Not shown in the input. */
  scope: string
  defaultQuery?: string
  showRepo?: boolean
  actions?: ReactNode
  labels?: Array<{ name: string; color: string }>
  milestones?: Array<{ title: string }>
  /** Page heading and its Labels/Milestones buttons, as on a repository's list pages. */
  title?: string
  onOpenLabels?(): void
  onOpenMilestones?(): void
  /** Filters shown as a tab-like menu (global pages). */
  presets?: Array<{ label: string; scope: string }>
}

export function IssueList({ kind, scope, defaultQuery, showRepo, actions, labels, milestones, title, onOpenLabels, onOpenMilestones, presets }: IssueListProps) {
  const { octokit, key } = useGitHub()
  const [params, setParams] = useSearchParams()
  // GitHub's own lists show the type and state qualifiers in the box: is:pr state:open.
  const q = params.get('q') ?? defaultQuery ?? `is:${kind === 'pr' ? 'pr' : 'issue'} state:open`
  const [draft, setDraft] = useState(q)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const presetIdx = Number(params.get('f') ?? 0)
  const effectiveScope = presets ? presets[presetIdx]?.scope ?? presets[0].scope : scope
  useEffect(() => setDraft(q), [q])
  useEffect(() => setCursors([null]), [q, effectiveScope])

  const typeQ = kind === 'pr' ? 'is:pr' : 'is:issue'
  const withoutState = q.replace(/\b(is|state):(open|closed|merged)\b/g, '').replace(/\s+/g, ' ').trim()
  const sortMatch = q.match(/\bsort:([\w-]+)/)
  const sort = sortMatch?.[1] ?? 'created-desc'
  const full = `${typeQ} ${effectiveScope} ${q.includes('sort:') ? q : `${q} sort:${sort}`}`.trim()
  const cursor = cursors[cursors.length - 1]

  const result = useQuery({
    queryKey: [key, 'search-list', full, cursor],
    queryFn: async () => {
      const base = `${typeQ} ${effectiveScope} ${withoutState.replace(/\bsort:[\w-]+/, '')}`.trim()
      const res: {
        search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: SearchNode[] }
        open: { issueCount: number }
        closed: { issueCount: number }
      } = await octokit.graphql(
        `query($q:String!,$after:String,$open:String!,$closed:String!){
          search(query:$q, type:ISSUE, first:25, after:$after){ issueCount pageInfo{hasNextPage endCursor} nodes{ ${FIELDS} } }
          open: search(query:$open, type:ISSUE, first:0){ issueCount }
          closed: search(query:$closed, type:ISSUE, first:0){ issueCount }
        }`,
        { q: full, after: cursor, open: `${base} is:open`, closed: `${base} is:closed` },
      )
      return res
    },
    placeholderData: (prev) => prev,
  })

  const setQuery = (next: string) => {
    setParams((p) => {
      p.set('q', next.trim())
      return p
    })
  }
  const setState = (state: 'open' | 'closed') => setQuery(`${withoutState} state:${state}`)
  const isOpen = /\b(is|state):open\b/.test(q)
  const isClosed = /\b(is|state):(closed|merged)\b/.test(q)
  const toggleQualifier = (qual: string) => setQuery(q.includes(qual) ? q.replace(qual, '') : `${q} ${qual}`)

  const nodes = result.data?.search.nodes ?? []
  return (
    <div>
      {title && (
        <div className="flex-center gap-2 mb-3 wrap">
          <h2 className="flex-1" style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
            {title}
          </h2>
          {labels && (
            <Button leadingVisual={TagIcon} onClick={onOpenLabels}>
              Labels <CounterLabel>{labels.length}</CounterLabel>
            </Button>
          )}
          {milestones && (
            <Button leadingVisual={MilestoneIcon} onClick={onOpenMilestones}>
              Milestones <CounterLabel>{milestones.length}</CounterLabel>
            </Button>
          )}
          {actions}
        </div>
      )}
      <div className="flex-center gap-2 mb-3 wrap">
        {presets && (
          <ButtonGroup>
            {presets.map((pr, i) => (
              <Button
                key={pr.label}
                variant={i === presetIdx ? 'primary' : 'default'}
                onClick={() =>
                  setParams((p) => {
                    p.set('f', String(i))
                    return p
                  })
                }
              >
                {pr.label}
              </Button>
            ))}
          </ButtonGroup>
        )}
        <form
          className="flex-1"
          style={{ minWidth: 240 }}
          onSubmit={(e) => {
            e.preventDefault()
            setQuery(draft)
          }}
        >
          <TextInput block leadingVisual={SearchIcon} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Search ${kind === 'pr' ? 'pull requests' : 'issues'}`} />
        </form>
        {!title && actions}
      </div>
      <div className="Box">
        <div className="Box-header" style={{ flexWrap: 'wrap' }}>
          <div className="state-tabs">
            <button type="button" className="state-tab" aria-pressed={isOpen} onClick={() => setState('open')}>
              {kind === 'pr' ? <GitPullRequestIcon /> : <IssueOpenedIcon />} Open <CounterLabel>{result.data?.open.issueCount.toLocaleString() ?? '–'}</CounterLabel>
            </button>
            <button type="button" className="state-tab" aria-pressed={isClosed} onClick={() => setState('closed')}>
              {kind === 'pr' ? <CheckIcon /> : <IssueClosedIcon />} Closed <CounterLabel>{result.data?.closed.issueCount.toLocaleString() ?? '–'}</CounterLabel>
            </button>
          </div>
          <span className="ml-auto flex-center gap-1 wrap">
            <FilterMenu label="Author" options={[['author:@me', 'Created by you'], ['-author:app/dependabot', 'Exclude Dependabot']]} q={q} onToggle={toggleQualifier} />
            {labels && labels.length > 0 && <FilterMenu label="Label" options={labels.slice(0, 60).map((l) => [`label:"${l.name}"`, l.name])} q={q} onToggle={toggleQualifier} />}
            {milestones && milestones.length > 0 && (
              <FilterMenu label="Milestones" options={[['no:milestone', 'No milestone'], ...milestones.slice(0, 60).map((m): [string, string] => [`milestone:"${m.title}"`, m.title])]} q={q} onToggle={toggleQualifier} />
            )}
            {kind === 'pr' && (
              <FilterMenu
                label="Reviews"
                options={[
                  ['review:none', 'No reviews'],
                  ['review:required', 'Review required'],
                  ['review:approved', 'Approved review'],
                  ['review:changes_requested', 'Changes requested'],
                  ['review-requested:@me', 'Awaiting review from you'],
                  ['reviewed-by:@me', 'Reviewed by you'],
                ]}
                q={q}
                onToggle={toggleQualifier}
              />
            )}
            <FilterMenu label="Assignee" options={[['assignee:@me', 'Assigned to you'], ['no:assignee', 'Assigned to nobody']]} q={q} onToggle={toggleQualifier} />
            <ActionMenu>
              <ActionMenu.Button variant="invisible" size="small">
                {SORTS.find(([v]) => v === sort)?.[1] ?? 'Sort'}
              </ActionMenu.Button>
              <ActionMenu.Overlay>
                <ActionList selectionVariant="single">
                  {SORTS.map(([v, label]) => (
                    <ActionList.Item key={v} selected={sort === v} onSelect={() => setQuery(`${q.replace(/\bsort:[\w-]+/, '').trim()} sort:${v}`)}>
                      {label}
                    </ActionList.Item>
                  ))}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          </span>
        </div>
        {result.isLoading ? (
          <Loading />
        ) : result.error ? (
          <div className="p-3">
            <ErrorBox error={result.error} />
          </div>
        ) : nodes.length === 0 ? (
          <Blankslate icon={kind === 'pr' ? <GitPullRequestIcon size={24} /> : <IssueOpenedIcon size={24} />} title={`No results matched your search.`} />
        ) : (
          nodes.map((n) => <Row key={`${n.repository.nameWithOwner}#${n.number}`} n={n} showRepo={showRepo} />)
        )}
      </div>
      {(cursors.length > 1 || result.data?.search.pageInfo.hasNextPage) && (
        <div className="flex-center mt-3" style={{ justifyContent: 'center' }}>
          <ButtonGroup>
            <Button leadingVisual={ChevronLeftIcon} disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Previous
            </Button>
            <Button trailingVisual={ChevronRightIcon} disabled={!result.data?.search.pageInfo.hasNextPage} onClick={() => setCursors((c) => [...c, result.data!.search.pageInfo.endCursor])}>
              Next
            </Button>
          </ButtonGroup>
        </div>
      )}
    </div>
  )
}

function FilterMenu({ label, options, q, onToggle }: { label: string; options: Array<[string, string]>; q: string; onToggle(qual: string): void }) {
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <Button variant="invisible" size="small" trailingVisual={TriangleDownIcon}>
          {label}
        </Button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium">
        <ActionList selectionVariant="multiple">
          {options.map(([qual, text]) => (
            <ActionList.Item key={qual} selected={q.includes(qual)} onSelect={() => onToggle(qual)}>
              {text}
            </ActionList.Item>
          ))}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

const ASSOCIATION: Record<string, string> = {
  OWNER: 'Owner',
  MEMBER: 'Member',
  COLLABORATOR: 'Collaborator',
  CONTRIBUTOR: 'Contributor',
  FIRST_TIME_CONTRIBUTOR: 'First-time contributor',
  FIRST_TIMER: 'First-timer',
}

function Row({ n, showRepo }: { n: SearchNode; showRepo?: boolean }) {
  const isPr = n.__typename === 'PullRequest'
  const path = `/${n.repository.nameWithOwner}/${isPr ? 'pull' : 'issues'}/${n.number}`
  const rollup = n.commits?.nodes[0]?.commit.statusCheckRollup?.state
  return (
    <div className="Box-row hoverable">
      <span style={{ paddingTop: 2 }}>
        {isPr ? (
          <PullStateIcon pull={{ state: n.state === 'OPEN' ? 'open' : 'closed', merged: n.state === 'MERGED', draft: n.isDraft }} />
        ) : (
          <IssueStateIcon issue={{ state: n.state === 'OPEN' ? 'open' : 'closed', state_reason: n.stateReason === 'NOT_PLANNED' ? 'not_planned' : 'completed' }} />
        )}
      </span>
      <div className="flex-1">
        <div className="flex-center gap-1 wrap">
          {showRepo && (
            <Link to={`/${n.repository.nameWithOwner}`} className="link-muted" style={{ fontSize: 16 }}>
              {n.repository.nameWithOwner}
            </Link>
          )}
          <Link to={path} className="list-row-title">
            {n.title}
          </Link>
          {isPr && rollup && (
            <span style={{ display: 'inline-flex' }} title={`Checks: ${rollup.toLowerCase()}`}>
              <CommitStatusMark state={rollup === 'SUCCESS' ? 'success' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : 'failure'} />
            </span>
          )}
          {n.labels.nodes.map((l) => (
            <IssueLabel key={l.name} name={l.name} color={l.color} description={l.description} />
          ))}
        </div>
        <div className="Box-row-meta">
          #{n.number} · <Link to={`/${n.author?.login}`}>{n.author?.login ?? 'ghost'}</Link> {n.state === 'OPEN' ? 'opened' : n.state === 'MERGED' ? 'merged' : 'closed'}{' '}
          <RelativeTime date={new Date(n.state === 'OPEN' ? n.createdAt : n.closedAt ?? n.createdAt)} />
          {ASSOCIATION[n.authorAssociation] && (
            <>
              {' '}
              <Label size="small">{ASSOCIATION[n.authorAssociation]}</Label>
            </>
          )}
          {isPr && n.isDraft && ' • Draft'}
          {isPr && n.state === 'OPEN' && n.reviewDecision && (
            <>
              {' • '}
              <span className={n.reviewDecision === 'APPROVED' ? 'fg-success' : n.reviewDecision === 'CHANGES_REQUESTED' ? 'fg-danger' : ''}>
                {n.reviewDecision === 'APPROVED' ? 'Approved' : n.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review required'}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="list-row-right">
        {n.assignees.nodes.length > 0 && (
          <AvatarStack size={20}>
            {n.assignees.nodes.map((a) => (
              <Avatar key={a.login} src={a.avatarUrl} alt={a.login} />
            ))}
          </AvatarStack>
        )}
        {n.comments.totalCount > 0 && (
          <Link to={path}>
            <CommentIcon /> {n.comments.totalCount}
          </Link>
        )}
      </div>
    </div>
  )
}
