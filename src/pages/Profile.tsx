import { useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Avatar, Button, ButtonGroup, Label, RelativeTime, TextInput, UnderlineNav } from '@primer/react'
import {
  PeopleIcon,
  LocationIcon,
  LinkIcon,
  OrganizationIcon,
  StarIcon,
  RepoForkedIcon,
  MailIcon,
  BookIcon,
  RepoIcon,
  TableIcon,
  HomeIcon,
  PersonIcon,
  LawIcon,
  HeartIcon,
  CodeSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  VerifiedIcon,
} from '@primer/octicons-react'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import { useGitHub, errorMessage } from '../lib/github'
import { compactNumber, plural } from '../lib/format'
import { openExternal } from '../lib/platform'
import { webUrl } from '../lib/links'
import { useAgentPageContext } from '../lib/agent/AgentProvider'
import { Blankslate, ErrorBox, Loading, UserAvatar } from '../components/Bits'
import { Markdown } from '../components/Markdown'
import { LANG_COLORS } from './repo/Code'

// github.com/<user>?tab=… and github.com/orgs/<org>/… both map onto /<owner>?tab=… here.

interface PinRepo {
  __typename: 'Repository'
  name: string
  owner: { login: string }
  description: string | null
  isPrivate: boolean
  isArchived: boolean
  stargazerCount: number
  forkCount: number
  primaryLanguage: { name: string; color: string | null } | null
  parent: { nameWithOwner: string } | null
}
interface PinGist {
  __typename: 'Gist'
  name: string
  description: string | null
  url: string
  files: Array<{ name: string }> | null
  stargazerCount: number
  forks: { totalCount: number }
}
type PinItem = PinRepo | PinGist
interface CalendarDay {
  date: string
  contributionCount: number
  contributionLevel: 'NONE' | 'FIRST_QUARTILE' | 'SECOND_QUARTILE' | 'THIRD_QUARTILE' | 'FOURTH_QUARTILE'
  weekday: number
}
interface Calendar {
  totalContributions: number
  weeks: Array<{ contributionDays: CalendarDay[] }>
}
interface PersonNode {
  login: string
  name: string | null
  avatarUrl: string
  bio?: string | null
  company?: string | null
  location?: string | null
}

const PIN_REPO = `fragment PinRepo on Repository { name owner{login} description isPrivate isArchived stargazerCount forkCount primaryLanguage{name color} parent{nameWithOwner} }`

const SORTS = [
  ['pushed', 'Last updated'],
  ['full_name', 'Name'],
  ['stars', 'Stars'],
] as const
type Sort = (typeof SORTS)[number][0]
const REPOS_PER_PAGE = 30
const TYPES = [
  ['all', 'All'],
  ['sources', 'Sources'],
  ['forks', 'Forks'],
  ['archived', 'Archived'],
  ['mirrors', 'Mirrors'],
  ['templates', 'Templates'],
] as const

export function ProfilePage() {
  const { owner = '' } = useParams()
  const { octokit, key } = useGitHub()
  const user = useQuery({
    queryKey: [key, 'user', owner],
    queryFn: async () => (await octokit.rest.users.getByUsername({ username: owner })).data,
  })
  useAgentPageContext(user.data ? { label: `the profile of ${owner}`, details: { type: user.data.type } } : null)

  if (user.isLoading) return <Loading />
  if (user.error || !user.data)
    return (
      <div className="container-xl">
        <ErrorBox error={user.error} />
      </div>
    )
  // Keyed by login: per-tab state (pagination cursors, contribution year, filters) must not carry over to another profile.
  return user.data.type === 'Organization' ? <OrgProfile key={user.data.login} u={user.data} /> : <UserProfile key={user.data.login} u={user.data} />
}

type ProfileUser = RestEndpointMethodTypes['users']['getByUsername']['response']['data']

/** The owner's repositories; `firstPageOnly` fetches just the 100 most recent (the org overview), not every page. */
function useOwnerRepos(login: string, kind: 'self' | 'org' | 'user', sort: Sort, enabled = true, firstPageOnly = false) {
  const { octokit, key } = useGitHub()
  const apiSort = sort === 'stars' ? 'pushed' : sort
  return useQuery({
    queryKey: [key, 'user-repos', login, kind, apiSort, firstPageOnly],
    enabled,
    queryFn: async () => {
      const list = firstPageOnly
        ? kind === 'org'
          ? (await octokit.rest.repos.listForOrg({ org: login, sort: apiSort, per_page: 100 })).data
          : (await octokit.rest.repos.listForUser({ username: login, sort: apiSort, per_page: 100 })).data
        : kind === 'self'
          ? await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, { affiliation: 'owner', sort: apiSort, per_page: 100 })
          : kind === 'org'
            ? await octokit.paginate(octokit.rest.repos.listForOrg, { org: login, sort: apiSort, per_page: 100 })
            : await octokit.paginate(octokit.rest.repos.listForUser, { username: login, sort: apiSort, per_page: 100 })
      return list.map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        description: r.description ?? null,
        private: r.private,
        archived: !!r.archived,
        fork: r.fork,
        mirror: !!r.mirror_url,
        template: !!r.is_template,
        language: r.language ?? null,
        topics: r.topics ?? [],
        license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.name : null,
        stars: r.stargazers_count ?? 0,
        forks: r.forks_count ?? 0,
        pushed_at: r.pushed_at ?? null,
      }))
    },
  })
}
type OwnerRepo = NonNullable<ReturnType<typeof useOwnerRepos>['data']>[number]

