import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, FormControl, IconButton, Label, Pagination, RelativeTime, TextInput, UnderlineNav, useConfirm } from '@primer/react'
import { Table } from '@primer/react/experimental'
import { GitBranchIcon, TrashIcon, SearchIcon, GitPullRequestIcon, ShieldLockIcon, ChevronRightIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo, encodePath } from '../../lib/repo'
import { useAuth } from '../../lib/auth'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { BranchPicker } from '../../components/BranchPicker'
import { Blankslate, CopyButton, ErrorBox, Loading, UserAvatar, isBot } from '../../components/Bits'
import { CommitStatusMark, PullStateIcon } from '../../components/Status'

/** What the branch list needs to sort and filter every branch. */
interface BranchRef {
  name: string
  target: {
    oid: string
    committedDate: string
    author: { name: string | null; user: { login: string; avatarUrl: string } | null } | null
  } | null
}
type PullNode = { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; title: string }
/** The costlier per-branch columns, fetched only for the rows on screen. */
interface BranchDetails {
  target: {
    statusCheckRollup: {
      state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED'
      contexts: { totalCount: number; checkRunCountsByState: Array<{ state: string; count: number }> | null; statusContextCountsByState: Array<{ state: string; count: number }> | null }
    } | null
  } | null
  openPulls: { nodes: PullNode[] }
  anyPulls: { nodes: PullNode[] }
  compare: { aheadBy: number; behindBy: number } | null
  branchProtectionRule: { pattern: string } | null
}
type BranchNode = BranchRef & { details?: BranchDetails }

type View = 'overview' | 'yours' | 'active' | 'stale' | 'all'
const VIEWS: Array<[View, string]> = [
  ['overview', 'Overview'],
  ['yours', 'Yours'],
  ['active', 'Active'],
  ['stale', 'Stale'],
  ['all', 'All'],
]
// github.com: branches without commits in the last three months are stale.
const STALE_MS = 90 * 24 * 60 * 60 * 1000
const OVERVIEW_LIMIT = 5
const PER_PAGE = 20
// Branches are listed 100 per request; past this many, the list covers the first ones by name only.
const MAX_BRANCHES = 1000

/** github.com sizes the behind/ahead bars on a log scale against the most diverged branch. */
function scaleDiverged(count: number, max: number) {
  const c = count <= 0 ? 0 : Math.log10(count)
  const m = max <= 0 ? 0 : Math.log10(max)
  return m > 0 ? Number(((100 * c) / m).toFixed(2)) : 0
}

/** "passing / total" like the github.com check status cell, which counts only successful checks as passing. */
function checkCounts(rollup: NonNullable<BranchDetails['target']>['statusCheckRollup']) {
  if (!rollup) return null
  const ok =
    (rollup.contexts.checkRunCountsByState ?? []).filter((c) => c.state === 'SUCCESS').reduce((n, c) => n + c.count, 0) +
    (rollup.contexts.statusContextCountsByState ?? []).filter((c) => c.state === 'SUCCESS').reduce((n, c) => n + c.count, 0)
  return `${ok} / ${rollup.contexts.totalCount}`
}

