import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banner, IconButton } from '@primer/react'
import { LinkExternalIcon, ProjectIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useAgentPageContext } from '../../../lib/agent/AgentProvider'
import { isNative, openExternal } from '../../../lib/platform'
import {
  columnFieldOf,
  createProjectView,
  deleteProjectView,
  fetchProject,
  fetchProjectItems,
  isScopeError,
  newViewName,
  pickView,
  projectPath,
  updateProjectView,
  withViewChanges,
  type ProjectItems,
  type ProjectLayout,
  type ProjectMeta,
  type ProjectModel,
  type ProjectScope,
} from '../../../lib/projects'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { Board } from './Board'
import { FilterBar } from './FilterBar'
import { Table } from './Table'
import { ViewTabs } from './ViewTabs'
import type { ProjectEditor } from './shared'

export function scopeHint(err: unknown) {
  const msg = String((err as Error)?.message ?? '')
  return isScopeError(err) || /scope|read:project|INSUFFICIENT/i.test(msg) ? 'Projects need the read:project scope (classic token) or Projects read access (fine-grained).' : null
}

const WRITE_SCOPE_HINT = 'Editing projects needs the project scope (classic token) or Projects read and write access (fine-grained). Your changes were not saved.'

/** github.com's `?layout=` values for a layout picked on a view and not saved yet. */
const LAYOUT_PARAMS: Record<string, ProjectLayout> = { table: 'TABLE_LAYOUT', board: 'BOARD_LAYOUT' }

/**
 * A project: its saved views as tabs, the current view's filter, and its items as a table or a board.
 * `scope` says where it was opened from (a repository's Projects tab, or its organization or user).
 *
 * The filter and layout can be changed without saving, as on github.com: the change lives in the
 * URL (`?filterQuery=`, `?layout=`) until it is saved to the view or discarded.
 */
