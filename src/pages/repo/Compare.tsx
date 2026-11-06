import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, ButtonGroup, RelativeTime, SegmentedControl, TextInput } from '@primer/react'
import { ArrowLeftIcon, GitBranchIcon, CheckIcon, GitCommitIcon, GitCompareIcon, PeopleIcon, SparkleFillIcon, TriangleDownIcon, FileDiffIcon, DiffAddedIcon, DiffModifiedIcon, DiffRemovedIcon, DiffRenamedIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo, useBranches, encodePath } from '../../lib/repo'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { firstLine, plural, restLines } from '../../lib/format'
import { readPref, writePref } from '../../lib/storage'
import { BranchPicker } from '../../components/BranchPicker'
import { Composer } from '../../components/Composer'
import { Blankslate, DiffStat, ErrorBox, Loading, UserAvatar } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { PullStateIcon } from '../../components/Status'
import { openExternal } from '../../lib/platform'
import { contentElementById } from '../../lib/scroll'
import { useEffectOnChange } from '../../lib/activity'
import { CommitTimeline } from './Commits'

const DIFF_DOCS = 'https://docs.github.com/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-comparing-branches-in-pull-requests#three-dot-and-two-dot-git-diff-comparisons'

function DocsLink({ children }: { children: ReactNode }) {
  return (
    <a href={DIFF_DOCS} onClick={(e) => (e.preventDefault(), openExternal(DIFF_DOCS))}>
      {children}
    </a>
  )
}

type RecentBranch = { name: string; date: string; pr: number | null }
type RecentRefs = { repository: { refs: { nodes: Array<{ name: string; target: { committedDate?: string } | null; associatedPullRequests: { nodes: Array<{ number: number }> } }> } } }