export function BranchesPage() {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const { active: account } = useAuth()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const routeParams = useParams()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  // github.com puts the view in the path (/branches/stale). A `branches/*` route passes it as the splat;
  // a plain `branches` route has no splat, so the view travels as ?view= instead.
  const splat = routeParams['*']
  const viewParam = (splat ?? params.get('view') ?? '').replace(/\/+$/, '')
  const view: View = VIEWS.some(([v]) => v === viewParam) ? (viewParam as View) : 'overview'
  const base = `/${owner}/${repo}/branches`
  const viewHref = (v: View) => (v === 'overview' ? base : splat !== undefined ? `${base}/${v}` : `${base}?view=${v}`)
  const page = Math.max(1, Number(params.get('page') || 1))

  useAgentPageContext({ label: `branches of ${owner}/${repo}`, owner, repo })

  // GitHub ignores TAG_COMMIT_DATE ordering for branches (it returns them by name), so list them all
  // (cheaply) and sort by last commit here; the expensive columns are fetched below for the visible rows only.
  const branches = useQuery({
    queryKey: [key, 'branches-gql', owner, repo],
    queryFn: async () => {
      const nodes: BranchRef[] = []
      let totalCount = 0
      let after: string | null = null
      do {
        const res: { repository: { refs: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: BranchRef[] } } } = await octokit.graphql(
          `query($owner:String!,$repo:String!,$after:String){
            repository(owner:$owner,name:$repo){
              refs(refPrefix:"refs/heads/", first:100, after:$after, orderBy:{field:ALPHABETICAL, direction:ASC}){
                totalCount
                pageInfo{ hasNextPage endCursor }
                nodes{ name target{ ... on Commit { oid committedDate author{ name user{ login avatarUrl } } } } }
              }
            }
          }`,
          { owner, repo, after },
        )
        const refs = res.repository.refs
        totalCount = refs.totalCount
        nodes.push(...refs.nodes)
        after = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null
      } while (after && nodes.length < MAX_BRANCHES)
      const time = (b: BranchRef) => (b.target ? new Date(b.target.committedDate).getTime() : 0)
      nodes.sort((a, b) => time(b) - time(a))
      return { totalCount, nodes }
    },
  })

  const remove = useMutation({
    mutationFn: async (name: string) => octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${name}` }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [key] }),
    onError: (e) => setError(errorMessage(e)),
  })

  const nodes = (branches.data?.nodes ?? []).filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
  const defRef = nodes.find((n) => n.name === data.default_branch)
  const restRefs = nodes.filter((n) => n.name !== data.default_branch)
  const now = Date.now()
  const isActive = (b: BranchRef) => !!b.target && now - new Date(b.target.committedDate).getTime() < STALE_MS
  const yoursRefs = account ? restRefs.filter((b) => b.target?.author?.user?.login?.toLowerCase() === account.login.toLowerCase()) : []
  const activeRefs = restRefs.filter(isActive)
  // Stale lists the oldest branches first, like github.com.
  const staleRefs = restRefs.filter((b) => !isActive(b)).reverse()
  const listedRefs = view === 'yours' ? yoursRefs : view === 'active' ? activeRefs : view === 'stale' ? staleRefs : [...(defRef ? [defRef] : []), ...restRefs]
  const pageCount = Math.max(1, Math.ceil(listedRefs.length / PER_PAGE))
  const current = Math.min(page, pageCount)
  const visible =
    view === 'overview'
      ? [...(defRef ? [defRef] : []), ...yoursRefs.slice(0, OVERVIEW_LIMIT), ...activeRefs.slice(0, OVERVIEW_LIMIT)]
      : listedRefs.slice((current - 1) * PER_PAGE, current * PER_PAGE)
  const visibleNames = [...new Set(visible.map((b) => b.name))]

  const details = useQuery({
    queryKey: [key, 'branches-details', owner, repo, data.default_branch, visibleNames],
    enabled: visibleNames.length > 0,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const vars: Record<string, string> = { owner, repo, default: data.default_branch }
      visibleNames.forEach((n, i) => (vars[`q${i}`] = `refs/heads/${n}`))
      const pulls = 'nodes{ number state isDraft title }'
      const res: { repository: Record<string, BranchDetails | null> } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$default:String!,${visibleNames.map((_, i) => `$q${i}:String!`).join(',')}){
          repository(owner:$owner,name:$repo){
            ${visibleNames
              .map(
                (_, i) => `b${i}: ref(qualifiedName:$q${i}){
              branchProtectionRule{ pattern }
              compare(headRef:$default){ aheadBy behindBy }
              openPulls: associatedPullRequests(first:1, states:[OPEN], orderBy:{field:CREATED_AT, direction:DESC}){ ${pulls} }
              anyPulls: associatedPullRequests(first:1, orderBy:{field:CREATED_AT, direction:DESC}){ ${pulls} }
              target{ ... on Commit { statusCheckRollup{ state contexts(first:1){ totalCount checkRunCountsByState{ state count } statusContextCountsByState{ state count } } } } }
            }`,
              )
              .join('\n')}
          }
        }`,
        vars,
      )
      const out: Record<string, BranchDetails> = {}
      visibleNames.forEach((n, i) => {
        const d = res.repository[`b${i}`]
        if (d) out[n] = d
      })
      return out
    },
  })
  const withDetails = useMemo(() => {
    const d = details.data ?? {}
    return (b: BranchRef): BranchNode => ({ ...b, details: d[b.name] })
  }, [details.data])
  const def = defRef && withDetails(defRef)
  const yours = yoursRefs.map(withDetails)
  const active = activeRefs.map(withDetails)
  const listed = listedRefs.map(withDetails)

  const row = (b: BranchNode, maxDiverged: number) => {
    const isDefault = b.name === data.default_branch
    const d = b.details
    // github.com shows no pull request for the default branch, and an open one before older ones.
    const pr = isDefault ? undefined : (d?.openPulls.nodes[0] ?? d?.anyPulls.nodes[0])
    // compare(headRef: default) on this branch: aheadBy = default ahead of branch.
    const behind = d?.compare?.aheadBy ?? 0
    const ahead = d?.compare?.behindBy ?? 0
    const author = b.target?.author?.user?.login ?? b.target?.author?.name
    return (
      <Table.Row key={b.name}>
        <Table.Cell>
          <div className="branch-name-cell">
            <Link to={isDefault ? `/${owner}/${repo}` : `/${owner}/${repo}/tree/${encodePath(b.name)}`} className="branch-pill" title={b.name}>
              {b.name}
            </Link>
            <CopyButton text={b.name} label="Copy branch name to clipboard" size="medium" />
            {d?.branchProtectionRule && (
              <span className="fg-muted flex-center" title={`Protected by ${d.branchProtectionRule.pattern}`}>
                <ShieldLockIcon />
              </span>
            )}
          </div>
        </Table.Cell>
        <Table.Cell>
          {b.target && (
            <span className="flex-center gap-2 fg-muted">
              {author &&
                (b.target.author?.user ? (
                  <Link to={`/${b.target.author.user.login}`} className="flex-center" title={b.target.author.user.login}>
                    <UserAvatar login={b.target.author.user.login} src={b.target.author.user.avatarUrl} size={16} />
                  </Link>
                ) : (
                  <span className="flex-center" title={author}>
                    <UserAvatar login={author} size={16} square={isBot(author)} />
                  </span>
                ))}
              <RelativeTime date={new Date(b.target.committedDate)} tense="past" />
            </span>
          )}
        </Table.Cell>
        <Table.Cell>
          {d?.target?.statusCheckRollup && (
            <span className="branch-checks" title={d.target.statusCheckRollup.state.toLowerCase()}>
              <CommitStatusMark state={d.target.statusCheckRollup.state === 'EXPECTED' ? 'pending' : (d.target.statusCheckRollup.state.toLowerCase() as 'success' | 'failure' | 'pending' | 'error')} />
              {checkCounts(d.target.statusCheckRollup)}
            </span>
          )}
        </Table.Cell>
        <Table.Cell>
          {isDefault ? (
            <span className="branch-diverged-default">
              <Label>Default</Label>
            </span>
          ) : d?.compare ? (
            <div className="branch-diverged" role="img" aria-label={`Ahead and behind counts: ${ahead} ahead, ${behind} behind`} title={`${behind.toLocaleString()} commits behind, ${ahead.toLocaleString()} commits ahead of ${data.default_branch}`}>
              {(
                [
                  ['behind', behind],
                  ['ahead', ahead],
                ] as const
              ).map(([side, count]) => (
                <div key={side} className={`branch-diverged-half ${side}`}>
                  <span className="branch-diverged-count">{count}</span>
                  <span className={count > 0 ? 'branch-diverged-bar active' : 'branch-diverged-bar'} style={{ width: `${scaleDiverged(count, maxDiverged)}%` }} />
                </div>
              ))}
            </div>
          ) : null}
        </Table.Cell>
        <Table.Cell>
          {pr ? (
            <Link to={`/${owner}/${repo}/pull/${pr.number}`} className="branch-pr-link" title={pr.title} aria-label={`${pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open'} pull request #${pr.number}`}>
              <Label size="small" className="branch-pr-label">
                <PullStateIcon size={14} pull={{ state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.state === 'MERGED', draft: pr.isDraft }} />
                <span>#{pr.number}</span>
              </Label>
            </Link>
          ) : !isDefault && ahead > 0 ? (
            <Button as={Link} size="small" to={`/${owner}/${repo}/compare/${encodePath(data.default_branch)}...${encodePath(b.name)}`} leadingVisual={GitPullRequestIcon}>
              New PR
            </Button>
          ) : null}
        </Table.Cell>
        <Table.Cell>
          <span className="branch-actions">
            {!isDefault && data.permissions?.push && (
              <IconButton
                description="Delete branch"
                size="small"
                variant="invisible"
                icon={TrashIcon}
                aria-label={`Delete ${b.name}`}
                disabled={!!d?.branchProtectionRule}
                onClick={async () => {
                  if (await confirm({ title: `Delete ${b.name}?`, content: 'The branch is deleted on GitHub. Open pull requests from it will be closed.', confirmButtonType: 'danger', confirmButtonContent: 'Delete' }))
                    remove.mutate(b.name)
                }}
              />
            )}
          </span>
        </Table.Cell>
      </Table.Row>
    )
  }

  const table = (id: string, title: string | null, list: BranchNode[], more?: View) => {
    const maxDiverged = Math.max(0, ...list.map((b) => Math.max(b.details?.compare?.aheadBy ?? 0, b.details?.compare?.behindBy ?? 0)))
    return (
      <Table.Container className={more ? 'branches-table with-footer' : 'branches-table'}>
        {title && <Table.Title id={id}>{title}</Table.Title>}
        <Table gridTemplateColumns="minmax(max-content, 1fr) 180px 125px 150px 125px 70px" cellPadding="normal" {...(title ? { 'aria-labelledby': id } : { 'aria-label': 'Branches' })}>
          <Table.Head>
            <Table.Row>
              <Table.Header>Branch</Table.Header>
              <Table.Header>Updated</Table.Header>
              <Table.Header>Check status</Table.Header>
              <Table.Header>
                <span className="branch-diverged-heading">
                  <span className="behind">Behind</span>
                  <span className="ahead">Ahead</span>
                </span>
              </Table.Header>
              <Table.Header>Pull request</Table.Header>
              <Table.Header>
                <span className="sr-only">Action menu</span>
              </Table.Header>
            </Table.Row>
          </Table.Head>
          <Table.Body>{list.map((b) => row(b, maxDiverged))}</Table.Body>
        </Table>
        {more && (
          <div className="branches-table-footer">
            <Link to={viewHref(more)} className="flex-center gap-1">
              View more branches <ChevronRightIcon />
            </Link>
          </div>
        )}
      </Table.Container>
    )
  }

  const empty = (
    <div className="Box">
      <Blankslate icon={<GitBranchIcon size={24} />} title="No branches">
        {filter ? 'No branches match the search' : null}
      </Blankslate>
    </div>
  )

  return (
    <div className="container-xl">
      <div className="branches-header">
        <h1 className="branches-heading">Branches</h1>
        {data.permissions?.push && (
          <Button variant="primary" onClick={() => setParams({ ...Object.fromEntries(params), new: '1' })}>
            New branch
          </Button>
        )}
      </div>
      <div className="branches-content">
        <UnderlineNav aria-label="Branches">
          {VIEWS.map(([v, label]) => (
            <UnderlineNav.Item key={v} as={Link} to={viewHref(v)} aria-current={view === v ? 'page' : undefined}>
              {label}
            </UnderlineNav.Item>
          ))}
        </UnderlineNav>
        <FormControl>
          <FormControl.Label visuallyHidden>Search</FormControl.Label>
          <TextInput block leadingVisual={SearchIcon} placeholder="Search branches..." value={filter} onChange={(e) => setFilter(e.target.value)} />
        </FormControl>
        {error && <div className="error-box">{error}</div>}
        {branches.error ? (
          <ErrorBox error={branches.error} />
        ) : branches.isLoading ? (
          <Loading />
        ) : view === 'overview' ? (
          <div>
            {!def && !yours.length && !active.length && empty}
            {def && <div className="branches-section">{table('default', 'Default', [def])}</div>}
            {yours.length > 0 && <div className="branches-section">{table('yours', 'Your branches', yours.slice(0, OVERVIEW_LIMIT), yours.length > OVERVIEW_LIMIT ? 'yours' : undefined)}</div>}
            {active.length > 0 && <div className="branches-section">{table('active', 'Active branches', active.slice(0, OVERVIEW_LIMIT), active.length > OVERVIEW_LIMIT ? 'active' : undefined)}</div>}
          </div>
        ) : listed.length === 0 ? (
          empty
        ) : (
          <div>
            {table(view, null, listed.slice((current - 1) * PER_PAGE, current * PER_PAGE))}
            {pageCount > 1 && (
              <Pagination
                pageCount={pageCount}
                currentPage={current}
                showPages={false}
                hrefBuilder={(n) => `${viewHref(view)}${viewHref(view).includes('?') ? '&' : '?'}page=${n}`}
                onPageChange={(e, n) => {
                  e.preventDefault()
                  setParams((p) => {
                    const next = new URLSearchParams(p)
                    next.set('page', String(n))
                    return next
                  })
                }}
              />
            )}
          </div>
        )}
        {branches.data && branches.data.totalCount > branches.data.nodes.length && (
          <p className="fg-muted text-small" style={{ margin: 0 }}>
            Showing {branches.data.nodes.length.toLocaleString()} of {branches.data.totalCount.toLocaleString()} branches (the first by name).
          </p>
        )}
      </div>
      {params.get('new') === '1' && (
        <NewBranchDialog
          onClose={() =>
            setParams((p) => {
              const next = new URLSearchParams(p)
              next.delete('new')
              return next
            })
          }
        />
      )}
    </div>
  )
}

function NewBranchDialog({ onClose }: { onClose(): void }) {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [source, setSource] = useState(data.default_branch)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: async () => {
      const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${source}` }).catch(async () => octokit.rest.git.getRef({ owner, repo, ref: `tags/${source}` }))
      // Annotated tags point at a tag object: peel down to the commit.
      let sha = ref.object.sha
      let type = ref.object.type
      while (type === 'tag') {
        const { data: t } = await octokit.rest.git.getTag({ owner, repo, tag_sha: sha })
        sha = t.object.sha
        type = t.object.type
      }
      if (type !== 'commit') throw new Error(`${source} does not point to a commit`)
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${name.trim()}`, sha })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [key] })
      onClose()
    },
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <Dialog
      title="Create a branch"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: 'Create new branch', buttonType: 'primary', onClick: () => create.mutate(), disabled: !name.trim() || create.isPending },
      ]}
    >
      <FormControl>
        <FormControl.Label>New branch name</FormControl.Label>
        <TextInput block value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '-'))} autoFocus />
      </FormControl>
      <div className="mt-3">
        <div className="text-bold mb-1">Source</div>
        <BranchPicker owner={owner} repo={repo} value={source} onChange={setSource} defaultBranch={data.default_branch} />
      </div>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