export function ProjectScreen({ scope }: { scope: ProjectScope }) {
  const { number: n = '', view: v } = useParams()
  const number = Number(n)
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [editError, setEditError] = useState<unknown>(null)
  const [scopeRefused, setScopeRefused] = useState(false)
  const repo = scope.kind === 'repo' ? scope.repo : ''
  const metaKey = useMemo(() => [key, 'project', scope.kind, scope.owner, repo, number], [key, scope.kind, scope.owner, repo, number])
  const itemsRoot = useMemo(() => [...metaKey, 'items'], [metaKey])

  const project = useQuery({ queryKey: metaKey, queryFn: () => fetchProject(octokit, scope, number) })
  const meta = project.data ?? null
  const view = meta ? pickView(meta.views, v ? Number(v) : undefined) : undefined

  const filterDraft = params.get('filterQuery')
  const layoutDraft = LAYOUT_PARAMS[params.get('layout') ?? '']
  const filter = filterDraft ?? view?.filter ?? ''
  const layout: ProjectLayout = layoutDraft ?? view?.layout ?? 'TABLE_LAYOUT'
  const filterDirty = !!view && filterDraft !== null && filterDraft !== view.filter.trim()
  const layoutDirty = !!view && !!layoutDraft && layoutDraft !== view.layout
  const dirty = filterDirty || layoutDirty

  const itemsKey = useMemo(() => [...itemsRoot, filter], [itemsRoot, filter])
  const items = useQuery({
    queryKey: itemsKey,
    enabled: !!meta,
    queryFn: () => fetchProjectItems(octokit, meta!.id, meta!.fields, filter),
    // The rows stay (dimmed) while another filter or view loads, so the page does not jump.
    placeholderData: keepPreviousData,
  })

  const refused = useCallback((err: unknown) => {
    if (isScopeError(err)) setScopeRefused(true)
    else setEditError(err)
  }, [])

  // Item edits: optimistic on the cached items, rolled back on failure. The items are refetched once
  // the last of several overlapping edits settles, so a slow response cannot undo a newer optimistic change.
  const editKey = useMemo(() => [...metaKey, 'edit'], [metaKey])
  const edit = useMutation({
    mutationKey: editKey,
    mutationFn: ({ action }: { action: () => Promise<unknown>; optimistic?: (m: ProjectModel) => ProjectModel }) => action(),
    onMutate: async ({ optimistic }) => {
      setEditError(null)
      await qc.cancelQueries({ queryKey: itemsRoot })
      const current = qc.getQueryData<ProjectMeta | null>(metaKey)
      const previous = qc.getQueryData<ProjectItems>(itemsKey)
      if (current && previous && optimistic) {
        const next = optimistic({ ...current, ...previous })
        qc.setQueryData<ProjectItems>(itemsKey, { items: next.items, total: next.total })
      }
      return { previous, itemsKey }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(ctx.itemsKey, ctx.previous)
      refused(err)
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: editKey }) <= 1) void qc.invalidateQueries({ queryKey: itemsRoot })
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

  /** A change to the project's views: optimistic on the cached project, rolled back if GitHub refuses, then reloaded. */
  const changeViews = async (action: () => Promise<unknown>, optimistic?: (m: ProjectMeta) => ProjectMeta) => {
    setEditError(null)
    await qc.cancelQueries({ queryKey: metaKey, exact: true })
    const previous = qc.getQueryData<ProjectMeta | null>(metaKey)
    if (previous && optimistic) qc.setQueryData(metaKey, optimistic(previous))
    try {
      await action()
    } catch (err) {
      if (previous) qc.setQueryData(metaKey, previous)
      refused(err)
      return false
    }
    // `exact`: the views changed, the items did not.
    await qc.invalidateQueries({ queryKey: metaKey, exact: true })
    return true
  }

  /** Sets or clears an unsaved change of the view, kept in the URL. */
  const setDraft = (changes: { filterQuery?: string | null; layout?: string | null }) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) next.delete(name)
          else if (value !== undefined) next.set(name, value)
        }
        return next
      },
      { replace: true },
    )
  const discard = () => setDraft({ filterQuery: null, layout: null })

  const model = useMemo<ProjectModel | null>(() => (meta && items.data ? { ...meta, ...items.data } : null), [meta, items.data])
  const canEdit = !!meta?.viewerCanUpdate && !scopeRefused
  const editor = useMemo<ProjectEditor | null>(
    () => (model ? { model, scope, view, statusField: columnFieldOf(model, view), canEdit, run } : null),
    [model, scope, view, canEdit, run],
  )

  const where = scope.kind === 'repo' ? `${scope.owner}/${scope.repo}` : scope.owner
  useAgentPageContext(
    meta
      ? {
          label: `project “${meta.title}” (#${number}) of ${where}${view ? `, view “${view.name}”` : ''}`,
          tabTitle: meta.title,
          owner: scope.owner,
          repo: repo || undefined,
          details: { items: items.data?.total, filter: filter || undefined },
        }
      : null,
  )

  if (project.isLoading) return <Loading />
  if (project.error || !meta)
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

  const save = async () => {
    if (!view || !dirty) return
    const changes = { ...(filterDirty ? { filter } : {}), ...(layoutDirty ? { layout } : {}) }
    if (await changeViews(() => updateProjectView(octokit, view.id, changes), (m) => withViewChanges(m, view.id, changes))) discard()
  }

  return (
    <div className="container-full">
      <div className="flex-center gap-2 mb-3">
        {scope.kind === 'repo' ? (
          <Link to={`/${scope.owner}/${scope.repo}/projects`} className="link-muted">
            Projects
          </Link>
        ) : (
          <>
            <Link to={`/${scope.owner}`} className="link-muted">
              {scope.owner}
            </Link>
            <span className="fg-muted">/</span>
            <Link to={`/${scope.owner}?tab=projects`} className="link-muted">
              Projects
            </Link>
          </>
        )}
        <span className="fg-muted">/</span>
        <h2 className="project-page-title flex-1">{meta.title}</h2>
        {!isNative && <IconButton icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(view ? `${meta.url}/views/${view.number}` : meta.url)} />}
      </div>
      {view && (
        <ViewTabs
          views={meta.views}
          current={view}
          layout={layout}
          dirty={dirty}
          canEdit={canEdit}
          pathOf={(x) => projectPath(scope, number, x.number)}
          // A roadmap shows as a table here: picking Table on one is not a change to save.
          onLayout={(next) => setDraft({ layout: next === view.layout || (next === 'TABLE_LAYOUT' && view.layout === 'ROADMAP_LAYOUT') ? null : next === 'BOARD_LAYOUT' ? 'board' : 'table' })}
          onSave={() => void save()}
          onDiscard={discard}
          onRename={(name) => void changeViews(() => updateProjectView(octokit, view.id, { name }), (m) => withViewChanges(m, view.id, { name }))}
          onDelete={async () => {
            if (await changeViews(() => deleteProjectView(octokit, view.id), (m) => ({ ...m, views: m.views.filter((x) => x.id !== view.id) }))) navigate(projectPath(scope, number))
          }}
          onCreate={async (next) => {
            let created: { number: number } | undefined
            if (await changeViews(async () => (created = await createProjectView(octokit, meta.id, newViewName(meta.views), next)))) navigate(projectPath(scope, number, created?.number))
          }}
        />
      )}
      <FilterBar
        value={filter}
        count={items.data?.total}
        loading={items.isFetching}
        dirty={dirty}
        canEdit={canEdit}
        onChange={(next) => setDraft({ filterQuery: next === (view?.filter.trim() ?? '') ? null : next })}
        onSave={() => void save()}
        onDiscard={discard}
      />
      {/* Not dismissible: editing stays off once GitHub has refused the scope, so the notice explains why. */}
      {scopeRefused && <Banner className="mb-3" variant="warning" title="Your token can’t edit projects" description={WRITE_SCOPE_HINT} />}
      {editError !== null && (
        <Banner className="mb-3" variant="critical" title="Could not update the project" description={errorMessage(editError)} onDismiss={() => setEditError(null)} />
      )}
      {items.error ? (
        <ErrorBox error={items.error} title="Could not load the items" />
      ) : !model || !editor ? (
        <Loading />
      ) : (
        <div className="project-items" data-stale={items.isPlaceholderData || undefined}>
          {view?.layout === 'ROADMAP_LAYOUT' && layout !== 'BOARD_LAYOUT' && <p className="fg-muted text-small">Roadmap views show as a table here.</p>}
          {model.total > model.items.length && (
            <p className="fg-muted text-small">
              Showing the first {model.items.length} of {model.total} items.
            </p>
          )}
          {layout === 'BOARD_LAYOUT' ? <Board editor={editor} /> : <Table editor={editor} />}
        </div>
      )}
    </div>
  )
}
