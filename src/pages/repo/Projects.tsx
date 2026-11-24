import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, CounterLabel, IconButton, Label, PageHeader, RelativeTime, TextInput } from '@primer/react'
import { TableIcon, ProjectIcon, LinkExternalIcon, SearchIcon } from '@primer/octicons-react'
import { useGitHub } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { openExternal } from '../../lib/platform'
import type { ProjectScope } from '../../lib/projects'
import { Blankslate, ErrorBox, Loading } from '../../components/Bits'
import { ProjectScreen, scopeHint } from './project/ProjectScreen'

type ProjectSort = 'updated' | 'newest' | 'oldest' | 'least-updated' | 'name'
const PROJECT_SORTS: Array<[ProjectSort, string]> = [
  ['updated', 'Recently updated'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['least-updated', 'Least recently updated'],
  ['name', 'Name'],
]

export function ProjectsPage() {
  const { owner, repo, fullName } = useRepo()
  const { octokit, key } = useGitHub()
  const [params] = useSearchParams()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ProjectSort>('updated')
  const closedTab = params.get('state') === 'closed'
  useAgentPageContext({ label: `projects linked to ${fullName}`, owner, repo })
  const projects = useQuery({
    queryKey: [key, 'projects', owner, repo],
    queryFn: async () => {
      const res: { repository: { projectsV2: { nodes: Array<{ number: number; title: string; shortDescription: string | null; url: string; updatedAt: string; createdAt: string; closed: boolean; items: { totalCount: number }; owner: { login: string } }> } } } =
        await octokit.graphql(
          `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ projectsV2(first:100, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ number title shortDescription url updatedAt createdAt closed items{totalCount} owner{ ... on User{login} ... on Organization{login} } } } } }`,
          { owner, repo },
        )
      return res.repository.projectsV2.nodes
    },
  })
  const all = projects.data ?? []
  const open = all.filter((p) => !p.closed)
  const closed = all.filter((p) => p.closed)
  const term = search.trim().toLowerCase()
  const shown = (closedTab ? closed : open)
    .filter((p) => !term || p.title.toLowerCase().includes(term))
    .sort((a, b) => {
      switch (sort) {
        case 'newest':
          return Date.parse(b.createdAt) - Date.parse(a.createdAt)
        case 'oldest':
          return Date.parse(a.createdAt) - Date.parse(b.createdAt)
        case 'least-updated':
          return Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
        case 'name':
          return a.title.localeCompare(b.title)
        default:
          return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      }
    })
  const base = `/${owner}/${repo}/projects`

  return (
    <div className="container-xl">
      <PageHeader>
        <PageHeader.TitleArea>
          <PageHeader.Title as="h1">Projects</PageHeader.Title>
        </PageHeader.TitleArea>
      </PageHeader>
      <TextInput className="projects-search" block leadingVisual={SearchIcon} aria-label="Search projects" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="projects-list">
        <h2 className="sr-only">Repository projects</h2>
        <div className="projects-list-header">
          <ul className="projects-tabs">
            <li>
              <Link to={base} className="projects-tab" aria-current={!closedTab ? 'page' : undefined}>
                Open {!projects.error && <CounterLabel>{open.length}</CounterLabel>}
              </Link>
            </li>
            <li>
              <Link to={`${base}?state=closed`} className="projects-tab" aria-current={closedTab ? 'page' : undefined}>
                Closed {!projects.error && <CounterLabel>{closed.length}</CounterLabel>}
              </Link>
            </li>
          </ul>
          <ActionMenu>
            <ActionMenu.Button variant="invisible">
              Sort<span className="sr-only">: {PROJECT_SORTS.find(([k]) => k === sort)![1]}</span>
            </ActionMenu.Button>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                {PROJECT_SORTS.map(([k, label]) => (
                  <ActionList.Item key={k} selected={k === sort} onSelect={() => setSort(k)}>
                    {label}
                  </ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </div>
        {projects.isLoading ? (
          <Loading />
        ) : projects.error ? (
          scopeHint(projects.error) ? (
            <div className="projects-empty">
              <Blankslate icon={<ProjectIcon size={32} />} title="Your token can’t read projects">
                {scopeHint(projects.error)} Add the scope to your token, or sign in again with the device flow.
              </Blankslate>
            </div>
          ) : (
            <div className="p-3">
              <ErrorBox error={projects.error} title="Could not load projects" />
            </div>
          )
        ) : !shown.length ? (
          <div className="projects-empty">
            <Blankslate icon={<TableIcon size={32} />} title="No projects found">
              {term ? 'No projects match your search.' : closedTab ? 'There are no closed projects linked to this repository.' : 'There are no projects linked to this repository.'}
            </Blankslate>
          </div>
        ) : (
          shown.map((p) => (
            <div key={p.url} className="Box-row hoverable projects-row">
              <TableIcon className="fg-muted" />
              <div className="flex-1">
                <Link to={`${base}/${p.number}`} className="list-row-title">
                  {p.title}
                </Link>
                {p.closed && <Label className="ml-2">Closed</Label>}
                <div className="Box-row-meta">
                  #{p.number} · {p.items.totalCount} items · updated <RelativeTime date={new Date(p.updatedAt)} />
                  {p.shortDescription && ` · ${p.shortDescription}`}
                </div>
              </div>
              <IconButton size="small" variant="invisible" icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(p.url)} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** A project opened from a repository's Projects tab: /:owner/:repo/projects/:number[/views/:view]. */
export function ProjectPage() {
  const { owner, repo } = useRepo()
  const scope = useMemo<ProjectScope>(() => ({ kind: 'repo', owner, repo }), [owner, repo])
  return <ProjectScreen scope={scope} />
}

/** A project under its organization or user, github.com's /orgs/:owner/projects/:number and /users/:owner/projects/:number. */
export function OwnerProjectPage({ kind }: { kind: 'org' | 'user' }) {
  const { owner = '' } = useParams()
  const scope = useMemo<ProjectScope>(() => ({ kind, owner }), [kind, owner])
  return <ProjectScreen scope={scope} />
}
