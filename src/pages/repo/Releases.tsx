import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Breadcrumbs, Button, IconButton, Label, Pagination, RelativeTime } from '@primer/react'
import {
  TagIcon,
  GitCommitIcon,
  PackageIcon,
  FileZipIcon,
  FileIcon,
  ClockIcon,
  EllipsisIcon,
  SparkleFillIcon,
  DownloadIcon,
  VerifiedIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  TrashIcon,
} from '@primer/octicons-react'
import { useGitHub, errorMessage, FULL_BODY } from '../../lib/github'
import { useRepo, useTags, encodePath } from '../../lib/repo'
import { useLatestRelease, useReleaseByTag, type Release } from '../../lib/releases'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { formatBytes, compactNumber, shortSha } from '../../lib/format'
import { openExternal } from '../../lib/platform'
import { Blankslate, CopyButton, ErrorBox, Loading, UserAvatar, botName, isBot } from '../../components/Bits'
import { Markdown } from '../../components/Markdown'
import { ReactionSummary } from '../../components/Timeline'
import { useCanPush, useDeleteRelease } from './ReleaseForm'

type TagCommit = { oid: string; verified: boolean }

/** Commit each release tag points at (REST only has target_commitish), plus commits on the default branch since one tag. */
function useReleaseCommits(owner: string, repo: string, tags: string[], since?: { tag: string; branch: string }) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'release-commits', owner, repo, tags, since],
    enabled: tags.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const vars: Record<string, string> = { owner, repo }
      const decl: string[] = []
      const fields = tags.map((t, i) => {
        vars[`t${i}`] = t
        decl.push(`$t${i}:String!`)
        return `r${i}: release(tagName:$t${i}){ tagCommit{ oid signature{ isValid } } }`
      })
      if (since) {
        vars.sinceRef = `refs/tags/${since.tag}`
        vars.sinceBranch = since.branch
        decl.push('$sinceRef:String!', '$sinceBranch:String!')
        fields.push('since: ref(qualifiedName:$sinceRef){ compare(headRef:$sinceBranch){ aheadBy } }')
      }
      const res: { repository: Record<string, { tagCommit?: { oid: string; signature: { isValid: boolean } | null } | null; compare?: { aheadBy: number } | null } | null> } =
        await octokit.graphql(`query($owner:String!,$repo:String!,${decl.join(',')}){ repository(owner:$owner,name:$repo){ ${fields.join(' ')} } }`, vars)
      const commits: Record<string, TagCommit | null> = {}
      tags.forEach((t, i) => {
        const c = res.repository[`r${i}`]?.tagCommit
        commits[t] = c ? { oid: c.oid, verified: !!c.signature?.isValid } : null
      })
      return { commits, commitsSince: res.repository.since?.compare?.aheadBy ?? null }
    },
  })
}

function ReleasesSubnav({ current }: { current: 'releases' | 'tags' }) {
  const { owner, repo } = useRepo()
  return (
    <nav aria-label="Releases and Tags" className="release-subnav">
      <Link to={`/${owner}/${repo}/releases`} className="release-subnav-item" aria-current={current === 'releases' ? 'page' : undefined}>
        Releases
      </Link>
      <Link to={`/${owner}/${repo}/tags`} className="release-subnav-item" aria-current={current === 'tags' ? 'page' : undefined}>
        Tags
      </Link>
    </nav>
  )
}

/** /releases and /tags share a route; github.com renders them as two tabs of one page. */
export function ReleasesPage() {
  const { pathname } = useLocation()
  return /\/tags\/?$/.test(pathname) ? <TagsPage /> : <ReleaseListPage />
}

