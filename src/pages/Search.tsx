import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Avatar, Label, NavList, RelativeTime } from '@primer/react'
import { RepoIcon, IssueOpenedIcon, GitPullRequestIcon, StarIcon, CodeIcon, FileCodeIcon } from '@primer/octicons-react'
import { useGitHub } from '../lib/github'
import { compactNumber } from '../lib/format'
import { encodePath } from '../lib/repo'
import { IssueList } from '../components/IssueList'
import { Blankslate, ErrorBox, Loading } from '../components/Bits'
import { LANG_COLORS } from './repo/Code'

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const repo = params.get('repo')
  const type = params.get('type') ?? (repo ? 'code' : 'repositories')
  const setType = (t: string) =>
    setParams((p) => {
      p.set('type', t)
      return p
    })
  const scope = repo ? `repo:${repo}` : ''
  return (
    <div className="container-xl">
      <div className="layout-sidebar-left" style={{ gridTemplateColumns: '256px minmax(0,1fr)' }}>
        <NavList aria-label="Result type">
          {!repo && (
            <NavList.Item aria-current={type === 'repositories' ? 'page' : undefined} onClick={() => setType('repositories')}>
              <NavList.LeadingVisual>
                <RepoIcon />
              </NavList.LeadingVisual>
              Repositories
            </NavList.Item>
          )}
          {repo && (
            <NavList.Item aria-current={type === 'code' ? 'page' : undefined} onClick={() => setType('code')}>
              <NavList.LeadingVisual>
                <CodeIcon />
              </NavList.LeadingVisual>
              Code
            </NavList.Item>
          )}
          <NavList.Item aria-current={type === 'issues' ? 'page' : undefined} onClick={() => setType('issues')}>
            <NavList.LeadingVisual>
              <IssueOpenedIcon />
            </NavList.LeadingVisual>
            Issues
          </NavList.Item>
          <NavList.Item aria-current={type === 'pulls' ? 'page' : undefined} onClick={() => setType('pulls')}>
            <NavList.LeadingVisual>
              <GitPullRequestIcon />
            </NavList.LeadingVisual>
            Pull requests
          </NavList.Item>
        </NavList>
        <div style={{ minWidth: 0 }}>
          {repo && (
            <p className="fg-muted" style={{ marginTop: 0 }}>
              Searching in <Link to={`/${repo}`}>{repo}</Link> · <Link to={`/search?q=${encodeURIComponent(q)}`}>search all of GitHub</Link>
            </p>
          )}
          {type === 'repositories' ? (
            <RepoResults q={q} />
          ) : type === 'code' && repo ? (
            <CodeResults q={q} repo={repo} />
          ) : (
            <IssueList key={type} kind={type === 'pulls' ? 'pr' : 'issue'} scope={scope} defaultQuery={`${q} is:open`} showRepo={!repo} />
          )}
        </div>
      </div>
    </div>
  )
}

function RepoResults({ q }: { q: string }) {
  const { octokit, key } = useGitHub()
  const res = useQuery({
    queryKey: [key, 'search-repos', q],
    enabled: !!q,
    queryFn: async () => (await octokit.rest.search.repos({ q, per_page: 30 })).data,
  })
  if (!q) return <Blankslate title="Search GitHub">Type in the header search box and press Enter.</Blankslate>
  if (res.isLoading) return <Loading />
  if (res.error) return <ErrorBox error={res.error} />
  return (
    <>
      <h2 className="section-title">{res.data?.total_count.toLocaleString()} repository results</h2>
      <div className="Box">
        {res.data?.items.map((r) => (
          <div key={r.id} className="Box-row">
            <Avatar src={r.owner?.avatar_url ?? ''} size={20} square={r.owner?.type === 'Organization'} />
            <div className="flex-1">
              <Link to={`/${r.full_name}`} className="text-bold" style={{ fontSize: 16 }}>
                {r.full_name}
              </Link>
              {r.description && <p style={{ margin: '4px 0' }}>{r.description}</p>}
              <div className="flex-center gap-3 text-small fg-muted wrap">
                {r.language && (
                  <span>
                    <span className="lang-dot" style={{ background: LANG_COLORS[r.language] ?? 'var(--fgColor-muted)' }} />
                    {r.language}
                  </span>
                )}
                <span className="flex-center gap-1">
                  <StarIcon /> {compactNumber(r.stargazers_count)}
                </span>
                <span>
                  Updated <RelativeTime date={new Date(r.updated_at)} />
                </span>
                {r.archived && <Label variant="attention">Archived</Label>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function CodeResults({ q, repo }: { q: string; repo: string }) {
  const { octokit, key } = useGitHub()
  const res = useQuery({
    queryKey: [key, 'search-code', q, repo],
    enabled: !!q,
    queryFn: async () => (await octokit.rest.search.code({ q: `${q} repo:${repo}`, per_page: 50 })).data,
  })
  if (res.isLoading) return <Loading />
  if (res.error) return <ErrorBox error={res.error} />
  return (
    <>
      <h2 className="section-title">{res.data?.total_count.toLocaleString()} code results</h2>
      <div className="Box">
        {res.data?.items.map((i) => (
          <div key={i.sha + i.path} className="Box-row">
            <FileCodeIcon className="fg-muted" />
            <Link to={`/${repo}/blob/HEAD/${encodePath(i.path)}`} className="text-mono">
              {i.path}
            </Link>
          </div>
        ))}
      </div>
    </>
  )
}