/** "Forked from owner/repo" for the fork rows on screen: the REST repository lists carry no parent. */
function useForkParents(repos: OwnerRepo[]) {
  const { octokit, key } = useGitHub()
  const forks = repos.filter((r) => r.fork).map((r) => r.full_name)
  return useQuery({
    queryKey: [key, 'fork-parents', forks],
    enabled: forks.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const vars: Record<string, string> = {}
      forks.forEach((f, i) => {
        const [o, n] = f.split('/')
        vars[`o${i}`] = o
        vars[`n${i}`] = n
      })
      const res: Record<string, { parent: { nameWithOwner: string } | null } | null> = await octokit.graphql(
        `query(${forks.map((_, i) => `$o${i}:String!,$n${i}:String!`).join(',')}){ ${forks.map((_, i) => `r${i}: repository(owner:$o${i},name:$n${i}){ parent{ nameWithOwner } }`).join(' ')} }`,
        vars,
      )
      return new Map(forks.map((f, i) => [f, res[`r${i}`]?.parent?.nameWithOwner ?? null]))
    },
  })
}

/* ---------------- user profile ---------------- */

function UserProfile({ u }: { u: ProfileUser }) {
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const tab = params.get('tab') ?? 'overview'
  const login = u.login
  const isSelf = login.toLowerCase() === account.login.toLowerCase()

  const extra = useQuery({
    queryKey: [key, 'user-profile-extra', login],
    queryFn: async () => {
      const res: {
        user: {
          viewerIsFollowing: boolean
          viewerCanFollow: boolean
          hasSponsorsListing: boolean
          starredRepositories: { totalCount: number }
          projectsV2: { totalCount: number }
          organizations: { nodes: Array<{ login: string; avatarUrl: string; name: string | null }> }
          socialAccounts: { nodes: Array<{ provider: string; displayName: string; url: string }> }
          pinnedItems: { nodes: PinItem[] }
          popular: { nodes: PinRepo[] }
        }
      } = await octokit.graphql(
        `query($login:String!){ user(login:$login){
          viewerIsFollowing viewerCanFollow hasSponsorsListing
          starredRepositories{ totalCount } projectsV2{ totalCount }
          organizations(first:30){ nodes{ login avatarUrl name } }
          socialAccounts(first:10){ nodes{ provider displayName url } }
          pinnedItems(first:6, types:[REPOSITORY, GIST]){ nodes{ __typename ...PinRepo ... on Gist{ name description url files(limit:1){ name } stargazerCount forks{ totalCount } } } }
          popular: repositories(first:6, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC, orderBy:{field:STARGAZERS, direction:DESC}){ nodes{ __typename ...PinRepo } }
        } } ${PIN_REPO}`,
        { login },
      )
      return res.user
    },
  })

  const follow = useMutation({
    mutationFn: async (on: boolean) => (on ? octokit.rest.users.follow({ username: login }) : octokit.rest.users.unfollow({ username: login })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [key, 'user-profile-extra', login] })
      void qc.invalidateQueries({ queryKey: [key, 'user', login] })
    },
  })

  const x = extra.data
  const company = u.company?.trim()
  return (
    <>
      <div className="pf-tabs-row pf-page">
        <div className="container-xl pf-tabs-grid">
          <div />
          <UnderlineNav aria-label="User profile" loadingCounters={extra.isLoading}>
            <UnderlineNav.Item as={Link} to={`/${login}`} icon={BookIcon} aria-current={tab === 'overview' ? 'page' : undefined}>
              Overview
            </UnderlineNav.Item>
            <UnderlineNav.Item as={Link} to={`/${login}?tab=repositories`} icon={RepoIcon} counter={compactNumber(u.public_repos)} aria-current={tab === 'repositories' ? 'page' : undefined}>
              Repositories
            </UnderlineNav.Item>
            <UnderlineNav.Item as={Link} to={`/${login}?tab=projects`} icon={TableIcon} counter={x?.projectsV2.totalCount ? compactNumber(x.projectsV2.totalCount) : undefined} aria-current={tab === 'projects' ? 'page' : undefined}>
              Projects
            </UnderlineNav.Item>
            <UnderlineNav.Item as={Link} to={`/${login}?tab=stars`} icon={StarIcon} counter={x ? compactNumber(x.starredRepositories.totalCount) : undefined} aria-current={tab === 'stars' ? 'page' : undefined}>
              Stars
            </UnderlineNav.Item>
          </UnderlineNav>
        </div>
      </div>
      <div className="container-xl pf-page">
        <div className="layout-sidebar-left">
          <aside className="pf-vcard">
            <Avatar src={u.avatar_url} size={256} className="pf-avatar" alt={`@${login}`} />
            <h1 className="pf-names">
              {u.name && <span className="pf-fullname">{u.name}</span>}
              <span className="pf-username">{login}</span>
            </h1>
            <div className="pf-actions">
              {isSelf ? (
                <Button block onClick={() => openExternal(webUrl(account.host, '/settings/profile'))}>
                  Edit profile
                </Button>
              ) : (
                (x?.viewerCanFollow ?? true) && (
                  <Button block loading={follow.isPending} disabled={!x} onClick={() => follow.mutate(!x?.viewerIsFollowing)}>
                    {x?.viewerIsFollowing ? 'Unfollow' : 'Follow'}
                  </Button>
                )
              )}
              {x?.hasSponsorsListing && (
                <Button block leadingVisual={HeartIcon} onClick={() => openExternal(webUrl(account.host, `/sponsors/${login}`))} aria-label={`Sponsor @${login}`}>
                  Sponsor
                </Button>
              )}
            </div>
            {u.bio && <div className="pf-bio">{u.bio}</div>}
            <div className="pf-counts">
              <Link to={`/${login}?tab=followers`}>
                <PeopleIcon /> <strong>{compactNumber(u.followers)}</strong> {u.followers === 1 ? 'follower' : 'followers'}
              </Link>
              {' · '}
              <Link to={`/${login}?tab=following`}>
                <strong>{compactNumber(u.following)}</strong> following
              </Link>
            </div>
            <ul className="pf-details">
              {company && (
                <li aria-label={`Organization: ${company}`}>
                  <OrganizationIcon />
                  <span>
                    {company.split(/(@[\w-]+)/).map((part, i) =>
                      /^@[\w-]+$/.test(part) ? (
                        <Link key={i} to={`/${part.slice(1)}`} className="text-bold">
                          {part}
                        </Link>
                      ) : (
                        part
                      ),
                    )}
                  </span>
                </li>
              )}
              {u.location && (
                <li aria-label={`Home location: ${u.location}`}>
                  <LocationIcon /> <span>{u.location}</span>
                </li>
              )}
              {u.email && (
                <li aria-label={`Email: ${u.email}`}>
                  <MailIcon /> <ExternalLink href={`mailto:${u.email}`}>{u.email}</ExternalLink>
                </li>
              )}
              {u.blog && (
                <li>
                  <LinkIcon /> <ExternalLink href={/^https?:/.test(u.blog) ? u.blog : `https://${u.blog}`}>{u.blog}</ExternalLink>
                </li>
              )}
              {x?.socialAccounts.nodes.map((s) => (
                <li key={s.url}>
                  <LinkIcon /> <ExternalLink href={s.url}>{s.displayName}</ExternalLink>
                </li>
              ))}
            </ul>
            {!!x?.organizations.nodes.length && (
              <div className="pf-side-section">
                <h2>Organizations</h2>
                <div className="pf-avatar-grid">
                  {x.organizations.nodes.map((o) => (
                    <Link key={o.login} to={`/${o.login}`} aria-label={o.login} title={o.name ?? o.login}>
                      <UserAvatar login={o.login} src={o.avatarUrl} size={32} square />
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </aside>
          <div style={{ minWidth: 0 }}>
            {tab === 'repositories' ? (
              <RepoTab login={login} kind={isSelf ? 'self' : 'user'} />
            ) : tab === 'stars' ? (
              <StarsTab login={login} />
            ) : tab === 'projects' ? (
              <ProjectsTab login={login} kind="user" count={x?.projectsV2.totalCount} />
            ) : tab === 'followers' || tab === 'following' ? (
              <PeopleTab key={tab} login={login} kind={tab} />
            ) : (
              <>
                <ProfileReadme login={login} repo={login} path={null} />
                {extra.error ? (
                  <ErrorBox error={extra.error} />
                ) : (
                  x && <PinnedGrid title={x.pinnedItems.nodes.length ? 'Pinned' : 'Popular repositories'} items={x.pinnedItems.nodes.length ? x.pinnedItems.nodes : x.popular.nodes} login={login} labelRight={!x.pinnedItems.nodes.length} />
                )}
                <Contributions login={login} />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** `<login>/<login>` README for users, `.github/profile/README.md` for organizations. */
function ProfileReadme({ login, repo, path }: { login: string; repo: string; path: string | null }) {
  const { octokit, key, account } = useGitHub()
  const readme = useQuery({
    queryKey: [key, 'profile-readme-file', login, repo, path],
    retry: false,
    queryFn: async () => {
      try {
        // One HTML request only: browsers may hand back a cached HTML body for a JSON request to the
        // same URL. The rendered README names its file (data-path), which github.com shows in the header.
        const res = path
          ? await octokit.rest.repos.getContent({ owner: login, repo, path, mediaType: { format: 'html' } })
          : await octokit.rest.repos.getReadme({ owner: login, repo, mediaType: { format: 'html' } })
        const html = res.data as unknown
        if (typeof html !== 'string') return null
        const file = path ?? html.match(/data-path="([^"]+)"/)?.[1] ?? 'README.md'
        // Relative image paths are relative to the README in its repository, not to this page.
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
        const raw = (src: string) => webUrl(account.host, `/${login}/${repo}/raw/HEAD/${src.startsWith('/') ? src.slice(1) : dir + src}`)
        return { html: html.replace(/(<img\b[^>]*?\ssrc=")(?![a-z][a-z0-9+.-]*:|\/\/|#)([^"]+)"/gi, (_, pre: string, src: string) => `${pre}${raw(src)}"`), file }
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null
        throw e
      }
    },
  })
  if (!readme.data) return null
  const name = readme.data.file.split('/').pop() ?? readme.data.file
  const dot = name.lastIndexOf('.')
  return (
    <div className="Box pf-readme">
      <div className="Box-body">
        <div className="pf-readme-title">
          {path ? (
            <Link to={`/${login}/${repo}/blob/HEAD/${path}`}>{name}</Link>
          ) : (
            <>
              <Link to={`/${login}/${repo}`}>{login}</Link>
              <span className="fg-muted" style={{ padding: '0 2px' }}>
                /
              </span>
              {dot > 0 ? name.slice(0, dot) : name}
              {dot > 0 && <span className="fg-muted">{name.slice(dot)}</span>}
            </>
          )}
        </div>
        <Markdown html={readme.data.html} context={`${login}/${repo}`} />
      </div>
    </div>
  )
}

function PinnedGrid({ title, items, login, labelRight }: { title: string; items: PinItem[]; login: string; labelRight?: boolean }) {
  if (!items.length) return null
  return (
    <div className="pf-pinned">
      <h2 className="pf-h2">{title}</h2>
      <ol className="pf-pinned-grid">
        {items.map((p) =>
          p.__typename === 'Gist' ? (
            <li key={p.url} className="Box pf-pin">
              <div className="pf-pin-head">
                <CodeSquareIcon className="fg-muted" />
                <ExternalLink href={p.url}>
                  <span className="text-bold">{p.files?.[0]?.name ?? p.name}</span>
                </ExternalLink>
              </div>
              <p className="pf-pin-desc">{p.description}</p>
              <p className="pf-pin-meta">
                {!!p.stargazerCount && (
                  <span>
                    <StarIcon /> {compactNumber(p.stargazerCount)}
                  </span>
                )}
                {!!p.forks.totalCount && (
                  <span>
                    <RepoForkedIcon /> {compactNumber(p.forks.totalCount)}
                  </span>
                )}
              </p>
            </li>
          ) : (
            <li key={`${p.owner.login}/${p.name}`} className={labelRight ? 'Box pf-pin popular' : 'Box pf-pin'}>
              <div className="pf-pin-head">
                {!labelRight && <RepoIcon className="fg-muted" />}
                <Link to={`/${p.owner.login}/${p.name}`} className="text-bold pf-pin-name">
                  {p.owner.login.toLowerCase() === login.toLowerCase() ? p.name : `${p.owner.login}/${p.name}`}
                </Link>
                <Label variant={p.isArchived ? 'attention' : 'secondary'} className={labelRight ? 'ml-auto' : undefined}>
                  {visibilityLabel(p.isPrivate, p.isArchived)}
                </Label>
              </div>
              {p.parent && (
                <div className="pf-pin-fork">
                  Forked from{' '}
                  <Link to={`/${p.parent.nameWithOwner}`} className="fg-muted">
                    {p.parent.nameWithOwner}
                  </Link>
                </div>
              )}
              <p className="pf-pin-desc">{p.description}</p>
              <p className="pf-pin-meta">
                {p.primaryLanguage && (
                  <span>
                    <span className="pf-lang-color" style={{ background: p.primaryLanguage.color ?? LANG_COLORS[p.primaryLanguage.name] ?? 'var(--fgColor-muted)' }} />
                    {p.primaryLanguage.name}
                  </span>
                )}
                {!!p.stargazerCount && (
                  <span>
                    <StarIcon /> {compactNumber(p.stargazerCount)}
                  </span>
                )}
                {!!p.forkCount && (
                  <span>
                    <RepoForkedIcon /> {compactNumber(p.forkCount)}
                  </span>
                )}
              </p>
            </li>
          ),
        )}
      </ol>
    </div>
  )
}

function visibilityLabel(isPrivate: boolean, archived: boolean) {
  return `${isPrivate ? 'Private' : 'Public'}${archived ? ' archive' : ''}`
}

const LEVELS: Record<CalendarDay['contributionLevel'], number> = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 }
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

function dayTitle(d: CalendarDay) {
  const [, m, day] = d.date.split('-').map(Number)
  const what = d.contributionCount === 0 ? 'No contributions' : plural(d.contributionCount, 'contribution')
  return `${what} on ${MONTHS_LONG[m - 1]} ${ordinal(day)}.`
}

function Contributions({ login }: { login: string }) {
  const { octokit, key } = useGitHub()
  const [year, setYear] = useState<number | null>(null)
  const cal = useQuery({
    queryKey: [key, 'contributions', login, year],
    queryFn: async () => {
      const range = year ? { from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` } : {}
      const res: { user: { contributionsCollection: { contributionYears: number[]; contributionCalendar: Calendar } } } = await octokit.graphql(
        `query($login:String!,$from:DateTime,$to:DateTime){ user(login:$login){ contributionsCollection(from:$from,to:$to){ contributionYears contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount contributionLevel weekday } } } } } }`,
        { login, ...range },
      )
      return res.user.contributionsCollection
    },
  })
  if (cal.isLoading) return <Loading />
  if (cal.error) return <ErrorBox error={cal.error} />
  const { contributionCalendar: c, contributionYears: years } = cal.data!
  // A week belongs to the month of its last day, which is how github.com spans its month labels.
  const months: Array<{ label: string; span: number }> = []
  for (const w of c.weeks) {
    const last = w.contributionDays[w.contributionDays.length - 1]
    const m = Number(last.date.slice(5, 7)) - 1
    const prev = months[months.length - 1]
    if (prev && prev.label === MONTHS[m]) prev.span++
    else months.push({ label: MONTHS[m], span: 1 })
  }
  return (
    <div className="pf-contrib">
      <div className="pf-contrib-main">
        <h2 className="pf-h2">
          {c.totalContributions.toLocaleString('en-US')} {c.totalContributions === 1 ? 'contribution' : 'contributions'} {year ? `in ${year}` : 'in the last year'}
        </h2>
        <div className="pf-calendar-box">
          <div className="pf-calendar-scroll">
            <table className="pf-calendar" role="grid" aria-readonly="true">
              <caption className="sr-only">Contribution Graph</caption>
              <thead>
                <tr style={{ height: 13 }}>
                  <td style={{ width: 28 }}>
                    <span className="sr-only">Day of Week</span>
                  </td>
                  {months.map((m, i) => (
                    <td key={i} colSpan={m.span} className="pf-calendar-label" style={{ position: 'relative' }}>
                      {m.span > 1 && <span style={{ position: 'absolute', top: 0 }}>{m.label}</span>}
                    </td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAY_NAMES.map((name, wd) => (
                  <tr key={name} style={{ height: 10 }}>
                    <td className="pf-calendar-label" style={{ position: 'relative' }}>
                      {wd % 2 === 1 && <span style={{ position: 'absolute', bottom: -3 }}>{name}</span>}
                    </td>
                    {c.weeks.map((w, i) => {
                      const d = w.contributionDays.find((x) => x.weekday === wd)
                      return d ? <td key={i} className="pf-day" data-level={LEVELS[d.contributionLevel]} title={dayTitle(d)} aria-label={dayTitle(d)} /> : <td key={i} />
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pf-calendar-footer">
            <ExternalLink href="https://docs.github.com/articles/why-are-my-contributions-not-showing-up-on-my-profile">Learn how we count contributions</ExternalLink>
            <span className="pf-legend">
              Less
              {[0, 1, 2, 3, 4].map((l) => (
                <span key={l} className="pf-day" data-level={l} />
              ))}
              More
            </span>
          </div>
        </div>
      </div>
      {years.length > 1 && (
        <ul className="pf-years" aria-label="Contribution years">
          {years.map((y) => (
            <li key={y}>
              <button type="button" className={(year ?? years[0]) === y ? 'selected' : undefined} onClick={() => setYear(y)}>
                {y}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------- repositories / stars / projects / people tabs ---------------- */

function RepoTab({ login, kind }: { login: string; kind: 'self' | 'org' | 'user' }) {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState(params.get('q') ?? '')
  const type = params.get('type') ?? 'all'
  const language = params.get('language') ?? ''
  const sort = (SORTS.some(([v]) => v === params.get('sort')) ? params.get('sort') : 'pushed') as Sort
  const repos = useOwnerRepos(login, kind, sort)
  const page = Math.max(1, Number(params.get('page')) || 1)
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    if (k !== 'page') next.delete('page')
    setParams(next, { replace: k !== 'page' })
  }

  const all = repos.data ?? []
  const languages = [...new Set(all.map((r) => r.language).filter((l): l is string => !!l))].sort((a, b) => a.localeCompare(b))
  const shown = all
    .filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((r) => (type === 'sources' ? !r.fork : type === 'forks' ? r.fork : type === 'archived' ? r.archived : type === 'mirrors' ? r.mirror : type === 'templates' ? r.template : true))
    .filter((r) => !language || r.language?.toLowerCase() === language.toLowerCase())
  if (sort === 'stars') shown.sort((a, b) => b.stars - a.stars)
  // github.com lists 30 repositories per page.
  const pageItems = shown.slice((page - 1) * REPOS_PER_PAGE, page * REPOS_PER_PAGE)
  const parents = useForkParents(pageItems)

  return (
    <div>
      <div className="pf-repo-filters">
        <TextInput
          className="flex-1"
          placeholder="Find a repository…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            if (page > 1) setParam('page', null)
          }}
          aria-label="Find a repository…"
        />
        <div className="flex gap-2">
          <ActionMenu>
            <ActionMenu.Button>Type</ActionMenu.Button>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                <ActionList.Group>
                  <ActionList.GroupHeading>Select type</ActionList.GroupHeading>
                  {TYPES.map(([v, label]) => (
                    <ActionList.Item key={v} selected={type === v} onSelect={() => setParam('type', v === 'all' ? null : v)}>
                      {label}
                    </ActionList.Item>
                  ))}
                </ActionList.Group>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          <ActionMenu>
            <ActionMenu.Button>Language</ActionMenu.Button>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                <ActionList.Group>
                  <ActionList.GroupHeading>Select language</ActionList.GroupHeading>
                  <ActionList.Item selected={!language} onSelect={() => setParam('language', null)}>
                    All
                  </ActionList.Item>
                  {languages.map((l) => (
                    <ActionList.Item key={l} selected={language.toLowerCase() === l.toLowerCase()} onSelect={() => setParam('language', l.toLowerCase())}>
                      {l}
                    </ActionList.Item>
                  ))}
                </ActionList.Group>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          <ActionMenu>
            <ActionMenu.Button>Sort</ActionMenu.Button>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                <ActionList.Group>
                  <ActionList.GroupHeading>Select order</ActionList.GroupHeading>
                  {SORTS.map(([v, label]) => (
                    <ActionList.Item key={v} selected={sort === v} onSelect={() => setParam('sort', v === 'pushed' ? null : v)}>
                      {label}
                    </ActionList.Item>
                  ))}
                </ActionList.Group>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </div>
      </div>
      {repos.isLoading ? (
        <Loading />
      ) : repos.error ? (
        <ErrorBox error={repos.error} />
      ) : shown.length === 0 ? (
        <Blankslate title={all.length ? `${login} doesn’t have any repositories that match.` : `${login} doesn’t have any public repositories yet.`} />
      ) : (
        <>
          <ul className="pf-repo-list">
            {pageItems.map((r) => (
              <RepoListItem key={r.id} r={r} parent={parents.data?.get(r.full_name)} />
            ))}
          </ul>
          <Pager page={page} hasNext={page * REPOS_PER_PAGE < shown.length} onPage={(p) => setParam('page', p > 1 ? String(p) : null)} />
        </>
      )}
    </div>
  )
}

function RepoListItem({ r, fullName, parent }: { r: OwnerRepo; fullName?: boolean; parent?: string | null }) {
  return (
    <li className="pf-repo-row">
      <div className="pf-repo-title">
        <h3>
          <Link to={`/${r.full_name}`}>{fullName ? r.full_name : r.name}</Link>
        </h3>
        <Label variant={r.archived ? 'attention' : 'secondary'}>{visibilityLabel(r.private, r.archived)}</Label>
      </div>
      {r.fork && (
        <div className="pf-pin-fork">
          {parent ? (
            <>
              Forked from <Link to={`/${parent}`}>{parent}</Link>
            </>
          ) : (
            'Forked'
          )}
        </div>
      )}
      {r.description && <p className="pf-repo-desc">{r.description}</p>}
      {!!r.topics.length && (
        <div className="pf-topics">
          {r.topics.map((t) => (
            <Link key={t} to={`/search?q=${encodeURIComponent(`topic:${t}`)}&type=repositories`} className="pf-topic">
              {t}
            </Link>
          ))}
        </div>
      )}
      <div className="pf-repo-meta">
        {r.language && (
          <span>
            <span className="pf-lang-color" style={{ background: LANG_COLORS[r.language] ?? 'var(--fgColor-muted)' }} />
            {r.language}
          </span>
        )}
        {!!r.stars && (
          <span>
            <StarIcon /> {r.stars.toLocaleString('en-US')}
          </span>
        )}
        {!!r.forks && (
          <span>
            <RepoForkedIcon /> {r.forks.toLocaleString('en-US')}
          </span>
        )}
        {r.license && (
          <span>
            <LawIcon /> {r.license}
          </span>
        )}
        {r.pushed_at && (
          <span>
            Updated <RelativeTime date={new Date(r.pushed_at)} />
          </span>
        )}
      </div>
    </li>
  )
}

function Pager({ page, hasNext, onPage }: { page: number; hasNext: boolean; onPage: (p: number) => void }) {
  if (page <= 1 && !hasNext) return null
  return (
    <div className="flex-center mt-3" style={{ justifyContent: 'center' }}>
      <ButtonGroup>
        <Button leadingVisual={ChevronLeftIcon} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button trailingVisual={ChevronRightIcon} disabled={!hasNext} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </ButtonGroup>
    </div>
  )
}

function StarsTab({ login }: { login: string }) {
  const { octokit, key } = useGitHub()
  const [page, setPage] = useState(1)
  const stars = useQuery({
    queryKey: [key, 'user-stars', login, page],
    queryFn: async () => (await octokit.rest.activity.listReposStarredByUser({ username: login, per_page: 30, page })).data,
  })
  const list = (stars.data ?? []).map((s) => ('repo' in s ? s.repo : s))
  return (
    <div>
      <h2 className="pf-h2 pf-tab-heading">Stars</h2>
      {stars.isLoading ? (
        <Loading />
      ) : stars.error ? (
        <ErrorBox error={stars.error} />
      ) : list.length === 0 ? (
        <Blankslate icon={<StarIcon size={24} />} title={`${login} doesn’t have any starred repositories yet.`} />
      ) : (
        <ul className="pf-repo-list">
          {list.map((r) => (
            <RepoListItem
              key={r.id}
              fullName
              r={{
                id: r.id,
                name: r.name,
                full_name: r.full_name,
                description: r.description ?? null,
                private: r.private,
                archived: !!r.archived,
                fork: r.fork,
                mirror: !!r.mirror_url,
                template: !!r.is_template,
                language: r.language ?? null,
                topics: r.topics ?? [],
                license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.name : null,
                stars: r.stargazers_count ?? 0,
                forks: r.forks_count ?? 0,
                pushed_at: r.pushed_at ?? null,
              }}
            />
          ))}
        </ul>
      )}
      <Pager page={page} hasNext={list.length === 30} onPage={setPage} />
    </div>
  )
}

function ProjectsTab({ login, kind, count }: { login: string; kind: 'user' | 'organization'; count?: number }) {
  const { octokit, key } = useGitHub()
  const projects = useQuery({
    queryKey: [key, 'owner-projects', kind, login],
    // The count needs no scope, the list needs read:project: skip the request when there is nothing to list.
    enabled: count !== 0,
    queryFn: async () => {
      const res: Record<string, { projectsV2: { nodes: Array<{ number: number; title: string; shortDescription: string | null; url: string; closed: boolean; updatedAt: string }> } }> = await octokit.graphql(
        `query($login:String!){ ${kind}(login:$login){ projectsV2(first:50, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ number title shortDescription url closed updatedAt } } } }`,
        { login },
      )
      return res[kind].projectsV2.nodes
    },
  })
  if (projects.isLoading) return <Loading />
  if (projects.error) {
    return /scope|read:project|INSUFFICIENT/i.test(errorMessage(projects.error)) ? (
      <Blankslate icon={<TableIcon size={24} />} title="Projects need the read:project scope">
        Add the read:project scope (classic token) or Projects read access (fine-grained) to list {login}’s projects.
      </Blankslate>
    ) : (
      <ErrorBox error={projects.error} />
    )
  }
  const list = projects.data ?? []
  return (
    <div className="Box">
      <div className="Box-header compact text-bold">Projects</div>
      {list.length === 0 ? (
        <Blankslate icon={<TableIcon size={24} />} title="There aren't any projects yet" />
      ) : (
        list.map((p) => (
          <div key={p.number} className="Box-row hoverable">
            <TableIcon className="fg-muted" />
            <div className="flex-1" style={{ minWidth: 0 }}>
              <ExternalLink href={p.url}>
                <span className="Box-row-link">{p.title}</span>
              </ExternalLink>{' '}
              {p.closed && <Label variant="done">Closed</Label>}
              <div className="Box-row-meta">
                #{p.number} updated <RelativeTime date={new Date(p.updatedAt)} />
                {p.shortDescription && <> · {p.shortDescription}</>}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function PeopleTab({ login, kind }: { login: string; kind: 'followers' | 'following' | 'members' }) {
  const { octokit, key } = useGitHub()
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const after = cursors[cursors.length - 1]
  const people = useQuery({
    queryKey: [key, 'profile-people', login, kind, after],
    queryFn: async () => {
      const fields = 'pageInfo{ hasNextPage endCursor } nodes{ login name avatarUrl bio company location }'
      if (kind === 'members') {
        const res: { organization: { membersWithRole: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PersonNode[] } } } = await octokit.graphql(
          `query($login:String!,$after:String){ organization(login:$login){ membersWithRole(first:50, after:$after){ ${fields} } } }`,
          { login, after },
        )
        return res.organization.membersWithRole
      }
      const res: { user: Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PersonNode[] }> } = await octokit.graphql(
        `query($login:String!,$after:String){ user(login:$login){ ${kind}(first:50, after:$after){ ${fields} } } }`,
        { login, after },
      )
      return res.user[kind]
    },
  })
  if (people.isLoading) return <Loading />
  if (people.error) return <ErrorBox error={people.error} />
  const d = people.data!
  return (
    <div>
      {kind === 'members' && <h2 className="pf-h2 pf-tab-heading">People</h2>}
      {d.nodes.length === 0 ? (
        <Blankslate
          icon={<PeopleIcon size={24} />}
          title={kind === 'members' ? 'This organization has no public members.' : kind === 'followers' ? `${login} doesn’t have any followers yet.` : `${login} isn’t following anybody.`}
        />
      ) : (
        <ul className={kind === 'members' ? 'Box pf-people pf-people-box' : 'pf-people'}>
          {d.nodes.map((p) => (
            <li key={p.login} className="pf-person">
              <Link to={`/${p.login}`}>
                <UserAvatar login={p.login} src={p.avatarUrl} size={kind === 'members' ? 48 : 50} />
              </Link>
              <div style={{ minWidth: 0 }}>
                <Link to={`/${p.login}`} className="pf-person-names">
                  {p.name && <span className="pf-person-name">{p.name}</span>}
                  <span className="pf-person-login">{p.login}</span>
                </Link>
                {p.bio && <div className="pf-person-bio">{p.bio}</div>}
                {(p.company || p.location) && (
                  <p className="pf-person-meta">
                    {p.company && (
                      <span>
                        <OrganizationIcon /> {p.company}
                      </span>
                    )}
                    {p.location && (
                      <span>
                        <LocationIcon /> {p.location}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {(cursors.length > 1 || d.pageInfo.hasNextPage) && (
        <Pager page={cursors.length} hasNext={d.pageInfo.hasNextPage} onPage={(p) => setCursors((c) => (p > c.length ? [...c, d.pageInfo.endCursor] : c.slice(0, -1)))} />
      )}
    </div>
  )
}

/* ---------------- organization profile ---------------- */

function OrgProfile({ u }: { u: ProfileUser }) {
  const { octokit, key } = useGitHub()
  const [params] = useSearchParams()
  const tab = params.get('tab') ?? 'overview'
  const login = u.login

  const extra = useQuery({
    queryKey: [key, 'org-profile-extra', login],
    queryFn: async () => {
      const res: {
        organization: {
          description: string | null
          websiteUrl: string | null
          location: string | null
          email: string | null
          twitterUsername: string | null
          isVerified: boolean
          projectsV2: { totalCount: number }
          repositories: { totalCount: number }
          people: { totalCount: number; nodes: Array<{ login: string; avatarUrl: string }> }
          pinnedItems: { nodes: PinRepo[] }
          popular: { nodes: PinRepo[] }
        }
      } = await octokit.graphql(
        `query($login:String!){ organization(login:$login){
          description websiteUrl location email twitterUsername isVerified
          projectsV2{ totalCount } repositories{ totalCount }
          people: membersWithRole(first:24){ totalCount nodes{ login avatarUrl } }
          pinnedItems(first:6, types:[REPOSITORY]){ nodes{ __typename ...PinRepo } }
          popular: repositories(first:6, privacy:PUBLIC, orderBy:{field:STARGAZERS, direction:DESC}){ nodes{ __typename ...PinRepo } }
        } } ${PIN_REPO}`,
        { login },
      )
      return res.organization
    },
  })
  // One page of the most recently pushed repositories: enough for the 10 listed and the language / topic ranking.
  const repos = useOwnerRepos(login, 'org', 'pushed', tab === 'overview', true)
  const forkParents = useForkParents((repos.data ?? []).slice(0, 10))
  const x = extra.data
  const website = x?.websiteUrl ?? (u.blog || null)

  // github.com ranks an organization's languages and topics by how many repositories use them,
  // breaking ties by those repositories' stars.
  const rank = (pick: (r: OwnerRepo) => string[]) => {
    const score = new Map<string, { repos: number; stars: number }>()
    for (const r of repos.data ?? [])
      for (const v of pick(r)) {
        const s = score.get(v) ?? { repos: 0, stars: 0 }
        score.set(v, { repos: s.repos + 1, stars: s.stars + r.stars })
      }
    return [...score.entries()]
      .sort((a, b) => b[1].repos - a[1].repos || b[1].stars - a[1].stars)
      .slice(0, 5)
      .map(([v]) => v)
  }
  const topLanguages = rank((r) => (r.language ? [r.language] : []))
  const topTopics = rank((r) => r.topics)

  return (
    <>
      <header className="pf-orghead pf-page">
        <div className="container-xl pf-orghead-inner">
          <div className="pf-orghead-top">
            <Avatar src={u.avatar_url} size={100} square alt={`@${login}`} />
            <div className="pf-orghead-text">
              <h1>{u.name ?? login}</h1>
              {x?.description && <div className="fg-muted">{x.description}</div>}
              {x?.isVerified && (
                <div>
                  <Label variant="success">
                    <VerifiedIcon size={12} /> Verified
                  </Label>
                </div>
              )}
              <ul className="pf-org-meta">
                <li>
                  <PeopleIcon className="fg-muted" /> <strong>{compactNumber(u.followers)}</strong> {u.followers === 1 ? 'follower' : 'followers'}
                </li>
                {(x?.location ?? u.location) && (
                  <li>
                    <LocationIcon className="fg-muted" /> {x?.location ?? u.location}
                  </li>
                )}
                {website && (
                  <li>
                    <LinkIcon className="fg-muted" /> <ExternalLink href={/^https?:/.test(website) ? website : `https://${website}`}>{website}</ExternalLink>
                  </li>
                )}
                {x?.twitterUsername && (
                  <li>
                    <LinkIcon className="fg-muted" /> <ExternalLink href={`https://twitter.com/${x.twitterUsername}`}>@{x.twitterUsername}</ExternalLink>
                  </li>
                )}
                {(x?.email ?? u.email) && (
                  <li>
                    <MailIcon className="fg-muted" /> <ExternalLink href={`mailto:${x?.email ?? u.email}`}>{x?.email ?? u.email}</ExternalLink>
                  </li>
                )}
              </ul>
            </div>
          </div>
          <UnderlineNav aria-label="Organization" loadingCounters={extra.isLoading}>
            <UnderlineNav.Item as={Link} to={`/${login}`} icon={HomeIcon} aria-current={tab === 'overview' ? 'page' : undefined}>
              Overview
            </UnderlineNav.Item>
            <UnderlineNav.Item as={Link} to={`/${login}?tab=repositories`} icon={RepoIcon} counter={compactNumber(x?.repositories.totalCount ?? u.public_repos)} aria-current={tab === 'repositories' ? 'page' : undefined}>
              Repositories
            </UnderlineNav.Item>
            <UnderlineNav.Item as={Link} to={`/${login}?tab=projects`} icon={TableIcon} counter={x?.projectsV2.totalCount ? compactNumber(x.projectsV2.totalCount) : undefined} aria-current={tab === 'projects' ? 'page' : undefined}>
              Projects
            </UnderlineNav.Item>
            <UnderlineNav.Item as={Link} to={`/${login}?tab=people`} icon={PersonIcon} counter={x?.people.totalCount ? compactNumber(x.people.totalCount) : undefined} aria-current={tab === 'people' ? 'page' : undefined}>
              People
            </UnderlineNav.Item>
          </UnderlineNav>
        </div>
      </header>
      <div className="container-xl pf-page">
        {tab === 'repositories' ? (
          <RepoTab login={login} kind="org" />
        ) : tab === 'projects' ? (
          <ProjectsTab login={login} kind="organization" count={x?.projectsV2.totalCount} />
        ) : tab === 'people' ? (
          <PeopleTab login={login} kind="members" />
        ) : (
          <div className="layout-sidebar">
            <div style={{ minWidth: 0 }}>
              <ProfileReadme login={login} repo=".github" path="profile/README.md" />
              {extra.error ? (
                <ErrorBox error={extra.error} />
              ) : (
                x && <PinnedGrid title={x.pinnedItems.nodes.length ? 'Pinned' : 'Popular repositories'} items={x.pinnedItems.nodes.length ? x.pinnedItems.nodes : x.popular.nodes} login={login} labelRight={!x.pinnedItems.nodes.length} />
              )}
              <div className="pf-org-repos">
                <h3 className="pf-h2">
                  <RepoIcon className="fg-muted" /> Repositories
                </h3>
                {repos.isLoading ? (
                  <Loading />
                ) : repos.error ? (
                  <ErrorBox error={repos.error} />
                ) : !repos.data?.length ? (
                  <Blankslate title="This organization has no public repositories." />
                ) : (
                  <div className="Box">
                    <ul className="pf-repo-list pf-repo-list-boxed">
                      {repos.data.slice(0, 10).map((r) => (
                        <RepoListItem key={r.id} r={r} parent={forkParents.data?.get(r.full_name)} />
                      ))}
                    </ul>
                    {repos.data.length > 10 && (
                      <div className="Box-footer text-center">
                        <Link to={`/${login}?tab=repositories`} className="text-bold">
                          View all repositories
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <aside className="pf-org-side">
              <div className="pf-org-side-section">
                <Link to={`/${login}?tab=people`} className="pf-org-side-heading">
                  People
                </Link>
                {x && x.people.nodes.length === 0 ? (
                  <p className="fg-muted">This organization has no public members. You must be a member to see who’s a part of this organization.</p>
                ) : (
                  <div className="pf-avatar-grid mt-2">
                    {x?.people.nodes.map((p) => (
                      <Link key={p.login} to={`/${p.login}`} aria-label={p.login} title={p.login}>
                        <UserAvatar login={p.login} src={p.avatarUrl} size={32} />
                      </Link>
                    ))}
                  </div>
                )}
                {x && x.people.totalCount > x.people.nodes.length && (
                  <Link to={`/${login}?tab=people`} className="text-small mt-2" style={{ display: 'inline-block' }}>
                    View all
                  </Link>
                )}
              </div>
              {!!topLanguages.length && (
                <div className="pf-org-side-section">
                  <h4 className="pf-org-side-heading">Top languages</h4>
                  <div className="pf-org-langs">
                    {topLanguages.map((l) => (
                      <Link key={l} to={`/${login}?tab=repositories&language=${encodeURIComponent(l.toLowerCase())}`}>
                        <span className="pf-lang-color" style={{ background: LANG_COLORS[l] ?? 'var(--fgColor-muted)' }} />
                        {l}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {!!topTopics.length && (
                <div className="pf-org-side-section">
                  <h4 className="pf-org-side-heading">Most used topics</h4>
                  <div className="pf-topics">
                    {topTopics.map((t) => (
                      <Link key={t} to={`/search?q=${encodeURIComponent(`topic:${t} org:${login}`)}&type=repositories`} className="pf-topic">
                        {t}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </>
  )
}