/** The branches with the newest commits, the ones most likely to need a pull request. */
function useRecentBranches(owner: string, repo: string, skip: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'recent-branches', owner, repo],
    staleTime: 30_000,
    queryFn: async (): Promise<RecentBranch[]> => {
      const res: RecentRefs = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ refs(refPrefix:"refs/heads/", first:100){ nodes{ name target{ ... on Commit { committedDate } } associatedPullRequests(states:OPEN, first:1){ nodes{ number } } } } } }`,
        { owner, repo },
      )
      return res.repository.refs.nodes.map((n) => ({ name: n.name, date: n.target?.committedDate ?? '', pr: n.associatedPullRequests.nodes[0]?.number ?? null })).sort((a, b) => b.date.localeCompare(a.date))
    },
    select: (rows) => rows.filter((r) => r.name !== skip).slice(0, 6),
  })
}

/** Where a new pull request starts: pick the branch with the changes. */
function ChooseHead({ owner, repo, base, onPick }: { owner: string; repo: string; base: string; onPick: (head: string) => void }) {
  const recent = useRecentBranches(owner, repo, base)
  return (
    <>
      <div className="compare-hint">
        <span>
          Choose a branch to compare with <strong>{base}</strong> to discuss and review its changes.
        </span>
        <Button variant="primary" disabled>
          Create pull request
        </Button>
      </div>
      {recent.isLoading ? (
        <Loading />
      ) : recent.data?.length ? (
        <div className="compare-recent">
          <h2>Recently updated branches</h2>
          <ul>
            {recent.data.map((b) => (
              <li key={b.name}>
                <GitBranchIcon className="fg-muted" />
                <strong className="compare-recent-name">{b.name}</strong>
                {b.date && (
                  <span className="fg-muted text-small">
                    updated <RelativeTime date={new Date(b.date)} />
                  </span>
                )}
                <span className="flex-1" />
                {b.pr ? (
                  <Button size="small" as={Link} to={`/${owner}/${repo}/pull/${b.pr}`}>
                    View pull request #{b.pr}
                  </Button>
                ) : (
                  <Button size="small" onClick={() => onPick(b.name)}>
                    Compare & pull request
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Blankslate icon={<GitCompareIcon size={24} />} title="No other branches yet">
          Push a branch with your changes, then come back to open a pull request.
        </Blankslate>
      )}
    </>
  )
}

function FileStatusIcon({ status }: { status: string }) {
  if (status === 'added') return <DiffAddedIcon className="fg-success" aria-label="added" />
  if (status === 'removed') return <DiffRemovedIcon className="fg-danger" aria-label="removed" />
  if (status === 'renamed') return <DiffRenamedIcon className="fg-muted" aria-label="renamed" />
  return <DiffModifiedIcon className="fg-attention" aria-label="modified" />
}

export function ComparePage() {
  // Remount per comparison so the PR form (title, body, draft) starts fresh and auto-fills from the new commits.
  const params = useParams()
  return <CompareForm key={params['*'] ?? ''} />
}

function CompareForm() {
  const { owner, repo, data, fullName } = useRepo()
  const params = useParams()
  const navigate = useNavigate()
  const agent = useAgent()
  const { octokit, key, account } = useGitHub()
  // The router has already decoded the splat; decoding again breaks refs containing '%'.
  const splat = params['*'] ?? ''
  const [baseRaw, headRaw] = splat.includes('...') ? splat.split('...') : [data.default_branch, splat]
  const base = baseRaw || data.default_branch
  const head = headRaw || ''
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draftPr, setDraftPr] = useState(false)
  const [split, setSplit] = useState(() => readPref('diffSplit', false))
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})
  const [tocOpen, setTocOpen] = useState(false)

  const go = (b: string, h: string) => navigate(`/${owner}/${repo}/compare/${encodePath(b)}...${encodePath(h)}`)

  useAgentPageContext({
    label: head ? `comparison ${base}...${head} in ${fullName} (new pull request form)` : `the compare page of ${fullName}`,
    owner,
    repo,
    details: { base, head },
    suggestions: head
      ? [
          { label: 'Write PR description', prompt: `Write a pull request title and description for merging ${head} into ${base} in ${fullName}, based on the commits and diff (compare_refs, get_commit). Output the title on the first line, then the markdown body.` },
          { label: 'Pre-review changes', prompt: `Before I open a PR, review the changes on ${head} compared to ${base} in ${fullName}. Report problems with file:line.` },
        ]
      : [],
  })

  const compare = useQuery({
    queryKey: [key, 'compare', owner, repo, base, head],
    enabled: !!head && head !== base,
    queryFn: async () => (await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}` })).data,
  })
  // A pull request needs a branch as its head: tags and commit SHAs only get "Comparing changes".
  const branches = useBranches(owner, repo)
  const knownBranch = head.includes(':') || !!branches.data?.some((b) => b.name === head)
  const branchCheck = useQuery({
    queryKey: [key, 'is-branch', owner, repo, head],
    enabled: !!head && !!branches.data && !knownBranch,
    staleTime: 5 * 60_000,
    // GraphQL answers null for a missing ref, where REST getBranch logs a 404 for every tag or SHA head.
    queryFn: async () => {
      const res: { repository: { ref: { name: string } | null } | null } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$q:String!){ repository(owner:$owner,name:$repo){ ref(qualifiedName:$q){ name } } }`,
        { owner, repo, q: `refs/heads/${head}` },
      )
      return !!res.repository?.ref
    },
  })
  const headIsBranch = knownBranch || !!branchCheck.data
  const existing = useQuery({
    queryKey: [key, 'existing-pr', owner, repo, base, head],
    enabled: !!head,
    queryFn: async () => (await octokit.rest.pulls.list({ owner, repo, head: head.includes(':') ? head : `${owner}:${head}`, base, state: 'open' })).data[0] ?? null,
  })

  useEffectOnChange(() => {
    const commits = compare.data?.commits
    if (!commits || title) return
    if (commits.length === 1) {
      setTitle(firstLine(commits[0].commit.message))
      setBody(restLines(commits[0].commit.message))
    } else if (commits.length > 1) setTitle(head.replace(/[-_/]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare.data])

  const create = useMutation({
    mutationFn: async () => (await octokit.rest.pulls.create({ owner, repo, base, head, title, body, draft: draftPr })).data,
    onSuccess: (pr) => navigate(`/${owner}/${repo}/pull/${pr.number}`),
  })

  const c = compare.data
  const files = c?.files ?? []
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  const contributors = new Set((c?.commits ?? []).map((cm) => cm.author?.login ?? cm.commit.author?.email ?? cm.commit.author?.name)).size
  // github.com titles the page "Open a pull request" only while the new pull request form is showing.
  const prForm = !!head && head !== base && headIsBranch && !(c && c.ahead_by === 0) && !existing.data
  return (
    <div className="container-xl">
      <div className="compare-subhead">
        <h1>{prForm ? 'Open a pull request' : head ? 'Comparing changes' : 'Compare changes'}</h1>
        <div className="compare-subhead-description">
          {prForm ? (
            <>
              Create a new pull request by comparing changes across two branches. <DocsLink>Learn more about diff comparisons here</DocsLink>.
            </>
          ) : head ? (
            <>
              Choose two branches to see what’s changed or to start a new pull request. If you need to, you can also <DocsLink>learn more about diff comparisons</DocsLink>.
            </>
          ) : (
            'Compare changes across branches, commits, tags, and more below.'
          )}
        </div>
      </div>
      <div className="compare-range-editor">
        <GitCompareIcon className="fg-muted" />
        <BranchPicker size="small" owner={owner} repo={repo} value={base} prefix="base:" defaultBranch={data.default_branch} onChange={(b) => go(b, head || data.default_branch)} />
        <span className="compare-range-arrow" aria-hidden>
          <ArrowLeftIcon />
          <span>...</span>
        </span>
        <BranchPicker size="small" owner={owner} repo={repo} value={head || 'choose…'} prefix="compare:" defaultBranch={data.default_branch} onChange={(h) => go(base, h)} />
        {c && (
          <span className={`flex-center gap-1 text-small ${c.status === 'diverged' || c.status === 'ahead' ? 'fg-success' : 'fg-muted'}`}>
            {c.ahead_by > 0 && <CheckIcon />}
            {c.ahead_by > 0 ? `${plural(c.ahead_by, 'commit')} ahead` : 'Nothing to compare'}
            {c.behind_by > 0 && `, ${c.behind_by} behind`}
          </span>
        )}
      </div>

      {!head ? (
        <ChooseHead owner={owner} repo={repo} base={base} onPick={(h) => go(base, h)} />
      ) : head === base ? (
        <Blankslate icon={<GitCompareIcon size={24} />} title="There isn’t anything to compare.">
          You’ll need to use two different branch names to get a valid comparison.
        </Blankslate>
      ) : compare.isLoading ? (
        <Loading />
      ) : compare.error ? (
        <ErrorBox error={compare.error} />
      ) : c && c.ahead_by === 0 ? (
        <Blankslate icon={<GitCompareIcon size={24} />} title="There isn’t anything to compare.">
          <strong className="fg-default">{base}</strong> is up to date with all commits from <strong className="fg-default">{head}</strong>. Try <Link to={`/${owner}/${repo}/compare/${encodePath(head)}...${encodePath(base)}`}>switching the base</Link> for your comparison.
        </Blankslate>
      ) : c ? (
        <>
          {existing.data ? (
            <div className="Box Box-body mb-3 flex-center gap-2">
              <PullStateIcon pull={{ state: 'open', draft: existing.data.draft }} />
              <Link to={`/${owner}/${repo}/pull/${existing.data.number}`} className="text-bold">
                {existing.data.title} #{existing.data.number}
              </Link>
              <span className="fg-muted">is already open for this branch.</span>
            </div>
          ) : prForm ? (
            <div className="timeline-comment-group mb-4">
              <div className="avatar-col">
                <UserAvatar login={account.login} src={account.avatarUrl} size={40} />
              </div>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div className="flex-center gap-2 mb-2">
                  <TextInput data-tab-draft block size="large" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
                  <Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Write a pull request title and description for merging ${head} into ${base} in ${fullName}. First line is the title, then the markdown body.`)}>
                    Draft with agent
                  </Button>
                </div>
                <Composer
                  value={body}
                  onChange={setBody}
                  context={fullName}
                  rows={8}
                  placeholder="Add a description"
                  actions={
                    <ButtonGroup>
                      <Button variant="primary" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                        {draftPr ? 'Create draft pull request' : 'Create pull request'}
                      </Button>
                      <ActionMenu>
                        <ActionMenu.Anchor>
                          <Button variant="primary" aria-label="Pull request type">
                            <TriangleDownIcon />
                          </Button>
                        </ActionMenu.Anchor>
                        <ActionMenu.Overlay width="medium">
                          <ActionList selectionVariant="single">
                            <ActionList.Item selected={!draftPr} onSelect={() => setDraftPr(false)}>
                              Create pull request
                              <ActionList.Description variant="block">Open a pull request that is ready for review.</ActionList.Description>
                            </ActionList.Item>
                            <ActionList.Item selected={draftPr} onSelect={() => setDraftPr(true)}>
                              Create draft pull request
                              <ActionList.Description variant="block">Cannot be merged until marked ready for review.</ActionList.Description>
                            </ActionList.Item>
                          </ActionList>
                        </ActionMenu.Overlay>
                      </ActionMenu>
                    </ButtonGroup>
                  }
                />
                {create.error && <div className="error-box mt-2">{errorMessage(create.error)}</div>}
              </div>
            </div>
          ) : null}

          <div className="Box mb-3">
            <ul className="compare-stats">
              <li>
                <GitCommitIcon className="fg-muted" /> <strong>{c.total_commits.toLocaleString()}</strong> <span className="fg-muted">{c.total_commits === 1 ? 'commit' : 'commits'}</span>
              </li>
              <li>
                <FileDiffIcon className="fg-muted" /> <strong>{files.length.toLocaleString()}</strong> <span className="fg-muted">{files.length === 1 ? 'file changed' : 'files changed'}</span>
              </li>
              <li>
                <PeopleIcon className="fg-muted" /> <strong>{contributors.toLocaleString()}</strong> <span className="fg-muted">{contributors === 1 ? 'contributor' : 'contributors'}</span>
              </li>
            </ul>
          </div>
          <CommitTimeline owner={owner} repo={repo} commits={c.commits} />
          {c.total_commits > c.commits.length && (
            <p className="fg-muted text-small compare-commits-note">
              This comparison is big! We’re only showing the most recent {c.commits.length.toLocaleString()} commits.
            </p>
          )}
          <div className="compare-files-header">
            <div className="compare-files-summary">
              <FileDiffIcon className="fg-muted" />
              <span>
                Showing{' '}
                <button type="button" className="compare-toc-toggle" aria-expanded={tocOpen} onClick={() => setTocOpen(!tocOpen)}>
                  {plural(files.length, 'changed file')}
                </button>{' '}
                with <strong>{plural(additions, 'addition')}</strong> and <strong>{plural(deletions, 'deletion')}</strong>.
              </span>
            </div>
            <SegmentedControl aria-label="Diff view" size="small" onChange={(i) => (setSplit(i === 0), writePref('diffSplit', i === 0))}>
              <SegmentedControl.Button selected={split}>Split</SegmentedControl.Button>
              <SegmentedControl.Button selected={!split}>Unified</SegmentedControl.Button>
            </SegmentedControl>
          </div>
          {tocOpen && (
            <ol className="compare-toc">
              {files.map((f, i) => (
                <li key={`${i}-${f.filename}`}>
                  <FileStatusIcon status={f.status} />
                  <a
                    href={`#diff-${i}`}
                    onClick={(e) => {
                      e.preventDefault()
                      setCollapsed((s) => ({ ...s, [i]: false }))
                      requestAnimationFrame(() => contentElementById(`diff-${i}`)?.scrollIntoView({ block: 'start' }))
                    }}
                  >
                    {f.filename}
                  </a>
                  <span className="ml-auto">
                    <DiffStat additions={f.additions} deletions={f.deletions} />
                  </span>
                </li>
              ))}
            </ol>
          )}
          {files.map((f, i) => (
            <FileDiffBox
              key={`${i}-${f.filename}`}
              id={`diff-${i}`}
              file={{ path: f.filename, previousPath: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch, sha: f.sha }}
              split={split}
              collapsed={collapsed[i]}
              onToggle={() => setCollapsed((s) => ({ ...s, [i]: !s[i] }))}
            />
          ))}
        </>
      ) : null}
    </div>
  )
}