function ReleaseListPage() {
  const { owner, repo, fullName, data } = useRepo()
  const { octokit, key } = useGitHub()
  const agent = useAgent()
  const canPush = useCanPush()
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number(params.get('page') || 1))

  const releases = useQuery({
    queryKey: [key, 'releases', owner, repo, page],
    queryFn: async () => {
      const res = await octokit.rest.repos.listReleases({ owner, repo, per_page: 10, page, ...FULL_BODY })
      const link = res.headers.link ?? ''
      const last = link.match(/[?&]page=(\d+)>; rel="last"/)
      return { items: res.data as Release[], hasNext: /rel="next"/.test(link), pageCount: last ? Number(last[1]) : page }
    },
  })
  const latestRelease = useLatestRelease(owner, repo)
  const items = releases.data?.items ?? []
  const commits = useReleaseCommits(owner, repo, items.filter((r) => !r.draft).map((r) => r.tag_name))
  const latest = items.find((r) => r.id === latestRelease.data?.id)
  const draftNotes = `Draft release notes for the next release of ${fullName}: compare the latest release tag${latest ? ` (${latest.tag_name})` : ''} with ${data.default_branch}, group merged changes into Features, Fixes and Other, credit authors, and flag anything that looks breaking.`

  useAgentPageContext({
    label: `releases of ${fullName}`,
    owner,
    repo,
    details: { latest: latest?.tag_name },
    suggestions: [{ label: 'Draft release notes', prompt: draftNotes }],
  })

  const goTo = (n: number) => {
    setParams({ page: String(n) })
    window.scrollTo(0, 0)
  }
  const pageCount = Math.max(page, releases.data?.pageCount ?? 1, releases.data?.hasNext ? page + 1 : 1)

  return (
    <div className="container-xl">
      <div className="release-head">
        <ReleasesSubnav current="releases" />
        <div className="flex-center gap-2">
          <Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask(draftNotes)}>
            Draft notes with agent
          </Button>
          {canPush && (
            <Button as={Link} to={`/${owner}/${repo}/releases/new`}>
              Draft a new release
            </Button>
          )}
        </div>
      </div>
      {releases.isLoading ? (
        <Loading />
      ) : releases.error ? (
        <ErrorBox error={releases.error} />
      ) : items.length === 0 ? (
        canPush ? (
          <Blankslate
            icon={<TagIcon size={24} />}
            title="There aren’t any releases here"
            action={
              <Button as={Link} to={`/${owner}/${repo}/releases/new`} variant="primary">
                Create a new release
              </Button>
            }
          >
            You can create a release to package software, along with release notes and links to binary files, for other people to use. Learn more about releases in{' '}
            <a href="https://docs.github.com/repositories/releasing-projects-on-github/about-releases" onClick={(e) => (e.preventDefault(), openExternal(e.currentTarget.href))}>
              our docs
            </a>
            .
          </Blankslate>
        ) : (
          <Blankslate icon={<TagIcon size={24} />} title="There aren’t any releases here">
            Releases are powered by tagging specific points of history in a repository.
          </Blankslate>
        )
      ) : (
        <>
          <div className="release-layout">
            <div className="release-toc">
              <h2 className="release-toc-title">Release list</h2>
              <nav aria-label="Release list navigation">
                <ul>
                  {items.map((r) => (
                    <li key={r.id}>
                      <a
                        href={`#release-${r.tag_name}`}
                        title={r.name || r.tag_name}
                        onClick={(e) => {
                          e.preventDefault()
                          document.getElementById(`release-${r.tag_name}`)?.scrollIntoView({ block: 'start' })
                        }}
                      >
                        {r.name || r.tag_name}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              {pageCount > 1 && (
                <Pagination
                  className="release-toc-pagination"
                  pageCount={pageCount}
                  currentPage={page}
                  showPages={false}
                  hrefBuilder={(n) => `?page=${n}`}
                  onPageChange={(e, n) => (e.preventDefault(), goTo(n))}
                />
              )}
            </div>
            <div className="release-main">
              {items.map((r, i) => (
                <section key={r.id} id={`release-${r.tag_name}`} aria-label={r.name || r.tag_name} className="release-section">
                  <ReleaseCard r={r} isLatest={r.id === latestRelease.data?.id} expandAssets={i === 0} commit={commits.data?.commits[r.tag_name]} />
                </section>
              ))}
            </div>
          </div>
          {pageCount > 1 && (
            <Pagination pageCount={pageCount} currentPage={page} hrefBuilder={(n) => `?page=${n}`} onPageChange={(e, n) => (e.preventDefault(), goTo(n))} />
          )}
        </>
      )}
    </div>
  )
}

/** /releases/latest: github.com redirects to the latest release's tag page. */
export function LatestReleasePage() {
  const { owner, repo } = useRepo()
  const latest = useLatestRelease(owner, repo)
  if (latest.data) return <Navigate to={`/${owner}/${repo}/releases/tag/${encodePath(latest.data.tag)}`} replace />
  if (latest.isFetched) return <Navigate to={`/${owner}/${repo}/releases`} replace />
  return <Loading />
}

export function ReleasePage() {
  const { owner, repo, fullName, data } = useRepo()
  const { '*': tag = '' } = useParams()
  const canPush = useCanPush()
  const release = useReleaseByTag(owner, repo, tag, canPush)
  const latestRelease = useLatestRelease(owner, repo)
  const commits = useReleaseCommits(owner, repo, release.data && !release.data.draft ? [release.data.tag_name] : [], release.data ? { tag: release.data.tag_name, branch: data.default_branch } : undefined)
  useAgentPageContext(release.data ? { label: `release ${release.data.tag_name} of ${fullName}`, owner, repo } : null)
  return (
    <div className="container-xl">
      <Breadcrumbs className="release-breadcrumbs">
        <Breadcrumbs.Item as={Link} to={`/${owner}/${repo}/releases`}>
          Releases
        </Breadcrumbs.Item>
        <Breadcrumbs.Item as={Link} to={`/${owner}/${repo}/releases/tag/${encodePath(tag)}`} selected>
          {tag}
        </Breadcrumbs.Item>
      </Breadcrumbs>
      {release.isLoading ? (
        <Loading />
      ) : release.error ? (
        <ErrorBox error={release.error} />
      ) : !release.data ? (
        // A tag without a release (github.com links every tag here): show the code at that tag instead of an error.
        <Navigate to={`/${owner}/${repo}/tree/${encodePath(tag)}`} replace />
      ) : (
        <ReleaseCard
          r={release.data!}
          isLatest={release.data!.id === latestRelease.data?.id}
          expandAssets
          single
          commit={commits.data?.commits[release.data!.tag_name]}
          commitsSince={commits.data?.commitsSince ?? null}
        />
      )}
    </div>
  )
}

/** Users @-mentioned in the notes: github.com lists them as the release's contributors. */
function mentionedUsers(html?: string) {
  const out: string[] = []
  for (const tag of html?.match(/<a\b[^>]*\buser-mention\b[^>]*>/g) ?? []) {
    const login = tag.match(/href="[^"]*\/([^/"?#]+)"/)?.[1]
    if (login && !out.some((l) => l.toLowerCase() === login.toLowerCase())) out.push(login)
  }
  return out
}

function contributorsText(logins: string[]) {
  if (logins.length <= 2) return logins.join(' and ')
  if (logins.length === 3) return `${logins[0]}, ${logins[1]}, and ${logins[2]}`
  return `${logins[0]}, ${logins[1]}, and ${logins.length - 2} other contributors`
}

function CompareMenu({ tag }: { tag: string }) {
  const { owner, repo } = useRepo()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const tags = useTags(owner, repo, open)
  return (
    <ActionMenu open={open} onOpenChange={setOpen}>
      <ActionMenu.Button size="small">Compare</ActionMenu.Button>
      <ActionMenu.Overlay width="medium">
        <div className="release-compare-title">Choose a tag to compare</div>
        <div className="release-compare-list">
          {tags.isLoading ? (
            <Loading />
          ) : (
            <ActionList selectionVariant="single">
              {(tags.data ?? []).map((t) => (
                <ActionList.Item key={t.name} selected={t.name === tag} onSelect={() => navigate(`/${owner}/${repo}/compare/${encodePath(t.name)}...${encodePath(tag)}`)}>
                  {t.name}
                </ActionList.Item>
              ))}
            </ActionList>
          )}
        </div>
        <div className="release-compare-footer">
          <Link to={`/${owner}/${repo}/tags`} onClick={() => setOpen(false)}>
            View all tags
          </Link>
        </div>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

function ReleaseCard({
  r,
  isLatest,
  expandAssets,
  single,
  commit,
  commitsSince,
}: {
  r: Release
  isLatest: boolean
  expandAssets?: boolean
  single?: boolean
  commit?: TagCommit | null
  commitsSince?: number | null
}) {
  const { owner, repo, fullName, data } = useRepo()
  const navigate = useNavigate()
  const canPush = useCanPush()
  const deleteRelease = useDeleteRelease()
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const title = r.name || r.tag_name
  const contributors = mentionedUsers(r.body_html)
  const author = r.author
  const authorIsBot = !!author && isBot(author.login, author.type)
  const tagHref = `/${owner}/${repo}/releases/tag/${encodePath(r.tag_name)}`
  const download = (url: string) => (e: React.MouseEvent) => (e.preventDefault(), openExternal(url))
  // Drafts have no source archives (zipball_url and tarball_url are null) until they are published.
  const sources: Array<[string, string]> = []
  if (r.zipball_url) sources.push(['zip', r.zipball_url])
  if (r.tarball_url) sources.push(['tar.gz', r.tarball_url])
  return (
    <div className="Box">
      <div className="Box-body">
        <div className="release-title-row">
          <div className="release-title-wrap">
            {single ? (
              <h1 className="release-title">{title}</h1>
            ) : (
              <Link to={tagHref} className="release-title">
                {title}
              </Link>
            )}
            {isLatest && (
              <Link to={tagHref} className="release-label">
                <Label variant="success" size="large">
                  Latest
                </Label>
              </Link>
            )}
            {r.prerelease && (
              <Label variant="attention" size="large" className="release-label">
                Pre-release
              </Label>
            )}
            {r.draft && (
              <Label size="large" className="release-label">
                Draft
              </Label>
            )}
          </div>
          <div className="release-title-actions">
            {!r.draft && <CompareMenu tag={r.tag_name} />}
            {canPush && (
              <>
                <IconButton as={Link} to={`/${owner}/${repo}/releases/edit/${encodePath(r.tag_name)}`} icon={PencilIcon} variant="invisible" aria-label="Edit" />
                <IconButton
                  icon={TrashIcon}
                  variant="invisible"
                  aria-label="Delete"
                  onClick={() =>
                    deleteRelease(r, single ? () => navigate(`/${owner}/${repo}/releases`) : undefined).then(
                      () => setDeleteError(null),
                      (e) => setDeleteError(errorMessage(e)),
                    )
                  }
                />
              </>
            )}
          </div>
        </div>
        {deleteError && <div className="error-box mb-3">{deleteError}</div>}
        <div className="release-meta">
          {author && (
            <span className="release-meta-item">
              <UserAvatar login={author.login} src={author.avatar_url} size={20} />
              {authorIsBot ? (
                <span className="text-bold">{botName(author.login)}</span>
              ) : (
                <Link to={`/${author.login}`} className="text-bold link-muted">
                  {author.login}
                </Link>
              )}
              <span>
                {r.draft ? 'drafted' : 'released'} this <RelativeTime date={new Date(r.published_at ?? r.created_at)} prefix="" />
              </span>
            </span>
          )}
          {single && commitsSince != null && (
            <span className="release-meta-item">
              ·{' '}
              <Link to={`/${owner}/${repo}/compare/${encodePath(r.tag_name)}...${encodePath(data.default_branch)}`}>
                {commitsSince.toLocaleString()} {commitsSince === 1 ? 'commit' : 'commits'}
              </Link>{' '}
              to {data.default_branch} since this release
            </span>
          )}
          <span className="release-meta-item">
            {r.draft ? (
              // A draft's new tag doesn't exist until it is published.
              <span className="flex-center gap-1">
                <TagIcon /> {r.tag_name}
              </span>
            ) : (
              <Link to={`/${owner}/${repo}/tree/${encodePath(r.tag_name)}`} className="link-muted flex-center gap-1">
                <TagIcon /> {r.tag_name}
              </Link>
            )}
          </span>
          <span className="release-meta-item">
            {commit ? (
              <>
                <Link to={`/${owner}/${repo}/commit/${commit.oid}`} className="link-muted flex-center gap-1">
                  <GitCommitIcon /> <code>{shortSha(commit.oid)}</code>
                </Link>
                {commit.verified && <VerifiedIcon className="fg-success" aria-label="Verified" />}
              </>
            ) : (
              <Link to={`/${owner}/${repo}/commits/${encodePath(r.target_commitish)}`} className="link-muted flex-center gap-1">
                <GitCommitIcon /> <code>{r.target_commitish.length === 40 ? shortSha(r.target_commitish) : r.target_commitish}</code>
              </Link>
            )}
          </span>
        </div>
        <div className="release-notes">
          <Markdown html={r.body_html} text={r.body_html ? undefined : r.body} context={fullName} emptyText="No release notes." />
        </div>
      </div>
      <div className="Box-footer release-footer">
        {contributors.length > 0 && (
          <div className="release-footer-section">
            <h3 className="release-contributors-title">Contributors</h3>
            <ul className="release-contributors">
              {contributors.map((login) => (
                <li key={login}>
                  <Link to={`/${login}`} title={login}>
                    <UserAvatar login={login} size={32} />
                  </Link>
                </li>
              ))}
            </ul>
            <div className="fg-muted mt-2">{contributorsText(contributors)}</div>
          </div>
        )}
        <details className="release-footer-section release-assets" open={expandAssets}>
          <summary>
            <span className="release-assets-title">Assets</span>
            <span className="counter">{r.assets.length + sources.length}</span>
          </summary>
          <div className="Box release-assets-list">
            {r.assets.map((a) => (
              <div key={a.id} className="Box-row release-asset">
                <span className="release-asset-name">
                  <PackageIcon className="fg-muted shrink-0" />
                  <a href={a.browser_download_url} onClick={download(a.browser_download_url)} className="text-bold text-break">
                    {a.name}
                  </a>
                </span>
                <span className="release-asset-meta">
                  {a.digest && (
                    <span className="release-asset-digest">
                      <span className="text-mono text-small fg-muted text-truncate">{a.digest}</span>
                      <CopyButton text={a.digest} label={`Copy to clipboard digest for ${a.name}`} />
                    </span>
                  )}
                  <span className="fg-muted no-wrap">{formatBytes(a.size)}</span>
                  <span className="fg-muted no-wrap flex-center gap-1" title={`${a.download_count.toLocaleString()} downloads`}>
                    <DownloadIcon size={12} /> {compactNumber(a.download_count)}
                  </span>
                  <span className="fg-muted no-wrap release-asset-date">
                    <RelativeTime date={new Date(a.created_at)} />
                  </span>
                </span>
              </div>
            ))}
            {sources.map(([ext, url]) => (
              <div key={ext} className="Box-row release-asset">
                <span className="release-asset-name">
                  <FileZipIcon className="fg-muted shrink-0" />
                  <a href={url} onClick={download(url)}>
                    <span className="text-bold">Source code</span> ({ext})
                  </a>
                </span>
                <span className="release-asset-meta">
                  <span className="fg-muted no-wrap release-asset-date">
                    <RelativeTime date={new Date(r.created_at)} />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </details>
        {(r.reactions?.total_count ?? 0) > 0 && (
          <div className="release-footer-section">
            <ReactionSummary reactions={r.reactions} />
          </div>
        )}
      </div>
    </div>
  )
}

interface TagNode {
  name: string
  target:
    | { __typename: 'Commit'; oid: string; committedDate: string; message: string; signature: { isValid: boolean } | null }
    | { __typename: 'Tag'; tagger: { date: string | null } | null; target: { __typename: string; oid?: string; committedDate?: string; message?: string; signature?: { isValid: boolean } | null } }
    | { __typename: string }
}

function TagsPage() {
  const { owner, repo, fullName, data } = useRepo()
  const { octokit, key } = useGitHub()
  const [params, setParams] = useSearchParams()
  const after = params.get('after')
  const before = params.get('before')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useAgentPageContext({ label: `tags of ${fullName}`, owner, repo })

  const tags = useQuery({
    queryKey: [key, 'tags-page', owner, repo, after, before],
    queryFn: async () => {
      const commitFields = 'oid committedDate message signature{ isValid }'
      const res: { repository: { refs: { pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }; nodes: TagNode[] } } } =
        await octokit.graphql(
          `query($owner:String!,$repo:String!,$first:Int,$last:Int,$after:String,$before:String){
            repository(owner:$owner,name:$repo){
              refs(refPrefix:"refs/tags/", first:$first, last:$last, after:$after, before:$before, orderBy:{field:TAG_COMMIT_DATE, direction:DESC}){
                pageInfo{ hasNextPage hasPreviousPage startCursor endCursor }
                nodes{ name target{ __typename ... on Commit{ ${commitFields} } ... on Tag{ tagger{ date } target{ __typename ... on Commit{ ${commitFields} } } } } }
              }
            }
          }`,
          { owner, repo, first: before ? null : 10, last: before ? 10 : null, after, before },
        )
      const refs = res.repository.refs
      // Which tags have a release (Notes link) and which releases have assets (Downloads link).
      const names = refs.nodes.map((n) => n.name)
      const withRelease = new Set<string>()
      const withAssets = new Set<string>()
      if (names.length) {
        const vars: Record<string, string> = { owner, repo }
        names.forEach((n, i) => (vars[`t${i}`] = n))
        const rel: { repository: Record<string, { id: string; releaseAssets: { totalCount: number } } | null> } = await octokit.graphql(
          `query($owner:String!,$repo:String!,${names.map((_, i) => `$t${i}:String!`).join(',')}){ repository(owner:$owner,name:$repo){ ${names.map((_, i) => `r${i}: release(tagName:$t${i}){ id releaseAssets{ totalCount } }`).join(' ')} } }`,
          vars,
        )
        names.forEach((n, i) => {
          const r = rel.repository[`r${i}`]
          if (!r) return
          withRelease.add(n)
          if (r.releaseAssets.totalCount > 0) withAssets.add(n)
        })
      }
      return { ...refs, withRelease, withAssets }
    },
  })

  const info = tags.data?.pageInfo
  const hasPrev = before ? !!info?.hasPreviousPage : !!after
  const hasNext = before ? true : !!info?.hasNextPage

  return (
    <div className="container-xl">
      <div className="release-head">
        <ReleasesSubnav current="tags" />
      </div>
      <div className="release-head-width">
        {tags.isLoading ? (
          <Loading />
        ) : tags.error ? (
          <ErrorBox error={tags.error} />
        ) : !tags.data?.nodes.length ? (
          <Blankslate icon={<TagIcon size={24} />} title="There aren’t any releases here">
            Releases are powered by tagging specific points of history in a repository.
          </Blankslate>
        ) : (
          <>
            <div className="Box">
              <div className="Box-header text-bold flex-center gap-2">
                <TagIcon /> Tags
              </div>
              {tags.data.nodes.map((t) => {
                const c = (t.target.__typename === 'Tag' ? (t.target as Extract<TagNode['target'], { __typename: 'Tag' }>).target : t.target) as {
                  oid?: string
                  committedDate?: string
                  message?: string
                  signature?: { isValid: boolean } | null
                }
                const tagger = t.target.__typename === 'Tag' ? (t.target as Extract<TagNode['target'], { __typename: 'Tag' }>).tagger?.date : null
                const date = tagger ?? c.committedDate
                const hasRelease = tags.data!.withRelease.has(t.name)
                const hasAssets = tags.data!.withAssets.has(t.name)
                const ref = encodePath(t.name)
                return (
                  <div key={t.name} className="Box-row tag-row">
                    <div className="tag-row-title">
                      <h2 className="tag-name">
                        <Link to={`/${owner}/${repo}/releases/tag/${ref}`}>{t.name}</Link>
                      </h2>
                      {c.message && (
                        <IconButton
                          icon={EllipsisIcon}
                          variant="invisible"
                          size="small"
                          aria-label={`Toggle ${t.name}'s commit message`}
                          aria-expanded={!!expanded[t.name]}
                          onClick={() => setExpanded((s) => ({ ...s, [t.name]: !s[t.name] }))}
                        />
                      )}
                      {c.signature?.isValid && (
                        <Label variant="success" className="ml-auto">
                          Verified
                        </Label>
                      )}
                    </div>
                    {expanded[t.name] && c.message && <pre className="tag-message">{c.message}</pre>}
                    <ul className="tag-meta">
                      {date && (
                        <li className="fg-muted">
                          <ClockIcon /> <RelativeTime date={new Date(date)} />
                        </li>
                      )}
                      {c.oid && (
                        <li className="text-mono">
                          <Link to={`/${owner}/${repo}/commit/${c.oid}`} className="link-muted">
                            <GitCommitIcon /> {shortSha(c.oid)}
                          </Link>
                        </li>
                      )}
                      {(['zip', 'tar.gz'] as const).map((ext) => {
                        const url = `${data.html_url}/archive/refs/tags/${ref}.${ext}`
                        return (
                          <li key={ext}>
                            <a href={url} className="link-muted" onClick={(e) => (e.preventDefault(), openExternal(url))}>
                              <FileZipIcon /> {ext}
                            </a>
                          </li>
                        )
                      })}
                      {hasRelease && (
                        <>
                          <li>
                            <Link to={`/${owner}/${repo}/releases/tag/${ref}`} className="link-muted">
                              <FileIcon /> Notes
                            </Link>
                          </li>
                          {hasAssets && (
                            <li>
                              <Link to={`/${owner}/${repo}/releases/tag/${ref}`} className="link-muted">
                                <DownloadIcon /> Downloads
                              </Link>
                            </li>
                          )}
                        </>
                      )}
                    </ul>
                  </div>
                )
              })}
            </div>
            {(hasPrev || hasNext) && (
              <nav className="tag-pagination" aria-label="Pagination">
                <button type="button" disabled={!hasPrev} onClick={() => setParams(info?.startCursor ? { before: info.startCursor } : {})}>
                  <ChevronLeftIcon /> Previous
                </button>
                <button type="button" disabled={!hasNext} onClick={() => info?.endCursor && setParams({ after: info.endCursor })}>
                  Next <ChevronRightIcon />
                </button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  )
}
