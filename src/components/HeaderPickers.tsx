import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, RelativeTime, TextInput } from '@primer/react'
import { GitPullRequestIcon, IssueOpenedIcon, PlayIcon, TagIcon, TriangleDownIcon, type Icon } from '@primer/octicons-react'
import { useGitHub } from '../lib/github'
import { useFeatures } from '../lib/features'
import { firstLine } from '../lib/format'
import { CheckStatusIcon, CommitStatusMark, PullStateIcon } from './Status'
import { useToolbarPanel } from './toolbarPanel'
import { REVIEW_NOTE, usePullList, type PullFilter } from '../pages/workspace/PullsWorkspace'
import { useCheckedOutBranch, useRunList, type RunFilter } from '../pages/workspace/ActionsWorkspace'

interface PickerProps<F extends string> {
  icon: Icon
  kind: string
  value: string
  placeholder: string
  filters?: Array<[F, string]>
  filter?: F
  onFilter?(f: F): void
  loading: boolean
  empty: string
  foot?: ReactNode
  children(query: string, close: () => void): ReactNode
}

/** A header segment that picks one item of the open tab, the way the branch menu picks a branch. */
function Picker<F extends string>({ icon: Glyph, kind, value, placeholder, filters, filter, onFilter, loading, empty, foot, children }: PickerProps<F>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { anchor, frame } = useToolbarPanel(open, 'button')
  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const items = children(query.trim().toLowerCase(), close)
  const none = Array.isArray(items) && items.length === 0
  return (
    <ActionMenu open={open} onOpenChange={setOpen} anchorRef={anchor}>
      <ActionMenu.Anchor>
        <button type="button" className="ws-seg ws-seg-pick" aria-label={`${kind}: ${value}`}>
          <Glyph />
          <span className="ws-seg-text">
            <span className="ws-seg-key">{kind}</span>
            <span className="ws-seg-value">{value}</span>
          </span>
          <TriangleDownIcon />
        </button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium" className="ws-toolbar-panel" style={frame}>
        <div className="ws-toolbar-panel-body">
          <div className="ws-menu-filter">
            <TextInput block autoFocus aria-label={placeholder} placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          {filters && filter && onFilter && (
            <div className="ws-filters ws-menu-filters" role="group" aria-label={`Filter ${kind.toLowerCase()}s`}>
              {filters.map(([id, label]) => (
                <button key={id} type="button" className="ws-filter" aria-pressed={filter === id} onClick={() => onFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <ActionList selectionVariant="single" className="ws-menu-list">
            {items}
          </ActionList>
          {loading ? <p className="ws-note p-3">Loading…</p> : none && <p className="ws-note p-3">{empty}</p>}
          {foot && (
            <div className="ws-list-foot" onClick={close}>
              {foot}
            </div>
          )}
        </div>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

function PullPicker({ owner, repo, current }: { owner: string; repo: string; current: string | null }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<PullFilter>('all')
  const pulls = usePullList(owner, repo, filter)
  const all = usePullList(owner, repo, 'all')
  const picked = all.rows.find((p) => String(p.number) === current) ?? pulls.rows.find((p) => String(p.number) === current)
  const base = `/${owner}/${repo}`
  return (
    <Picker
      icon={GitPullRequestIcon}
      kind="Pull request"
      value={picked ? `#${picked.number} ${firstLine(picked.title)}` : current ? `#${current}` : 'Choose a pull request'}
      placeholder="Filter pull requests"
      filters={[
        ['all', 'All'],
        ['review', 'To review'],
        ['mine', 'Mine'],
      ]}
      filter={filter}
      onFilter={(f) => setFilter(f as typeof filter)}
      loading={pulls.isLoading}
      empty={filter === 'review' ? 'Nothing waiting for your review.' : filter === 'mine' ? 'You have no open pull requests here.' : 'No pull requests match.'}
      foot={
        <>
          <Link to={`${base}/pulls/all`}>Search and filter all</Link>
          <Link to={`${base}/compare`}>New pull request</Link>
        </>
      }
    >
      {(q, close) =>
        pulls.rows
          .filter((p) => !q || `#${p.number} ${p.title} ${p.author?.login ?? ''} ${p.headRefName}`.toLowerCase().includes(q))
          .map((p) => {
            const check = p.commits.nodes[0]?.commit.statusCheckRollup?.state.toLowerCase() as 'success' | 'failure' | 'pending' | 'error' | undefined
            const review = p.reviewDecision ? REVIEW_NOTE[p.reviewDecision] : ''
            return (
              <ActionList.Item
                key={p.number}
                selected={String(p.number) === current}
                onSelect={() => {
                  navigate(`${base}/pull/${p.number}`)
                  close()
                }}
              >
                <ActionList.LeadingVisual>
                  <PullStateIcon pull={{ state: p.state === 'OPEN' ? 'open' : 'closed', merged: p.state === 'MERGED', draft: p.isDraft }} />
                </ActionList.LeadingVisual>
                {firstLine(p.title)}
                <ActionList.Description variant="block">
                  #{p.number} · {p.author?.login ?? 'ghost'}
                  {review && ` · ${review}`}
                  {pulls.isMine(p) && ' · Current branch'}
                </ActionList.Description>
                {check && (
                  <ActionList.TrailingVisual>
                    <CommitStatusMark state={check} />
                  </ActionList.TrailingVisual>
                )}
              </ActionList.Item>
            )
          })
      }
    </Picker>
  )
}

function RunPicker({ owner, repo, current }: { owner: string; repo: string; current: string | null }) {
  const navigate = useNavigate()
  const { branch } = useCheckedOutBranch(owner, repo)
  const [filter, setFilter] = useState<RunFilter>('all')
  const runs = useRunList(owner, repo, filter)
  const all = useRunList(owner, repo, 'all')
  const picked = all.data?.find((r) => String(r.id) === current) ?? runs.data?.find((r) => String(r.id) === current)
  const base = `/${owner}/${repo}/actions`
  const filters: Array<[RunFilter, string]> = [
    ['all', 'All'],
    ['failing', 'Failing'],
    ...(branch ? [['branch', 'This branch'] as [RunFilter, string]] : []),
  ]
  return (
    <Picker
      icon={PlayIcon}
      kind={picked ? `Run · ${picked.name}` : 'Run'}
      value={picked ? firstLine(picked.display_title) : current ? `Run ${current}` : 'Choose a run'}
      placeholder="Filter runs"
      filters={filters}
      filter={filter}
      onFilter={(f) => setFilter(f as typeof filter)}
      loading={runs.isLoading}
      empty="No runs match this filter."
      foot={<Link to={`${base}/all`}>All workflows and filters</Link>}
    >
      {(q, close) =>
        (runs.data ?? [])
          .filter((r) => !q || `${r.display_title} ${r.name} ${r.head_branch}`.toLowerCase().includes(q))
          .map((r) => (
            <ActionList.Item
              key={r.id}
              selected={String(r.id) === current}
              onSelect={() => {
                navigate(`${base}/runs/${r.id}`)
                close()
              }}
            >
              <ActionList.LeadingVisual>
                <CheckStatusIcon status={r.status} conclusion={r.conclusion} />
              </ActionList.LeadingVisual>
              {firstLine(r.display_title)}
              <ActionList.Description variant="block">
                {r.name} · {r.head_branch} · <RelativeTime date={new Date(r.created_at)} />
              </ActionList.Description>
            </ActionList.Item>
          ))
      }
    </Picker>
  )
}

function IssuePicker({ owner, repo, current }: { owner: string; repo: string; current: string | null }) {
  const navigate = useNavigate()
  const { octokit, key } = useGitHub()
  const [filter, setFilter] = useState<'open' | 'closed'>('open')
  const issues = useQuery({
    queryKey: [key, 'workspace-issues', owner, repo, filter],
    staleTime: 30_000,
    queryFn: async () => (await octokit.rest.issues.listForRepo({ owner, repo, state: filter, per_page: 50 })).data.filter((i) => !i.pull_request),
  })
  const shown = useQuery({
    queryKey: [key, 'issue', owner, repo, Number(current)],
    enabled: !!current && !issues.data?.some((i) => String(i.number) === current),
    queryFn: async () => (await octokit.rest.issues.get({ owner, repo, issue_number: Number(current) })).data,
  })
  const picked = issues.data?.find((i) => String(i.number) === current) ?? shown.data
  const base = `/${owner}/${repo}/issues`
  return (
    <Picker
      icon={IssueOpenedIcon}
      kind="Issue"
      value={picked ? `#${picked.number} ${firstLine(picked.title)}` : current ? `#${current}` : 'Choose an issue'}
      placeholder="Filter issues"
      filters={[
        ['open', 'Open'],
        ['closed', 'Closed'],
      ]}
      filter={filter}
      onFilter={(f) => setFilter(f as typeof filter)}
      loading={issues.isLoading}
      empty={filter === 'open' ? 'No open issues.' : 'No closed issues.'}
      foot={
        <>
          <Link to={base}>Search and filter all</Link>
          <Link to={`${base}/new`}>New issue</Link>
        </>
      }
    >
      {(q, close) =>
        (issues.data ?? [])
          .filter((i) => !q || `#${i.number} ${i.title} ${i.user?.login ?? ''}`.toLowerCase().includes(q))
          .map((i) => (
            <ActionList.Item
              key={i.number}
              selected={String(i.number) === current}
              onSelect={() => {
                navigate(`${base}/${i.number}`)
                close()
              }}
            >
              <ActionList.LeadingVisual>
                <IssueOpenedIcon className={i.state === 'open' ? 'fg-success' : 'fg-done'} />
              </ActionList.LeadingVisual>
              {firstLine(i.title)}
              <ActionList.Description variant="block">
                #{i.number} · {i.user?.login ?? 'ghost'}
                {i.comments ? ` · ${i.comments} comment${i.comments === 1 ? '' : 's'}` : ''}
              </ActionList.Description>
            </ActionList.Item>
          ))
      }
    </Picker>
  )
}

function ReleasePicker({ owner, repo, current }: { owner: string; repo: string; current: string | null }) {
  const navigate = useNavigate()
  const { octokit, key } = useGitHub()
  const releases = useQuery({
    queryKey: [key, 'workspace-releases', owner, repo],
    staleTime: 60_000,
    queryFn: async () => (await octokit.rest.repos.listReleases({ owner, repo, per_page: 50 })).data,
  })
  const picked = releases.data?.find((r) => r.tag_name === current)
  const base = `/${owner}/${repo}/releases`
  return (
    <Picker
      icon={TagIcon}
      kind="Release"
      value={picked ? picked.name || picked.tag_name : current ?? 'Choose a release'}
      placeholder="Filter releases"
      loading={releases.isLoading}
      empty="No releases match."
      foot={
        <>
          <Link to={base}>All releases</Link>
          <Link to={`${base}/new`}>New release</Link>
        </>
      }
    >
      {(q, close) =>
        (releases.data ?? [])
          .filter((r) => !q || `${r.name ?? ''} ${r.tag_name}`.toLowerCase().includes(q))
          .map((r) => (
            <ActionList.Item
              key={r.id}
              selected={r.tag_name === current}
              onSelect={() => {
                navigate(`${base}/tag/${encodeURIComponent(r.tag_name)}`)
                close()
              }}
            >
              <ActionList.LeadingVisual>
                <TagIcon />
              </ActionList.LeadingVisual>
              {r.name || r.tag_name}
              <ActionList.Description variant="block">
                {[r.tag_name, r.draft ? 'Draft' : r.prerelease ? 'Pre-release' : ''].filter(Boolean).join(' · ')}
                {r.published_at && (
                  <>
                    {' · '}
                    <RelativeTime date={new Date(r.published_at)} />
                  </>
                )}
              </ActionList.Description>
            </ActionList.Item>
          ))
      }
    </Picker>
  )
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The header segment for the open tab's items, when that tab has items to pick. */
export function TabItemPicker({ owner, repo }: { owner: string; repo: string }) {
  const { pathname } = useLocation()
  const { isOn } = useFeatures()
  const parts = pathname.split('/').filter(Boolean)
  const [section, a, b] = [parts[2] ?? '', parts[3] ?? '', parts[4] ?? '']
  const props = { key: `${owner}/${repo}/${section}`, owner, repo }
  if (section === 'pull' || section === 'compare' || (section === 'pulls' && a !== 'all')) return <PullPicker {...props} current={section === 'pull' ? a : null} />
  if (section === 'actions' && (a === '' || a === 'runs')) return <RunPicker {...props} current={a === 'runs' ? b : null} />
  if (section === 'issues' && isOn('issues') && a !== 'new') return <IssuePicker {...props} current={/^\d+$/.test(a) ? a : null} />
  if (section === 'releases' && (a === '' || a === 'tag')) return <ReleasePicker {...props} current={a === 'tag' ? safeDecode(parts.slice(4).join('/')) : null} />
  return null
}
