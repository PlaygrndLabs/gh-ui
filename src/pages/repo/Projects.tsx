import { useCallback, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Banner, CounterLabel, IconButton, Label, PageHeader, RelativeTime, SegmentedControl, TextInput } from '@primer/react'
import { TableIcon, ProjectIcon, LinkExternalIcon, SearchIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { isNative, openExternal } from '../../lib/platform'
import { fetchProject, isScopeError, statusFieldOf, type ProjectModel } from '../../lib/projects'
import { Blankslate, ErrorBox, Loading } from '../../components/Bits'
import { Board } from './project/Board'
import { Table } from './project/Table'
import type { ProjectEditor } from './project/shared'

function scopeHint(err: unknown) {
  const msg = String((err as Error)?.message ?? '')
  return isScopeError(err) || /scope|read:project|INSUFFICIENT/i.test(msg) ? 'Projects need the read:project scope (classic token) or Projects read access (fine-grained).' : null
}

const WRITE_SCOPE_HINT = 'Editing projects needs the project scope (classic token) or Projects read and write access (fine-grained). Your changes were not saved.'

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

export function ProjectPage() {
  const { owner, repo, fullName } = useRepo()
  const { number: n = '' } = useParams()
  const number = Number(n)
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const [view, setView] = useState<'board' | 'table'>('board')
  const [editError, setEditError] = useState<unknown>(null)
  const [scopeRefused, setScopeRefused] = useState(false)
  const queryKey = useMemo(() => [key, 'project', owner, repo, number], [key, owner, repo, number])

  const project = useQuery({ queryKey, queryFn: () => fetchProject(octokit, owner, repo, number) })

  // Item edits: optimistic on the cached project, rolled back on failure. The project is refetched once
  // the last of several overlapping edits settles, so a slow response cannot undo a newer optimistic change.
  const editKey = useMemo(() => [...queryKey, 'edit'], [queryKey])
  const edit = useMutation({
    mutationKey: editKey,
    mutationFn: ({ action }: { action: () => Promise<unknown>; optimistic?: (m: ProjectModel) => ProjectModel }) => action(),
    onMutate: async ({ optimistic }) => {
      setEditError(null)
      await qc.cancelQueries({ queryKey })
      const previous = qc.getQueryData<ProjectModel | null>(queryKey)
      if (previous && optimistic) qc.setQueryData(queryKey, optimistic(previous))
      return { previous }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous)
      if (isScopeError(err)) setScopeRefused(true)
      else setEditError(err)
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: editKey }) <= 1) void qc.invalidateQueries({ queryKey })
    },
  })
  const { mutateAsync } = edit
  const run = useCallback<ProjectEditor['run']>(
    (action, optimistic) =>
      mutateAsync({ action, optimistic }).then(
        () => true,
        () => false,
      ),
    [mutateAsync],
  )

  const model = project.data ?? null
  const editor = useMemo<ProjectEditor | null>(
    () => (model ? { model, statusField: statusFieldOf(model), canEdit: model.viewerCanUpdate && !scopeRefused, run } : null),
    [model, scopeRefused, run],
  )

  useAgentPageContext(model ? { label: `project “${model.title}” (#${number}) of ${fullName}`, tabTitle: model.title, owner, repo, details: { items: model.total } } : null)

  if (project.isLoading) return <Loading />
  if (project.error || !model || !editor)
    return (
      <div className="container-xl">
        {scopeHint(project.error) ? (
          <Blankslate icon={<ProjectIcon size={32} />} title="Your token can’t read projects">
            {scopeHint(project.error)}
          </Blankslate>
        ) : (
          <ErrorBox error={project.error ?? new Error('Project not found')} />
        )}
      </div>
    )

  return (
    <div className="container-full">
      <div className="flex-center gap-2 mb-3">
        <Link to={`/${owner}/${repo}/projects`} className="link-muted">
          Projects
        </Link>
        <span className="fg-muted">/</span>
        <h2 className="project-page-title flex-1">{model.title}</h2>
        <SegmentedControl aria-label="View" size="small" onChange={(i) => setView(i === 0 ? 'board' : 'table')}>
          <SegmentedControl.Button selected={view === 'board'}>Board</SegmentedControl.Button>
          <SegmentedControl.Button selected={view === 'table'}>Table</SegmentedControl.Button>
        </SegmentedControl>
        {!isNative && <IconButton icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(model.url)} />}
      </div>
      {/* Not dismissible: editing stays off once GitHub has refused the scope, so the notice explains why. */}
      {scopeRefused && <Banner className="mb-3" variant="warning" title="Your token can’t edit projects" description={WRITE_SCOPE_HINT} />}
      {editError !== null && (
        <Banner className="mb-3" variant="critical" title="Could not update the project" description={errorMessage(editError)} onDismiss={() => setEditError(null)} />
      )}
      {model.total > model.items.length && <p className="fg-muted text-small">Showing the first {model.items.length} of {model.total} items.</p>}
      {view === 'board' ? <Board editor={editor} /> : <Table editor={editor} />}
    </div>
  )
}
