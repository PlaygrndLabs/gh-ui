import type { Octokit } from '@octokit/rest'

// Projects (v2): the project and item queries, the item and view mutations the board and table
// views send, and the pure helpers behind their optimistic updates. Every mutation takes its input
// as one typed variable so the exact input object can be checked against GitHub's schema (and in tests).

type GraphQL = Pick<Octokit, 'graphql'>

/** Where a project is opened from: a repository's Projects tab, or the organization or user that owns it. */
export type ProjectScope = { kind: 'repo'; owner: string; repo: string } | { kind: 'org' | 'user'; owner: string }

/** The path of a project or one of its views, the same in-app as on github.com. */
export function projectPath(scope: ProjectScope, number: number, view?: number) {
  const base = scope.kind === 'repo' ? `/${scope.owner}/${scope.repo}` : `/${scope.kind}s/${scope.owner}`
  return `${base}/projects/${number}${view ? `/views/${view}` : ''}`
}

/** A ProjectV2FieldValue input: exactly what updateProjectV2ItemFieldValue takes as `value`. */
export type ProjectFieldValue = { text: string } | { number: number } | { date: string } | { singleSelectOptionId: string } | { iterationId: string }

export interface ProjectLinkedPull {
  number: number
  title: string
  repository: { nameWithOwner: string }
}

/** The value of a field that mirrors the issue or pull request (assignees, labels, ...): shown, not edited here. */
export type ProjectInfoValue =
  | { users: Array<{ login: string; avatarUrl: string }> }
  | { labels: Array<{ name: string; color: string }> }
  | { pulls: ProjectLinkedPull[] }
  | { text: string }

export interface ProjectOption {
  id: string
  name: string
  color: string
  description: string | null
}

export interface ProjectIteration {
  id: string
  title: string
  startDate: string
  duration: number
  completed: boolean
}

export interface ProjectField {
  id: string
  name: string
  dataType: string
  options?: ProjectOption[]
  iterations?: ProjectIteration[]
}

export interface ProjectItemContent {
  __typename: 'Issue' | 'PullRequest' | 'DraftIssue'
  id: string
  number?: number
  title: string
  state?: string
  stateReason?: string | null
  isDraft?: boolean
  repository?: { nameWithOwner: string }
  assignees?: { nodes: Array<{ login: string }> }
}

export interface ProjectItem {
  id: string
  type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'
  /** Field values by field id, for the field types the views edit. */
  values: Record<string, ProjectFieldValue>
  /** Values by field id of the fields the views only show (READ_ONLY_TYPES). */
  info: Record<string, ProjectInfoValue>
  content: ProjectItemContent | null
}

export type ProjectLayout = 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'

/** A saved view: a tab of the project with its own layout, filter, visible fields, sorting and grouping. */
export interface ProjectView {
  id: string
  number: number
  name: string
  layout: ProjectLayout
  filter: string
  /** Visible fields, in the view's column order. */
  fieldIds: string[]
  sortBy: Array<{ fieldId: string; direction: 'ASC' | 'DESC' }>
  /** Fields the table's rows are grouped by. */
  groupBy: string[]
  /** Fields the board's columns come from. */
  columnBy: string[]
}

export interface RepositoryRef {
  id: string
  nameWithOwner: string
}

/** A project without its items: what stays the same whichever view or filter is showing. */
export interface ProjectMeta {
  id: string
  title: string
  url: string
  viewerCanUpdate: boolean
  fields: ProjectField[]
  views: ProjectView[]
  /** The repository the page is on, the default target for "Convert to issue"; null on an organization's or user's project page. */
  repository: RepositoryRef | null
}

export interface ProjectItems {
  /** Items in project order (the position updateProjectV2ItemPosition changes). */
  items: ProjectItem[]
  /** How many items match the filter; more than items.length past MAX_PROJECT_ITEMS. */
  total: number
}

export interface ProjectModel extends ProjectMeta, ProjectItems {}

/** Field types an item's cell can be edited in (updateProjectV2ItemFieldValue). */
export const EDITABLE_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION']
/** Field types that mirror the issue or pull request: the table shows them, the item itself is where they change. */
export const READ_ONLY_TYPES = ['ASSIGNEES', 'LABELS', 'LINKED_PULL_REQUESTS', 'REVIEWERS', 'MILESTONE', 'REPOSITORY']

const FIELD_ID = 'field{ ... on ProjectV2FieldCommon{ id } }'
const FIELD_IDS = 'nodes{ ... on ProjectV2FieldCommon{ id } }'
const ITERATION = 'id title startDate duration'

const PROJECT = `id title url viewerCanUpdate
  fields(first:50){ nodes{ __typename
    ... on ProjectV2FieldCommon{ id name dataType }
    ... on ProjectV2SingleSelectField{ options{ id name color description } }
    ... on ProjectV2IterationField{ configuration{ iterations{ ${ITERATION} } completedIterations{ ${ITERATION} } } } } }
  views(first:50, orderBy:{field:POSITION, direction:ASC}){ nodes{ id number name layout filter
    fields(first:50){ ${FIELD_IDS} }
    sortByFields(first:5){ nodes{ direction ${FIELD_ID} } }
    groupByFields(first:5){ ${FIELD_IDS} }
    verticalGroupByFields(first:5){ ${FIELD_IDS} } } }`

export const PROJECT_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ id nameWithOwner projectV2(number:$number){ ${PROJECT} } }
}`

/** The same project asked of its owner: organizations and users both implement ProjectV2Owner. */
export const OWNER_PROJECT_QUERY = `query($owner:String!,$number:Int!){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner{ projectV2(number:$number){ ${PROJECT} } } }
}`

/** A page of items; `filter` is a view's filter ("assignee:octocat is:open"), applied by GitHub. (octokit keeps the variable name `query` for itself.) */
export const ITEMS_QUERY = `query($id:ID!,$after:String,$filter:String){
  node(id:$id){ ... on ProjectV2{
    items(first:100, after:$after, query:$filter){ totalCount pageInfo{ hasNextPage endCursor } nodes{ id type
      fieldValues(first:40){ nodes{ __typename
        ... on ProjectV2ItemFieldSingleSelectValue{ optionId ${FIELD_ID} }
        ... on ProjectV2ItemFieldTextValue{ text ${FIELD_ID} }
        ... on ProjectV2ItemFieldNumberValue{ number ${FIELD_ID} }
        ... on ProjectV2ItemFieldDateValue{ date ${FIELD_ID} }
        ... on ProjectV2ItemFieldIterationValue{ iterationId ${FIELD_ID} }
        ... on ProjectV2ItemFieldUserValue{ users(first:10){ nodes{ login avatarUrl } } ${FIELD_ID} }
        ... on ProjectV2ItemFieldLabelValue{ labels(first:20){ nodes{ name color } } ${FIELD_ID} }
        ... on ProjectV2ItemFieldPullRequestValue{ pullRequests(first:10){ nodes{ number title repository{ nameWithOwner } } } ${FIELD_ID} }
        ... on ProjectV2ItemFieldReviewerValue{ reviewers(first:10){ nodes{ __typename ... on Actor{ login } ... on Team{ name } } } ${FIELD_ID} }
        ... on ProjectV2ItemFieldMilestoneValue{ milestone{ title } ${FIELD_ID} }
        ... on ProjectV2ItemFieldRepositoryValue{ repository{ nameWithOwner } ${FIELD_ID} } } }
      content{ __typename
        ... on Issue{ id number title state stateReason repository{nameWithOwner} assignees(first:3){nodes{login}} }
        ... on PullRequest{ id number title state isDraft repository{nameWithOwner} assignees(first:3){nodes{login}} }
        ... on DraftIssue{ id title } } } }
  } }
}`

interface RawIteration {
  id: string
  title: string
  startDate: string
  duration: number
}

type RawFieldIds = { nodes: Array<{ id?: string } | null> }

export interface RawView {
  id: string
  number: number
  name: string
  layout: ProjectLayout
  filter: string | null
  fields?: RawFieldIds | null
  sortByFields?: { nodes: Array<{ direction: 'ASC' | 'DESC'; field: { id?: string } | null } | null> } | null
  groupByFields?: RawFieldIds | null
  verticalGroupByFields?: RawFieldIds | null
}

export interface RawProjectNode {
  id: string
  title: string
  url: string
  viewerCanUpdate: boolean
  fields: {
    nodes: Array<{
      __typename: string
      id?: string
      name?: string
      dataType?: string
      options?: ProjectOption[]
      configuration?: { iterations: RawIteration[]; completedIterations: RawIteration[] }
    }>
  }
  views?: { nodes: Array<RawView | null> } | null
}

/** What PROJECT_QUERY (repository) or OWNER_PROJECT_QUERY (repositoryOwner) answers. */
export interface RawProject {
  repository?: { id: string; nameWithOwner: string; projectV2: RawProjectNode | null } | null
  repositoryOwner?: { projectV2?: RawProjectNode | null } | null
}

export interface RawItem {
  id: string
  type: ProjectItem['type']
  fieldValues: {
    nodes: Array<{
      __typename: string
      optionId?: string
      text?: string
      number?: number
      date?: string
      iterationId?: string
      users?: { nodes: Array<{ login: string; avatarUrl: string } | null> }
      labels?: { nodes: Array<{ name: string; color: string } | null> }
      pullRequests?: { nodes: Array<ProjectLinkedPull | null> }
      reviewers?: { nodes: Array<{ login?: string; name?: string } | null> }
      milestone?: { title: string } | null
      repository?: { nameWithOwner: string } | null
      field?: { id?: string }
    } | null>
  }
  content: ProjectItemContent | null
}

const fieldIds = (c?: RawFieldIds | null) => (c?.nodes ?? []).flatMap((n) => (n?.id ? [n.id] : []))

function normalizeView(v: RawView): ProjectView {
  return {
    id: v.id,
    number: v.number,
    name: v.name,
    layout: v.layout,
    filter: v.filter ?? '',
    fieldIds: fieldIds(v.fields),
    sortBy: (v.sortByFields?.nodes ?? []).flatMap((s) => (s?.field?.id ? [{ fieldId: s.field.id, direction: s.direction }] : [])),
    groupBy: fieldIds(v.groupByFields),
    columnBy: fieldIds(v.verticalGroupByFields),
  }
}

/** Flattens the project query into the model the page works on; null when there is no such project. */
export function normalizeProject(raw: RawProject): ProjectMeta | null {
  const p = raw.repository ? raw.repository.projectV2 : raw.repositoryOwner?.projectV2
  if (!p) return null
  const fields: ProjectField[] = p.fields.nodes
    .filter((f) => f.id && f.name)
    .map((f) => ({
      id: f.id!,
      name: f.name!,
      dataType: f.dataType ?? 'TEXT',
      ...(f.options ? { options: f.options } : {}),
      ...(f.configuration
        ? {
            iterations: [
              ...f.configuration.iterations.map((i) => ({ ...i, completed: false })),
              ...f.configuration.completedIterations.map((i) => ({ ...i, completed: true })),
            ],
          }
        : {}),
    }))
  return {
    id: p.id,
    title: p.title,
    url: p.url,
    viewerCanUpdate: p.viewerCanUpdate,
    fields,
    views: (p.views?.nodes ?? []).flatMap((v) => (v ? [normalizeView(v)] : [])),
    repository: raw.repository ? { id: raw.repository.id, nameWithOwner: raw.repository.nameWithOwner } : null,
  }
}

const present = <T,>(c?: { nodes: Array<T | null> }) => (c?.nodes ?? []).filter((n): n is T => n !== null)

/** Flattens item nodes: editable values and shown-only values by field id, for the fields of those types. */
export function normalizeItems(nodes: RawItem[], fields: ProjectField[]): ProjectItem[] {
  const editable = new Set(fields.filter((f) => EDITABLE_TYPES.includes(f.dataType)).map((f) => f.id))
  const shown = new Set(fields.filter((f) => READ_ONLY_TYPES.includes(f.dataType)).map((f) => f.id))
  return nodes.map((it) => {
    const values: Record<string, ProjectFieldValue> = {}
    const info: Record<string, ProjectInfoValue> = {}
    for (const v of it.fieldValues.nodes) {
      const id = v?.field?.id
      if (!v || !id) continue
      if (editable.has(id)) {
        if (v.optionId) values[id] = { singleSelectOptionId: v.optionId }
        else if (v.iterationId) values[id] = { iterationId: v.iterationId }
        else if (typeof v.number === 'number') values[id] = { number: v.number }
        else if (v.date) values[id] = { date: v.date }
        else if (typeof v.text === 'string' && v.text) values[id] = { text: v.text }
      } else if (shown.has(id)) {
        if (v.users) info[id] = { users: present(v.users) }
        else if (v.labels) info[id] = { labels: present(v.labels) }
        else if (v.pullRequests) info[id] = { pulls: present(v.pullRequests) }
        else if (v.reviewers) info[id] = { text: present(v.reviewers).map((r) => r.login ?? r.name ?? '').filter(Boolean).join(', ') }
        else if (v.milestone) info[id] = { text: v.milestone.title }
        else if (v.repository) info[id] = { text: v.repository.nameWithOwner }
      }
    }
    return { id: it.id, type: it.type, content: it.content, values, info }
  })
}

/** The project without its items: fields and saved views. */
export async function fetchProject(octokit: GraphQL, scope: ProjectScope, number: number) {
  const raw =
    scope.kind === 'repo'
      ? await octokit.graphql<RawProject>(PROJECT_QUERY, { owner: scope.owner, repo: scope.repo, number })
      : await octokit.graphql<RawProject>(OWNER_PROJECT_QUERY, { owner: scope.owner, number })
  return normalizeProject(raw)
}

/** The most items a view loads: ten pages. Past that the page says how many it is showing. */
export const MAX_PROJECT_ITEMS = 1000

interface RawItemsPage {
  node: { items?: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawItem[] } } | null
}

/** The project's items matching `filter` (a view's filter; all items when empty), page after page. */
export async function fetchProjectItems(octokit: GraphQL, projectId: string, fields: ProjectField[], filter = ''): Promise<ProjectItems> {
  const nodes: RawItem[] = []
  let total = 0
  let after: string | null = null
  do {
    const res: RawItemsPage = await octokit.graphql<RawItemsPage>(ITEMS_QUERY, { id: projectId, after, filter: filter.trim() || null })
    const page = res.node?.items
    if (!page) break
    total = page.totalCount
    nodes.push(...page.nodes)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after && nodes.length < MAX_PROJECT_ITEMS)
  return { items: normalizeItems(nodes, fields), total }
}

// ---------- views ----------

/** The view a page shows: the one with that number, else the project's first. */
export function pickView(views: ProjectView[], number?: number): ProjectView | undefined {
  return views.find((v) => v.number === number) ?? views[0]
}

/** The table's columns after the title: the view's visible fields in its order, of the types the table can show. */
export function viewColumns(fields: ProjectField[], view?: Pick<ProjectView, 'fieldIds'>): ProjectField[] {
  const shown = fields.filter((f) => EDITABLE_TYPES.includes(f.dataType) || READ_ONLY_TYPES.includes(f.dataType))
  if (!view?.fieldIds.length) return shown
  return view.fieldIds.flatMap((id) => shown.filter((f) => f.id === id))
}

/** The field the board's columns come from: the view's column field when it is a single select, else Status. */
export function columnFieldOf(model: Pick<ProjectModel, 'fields'>, view?: Pick<ProjectView, 'columnBy'>): ProjectField | undefined {
  const selects = model.fields.filter((f) => f.dataType === 'SINGLE_SELECT')
  return selects.find((f) => view?.columnBy.includes(f.id)) ?? statusFieldOf(model)
}

/** Any field's value on an item as text: what plain cells show and what sorting and grouping compare. */
export function itemText(field: ProjectField, item: ProjectItem): string {
  if (field.dataType === 'TITLE') return item.content?.title ?? ''
  const info = item.info[field.id]
  if (!info) return displayValue(field, item.values[field.id])
  if ('users' in info) return info.users.map((u) => u.login).join(', ')
  if ('labels' in info) return info.labels.map((l) => l.name).join(', ')
  if ('pulls' in info) return info.pulls.map((p) => `#${p.number}`).join(', ')
  return info.text
}

/** What a field sorts by: numbers and dates as such, single selects by option order, iterations by start, the rest by text. */
function sortKey(field: ProjectField, item: ProjectItem): number | string | null {
  const v = item.values[field.id]
  if (v && 'number' in v) return v.number
  if (v && 'date' in v) return v.date
  if (v && 'singleSelectOptionId' in v) {
    const at = field.options?.findIndex((o) => o.id === v.singleSelectOptionId) ?? -1
    return at < 0 ? null : at
  }
  if (v && 'iterationId' in v) return field.iterations?.find((i) => i.id === v.iterationId)?.startDate ?? null
  return itemText(field, item).toLowerCase() || null
}

/** Items in a view's sort order; items without a value come last, ties keep project order. */
export function sortItems(items: ProjectItem[], fields: ProjectField[], sortBy: ProjectView['sortBy']): ProjectItem[] {
  const keys = sortBy.flatMap((s) => fields.filter((f) => f.id === s.fieldId).map((field) => ({ field, sign: s.direction === 'DESC' ? -1 : 1 })))
  if (!keys.length) return items
  return [...items].sort((a, b) => {
    for (const { field, sign } of keys) {
      const x = sortKey(field, a)
      const y = sortKey(field, b)
      if (x === y) continue
      if (x === null) return 1
      if (y === null) return -1
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      if (order) return order * sign
    }
    return 0
  })
}

export interface ItemGroup {
  /** The group's value as text; '' for the items without one. */
  key: string
  label: string
  /** The option's color when the field is a single select. */
  color?: string
  items: ProjectItem[]
}

/**
 * Items grouped by a field's value, for a view grouped by it: a single select's groups in option
 * order, the others as they first appear, and the items without a value last.
 */
export function groupItems(items: ProjectItem[], field: ProjectField): ItemGroup[] {
  const groups = new Map<string, ItemGroup>()
  for (const o of field.dataType === 'SINGLE_SELECT' ? (field.options ?? []) : []) groups.set(o.name, { key: o.name, label: o.name, color: o.color, items: [] })
  const none: ItemGroup = { key: '', label: `No ${field.name}`, items: [] }
  for (const it of items) {
    const key = itemText(field, it)
    if (!key) none.items.push(it)
    else if (groups.has(key)) groups.get(key)!.items.push(it)
    else groups.set(key, { key, label: key, items: [it] })
  }
  return [...groups.values(), none].filter((g) => g.items.length)
}

const VIEW_ID = 'projectV2View{ id number }'
const CREATE_VIEW = `mutation($input:CreateProjectV2ViewInput!){ createProjectV2View(input:$input){ ${VIEW_ID} } }`
const UPDATE_VIEW = `mutation($input:UpdateProjectV2ViewInput!){ updateProjectV2View(input:$input){ ${VIEW_ID} } }`
const DELETE_VIEW = `mutation($input:DeleteProjectV2ViewInput!){ deleteProjectV2View(input:$input){ clientMutationId } }`

/** Adds a view (a new tab) to the project; returns its number, for the view's path. */
export async function createProjectView(octokit: GraphQL, projectId: string, name: string, layout: ProjectLayout) {
  const res = await octokit.graphql<{ createProjectV2View: { projectV2View: { id: string; number: number } } }>(CREATE_VIEW, { input: { projectId, name, layout } })
  return res.createProjectV2View.projectV2View
}

/** Renames a view, switches its layout or saves its filter: only what `changes` names. */
export async function updateProjectView(octokit: GraphQL, viewId: string, changes: { name?: string; layout?: ProjectLayout; filter?: string }) {
  await octokit.graphql(UPDATE_VIEW, { input: { viewId, ...changes } })
}

export async function deleteProjectView(octokit: GraphQL, viewId: string) {
  await octokit.graphql(DELETE_VIEW, { input: { viewId } })
}

/** The project with a view changed, for the optimistic update of a rename, layout switch or saved filter. */
export function withViewChanges<T extends Pick<ProjectMeta, 'views'>>(meta: T, viewId: string, changes: Partial<Pick<ProjectView, 'name' | 'layout' | 'filter'>>): T {
  return { ...meta, views: meta.views.map((v) => (v.id === viewId ? { ...v, ...changes } : v)) }
}

/** A name for a new view that no other view has: "View 3", as github.com numbers them. */
export function newViewName(views: Array<Pick<ProjectView, 'name'>>) {
  const taken = new Set(views.map((v) => v.name.toLowerCase()))
  let n = views.length + 1
  while (taken.has(`view ${n}`)) n++
  return `View ${n}`
}

/** The field the board groups by: "Status", else the first single select field. */
export function statusFieldOf(model: Pick<ProjectModel, 'fields'>): ProjectField | undefined {
  const selects = model.fields.filter((f) => f.dataType === 'SINGLE_SELECT')
  return selects.find((f) => f.name.toLowerCase() === 'status') ?? selects[0]
}

/** The text a cell or card shows for a value. */
export function displayValue(field: ProjectField, value: ProjectFieldValue | undefined): string {
  if (!value) return ''
  if ('singleSelectOptionId' in value) return field.options?.find((o) => o.id === value.singleSelectOptionId)?.name ?? ''
  if ('iterationId' in value) return field.iterations?.find((i) => i.id === value.iterationId)?.title ?? ''
  if ('number' in value) return String(value.number)
  if ('date' in value) return formatProjectDate(value.date)
  return value.text
}

/** github.com's project dates: "Oct 31, 2026", for the calendar day stored (no time zone shift). */
export function formatProjectDate(date: string) {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** An iteration's span as github.com lists it: "Oct 28 - Nov 10". */
export function iterationRange(it: Pick<ProjectIteration, 'startDate' | 'duration'>) {
  const [y, m, d] = it.startDate.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, d))
  const end = new Date(Date.UTC(y, m - 1, d + it.duration - 1))
  const fmt = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${fmt(start)} - ${fmt(end)}`
}

/**
 * The value a text, number or date editor commits: null clears the field, undefined means the
 * input is not valid for the field (a number field given "abc") and nothing is sent.
 */
export function parseFieldInput(dataType: string, input: string): ProjectFieldValue | null | undefined {
  const s = input.trim()
  if (!s) return null
  if (dataType === 'NUMBER') {
    const n = Number(s)
    return Number.isFinite(n) ? { number: n } : undefined
  }
  if (dataType === 'DATE') return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : undefined
  return { text: s }
}

export function sameValue(a: ProjectFieldValue | null | undefined, b: ProjectFieldValue | null | undefined) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// ---------- optimistic updates ----------

export function withFieldValue(model: ProjectModel, itemId: string, fieldId: string, value: ProjectFieldValue | null): ProjectModel {
  return {
    ...model,
    items: model.items.map((it) => {
      if (it.id !== itemId) return it
      const values = { ...it.values }
      if (value) values[fieldId] = value
      else delete values[fieldId]
      return { ...it, values }
    }),
  }
}

/** Moves an item after another one (or to the top), as updateProjectV2ItemPosition does. */
export function reorderItems<T extends { id: string }>(items: T[], itemId: string, afterId: string | null): T[] {
  const moving = items.find((i) => i.id === itemId)
  if (!moving) return items
  const rest = items.filter((i) => i.id !== itemId)
  const at = afterId ? rest.findIndex((i) => i.id === afterId) + 1 : 0
  if (afterId && at === 0) return items
  return [...rest.slice(0, at), moving, ...rest.slice(at)]
}

export function withoutItem(model: ProjectModel, itemId: string): ProjectModel {
  return { ...model, items: model.items.filter((i) => i.id !== itemId), total: Math.max(0, model.total - 1) }
}

/** The board column (single select option id, or null for "No status") an item sits in. */
export function columnOf(item: ProjectItem, statusFieldId: string | undefined): string | null {
  const v = statusFieldId ? item.values[statusFieldId] : undefined
  return v && 'singleSelectOptionId' in v ? v.singleSelectOptionId : null
}

export interface BoardMove {
  itemId: string
  /** Target column: an option id of the status field, or null for "No status". */
  toColumn: string | null
  /** The item to place the card after (updateProjectV2ItemPosition afterId); null puts it on top. */
  afterId: string | null
  statusChange: boolean
  reorder: boolean
}

/**
 * Plans dropping a card at `index` of a column (counted without the dragged card). The status
 * changes when the column does; the position only when the card would not land there anyway.
 */
export function planBoardMove(items: ProjectItem[], statusFieldId: string | undefined, itemId: string, toColumn: string | null, index: number): BoardMove | null {
  const moving = items.find((i) => i.id === itemId)
  if (!moving) return null
  const target = items.filter((i) => i.id !== itemId && columnOf(i, statusFieldId) === toColumn)
  const at = Math.max(0, Math.min(index, target.length))
  const afterId = at > 0 ? target[at - 1].id : null
  const natural = items.filter((i) => i.id === itemId || columnOf(i, statusFieldId) === toColumn).map((i) => i.id)
  const desired = [...target.slice(0, at), moving, ...target.slice(at)].map((i) => i.id)
  const statusChange = columnOf(moving, statusFieldId) !== toColumn
  const reorder = natural.join('\n') !== desired.join('\n')
  if (!statusChange && !reorder) return null
  return { itemId, toColumn, afterId, statusChange, reorder }
}

/** The model after a board move, for the optimistic update. */
export function applyBoardMove(model: ProjectModel, statusFieldId: string, move: BoardMove): ProjectModel {
  let next = model
  if (move.statusChange) next = withFieldValue(next, move.itemId, statusFieldId, move.toColumn ? { singleSelectOptionId: move.toColumn } : null)
  if (move.reorder) next = { ...next, items: reorderItems(next.items, move.itemId, move.afterId) }
  return next
}

// ---------- mutations ----------

const UPDATE_FIELD = `mutation($input:UpdateProjectV2ItemFieldValueInput!){ updateProjectV2ItemFieldValue(input:$input){ projectV2Item{ id } } }`
const CLEAR_FIELD = `mutation($input:ClearProjectV2ItemFieldValueInput!){ clearProjectV2ItemFieldValue(input:$input){ projectV2Item{ id } } }`
const UPDATE_POSITION = `mutation($input:UpdateProjectV2ItemPositionInput!){ updateProjectV2ItemPosition(input:$input){ clientMutationId } }`
const ADD_DRAFT = `mutation($input:AddProjectV2DraftIssueInput!){ addProjectV2DraftIssue(input:$input){ projectItem{ id } } }`
const ADD_BY_ID = `mutation($input:AddProjectV2ItemByIdInput!){ addProjectV2ItemById(input:$input){ item{ id } } }`
const ARCHIVE = `mutation($input:ArchiveProjectV2ItemInput!){ archiveProjectV2Item(input:$input){ item{ id } } }`
const DELETE = `mutation($input:DeleteProjectV2ItemInput!){ deleteProjectV2Item(input:$input){ deletedItemId } }`
const CONVERT = `mutation($input:ConvertProjectV2DraftIssueItemToIssueInput!){ convertProjectV2DraftIssueItemToIssue(input:$input){ item{ id content{ ... on Issue{ number repository{ nameWithOwner } } } } } }`

const ADDABLE = '__typename ... on Issue{ id number title state stateReason repository{ nameWithOwner } } ... on PullRequest{ id number title state isDraft repository{ nameWithOwner } }'
const SEARCH_ITEMS = `query($recent:String!,$q:String!){
  recent: search(type:ISSUE, query:$recent, first:30){ nodes{ ${ADDABLE} } }
  found: search(type:ISSUE, query:$q, first:20){ nodes{ ${ADDABLE} } }
}`
const ITEM_BY_NUMBER = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issueOrPullRequest(number:$number){ ${ADDABLE} } } }`
const CONVERT_TARGETS = `query($projectId:ID!){
  node(id:$projectId){ ... on ProjectV2{ repositories(first:20){ nodes{ id nameWithOwner hasIssuesEnabled } } } }
  viewer{ repositories(first:50, orderBy:{field:PUSHED_AT, direction:DESC}, affiliations:[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]){ nodes{ id nameWithOwner hasIssuesEnabled } } }
}`

/** Every GraphQL document this module sends, for checking against the live schema. */
export const PROJECT_DOCUMENTS = { PROJECT_QUERY, OWNER_PROJECT_QUERY, ITEMS_QUERY, CREATE_VIEW, UPDATE_VIEW, DELETE_VIEW, UPDATE_FIELD, CLEAR_FIELD, UPDATE_POSITION, ADD_DRAFT, ADD_BY_ID, ARCHIVE, DELETE, CONVERT, SEARCH_ITEMS, ITEM_BY_NUMBER, CONVERT_TARGETS }

interface ItemRef {
  projectId: string
  itemId: string
}

/** Sets a field's value on an item, or clears it when value is null. */
export async function setItemField(octokit: GraphQL, ref: ItemRef & { fieldId: string }, value: ProjectFieldValue | null) {
  const { projectId, itemId, fieldId } = ref
  if (value) await octokit.graphql(UPDATE_FIELD, { input: { projectId, itemId, fieldId, value } })
  else await octokit.graphql(CLEAR_FIELD, { input: { projectId, itemId, fieldId } })
}

/** Moves an item after another one; afterId null moves it to the top (the input omits afterId). */
export async function setItemPosition(octokit: GraphQL, { projectId, itemId }: ItemRef, afterId: string | null) {
  await octokit.graphql(UPDATE_POSITION, { input: { projectId, itemId, ...(afterId ? { afterId } : {}) } })
}

/** Sends a planned board move: the status first, then the position. */
export async function moveBoardItem(octokit: GraphQL, projectId: string, statusFieldId: string, move: BoardMove) {
  const ref = { projectId, itemId: move.itemId }
  if (move.statusChange) await setItemField(octokit, { ...ref, fieldId: statusFieldId }, move.toColumn ? { singleSelectOptionId: move.toColumn } : null)
  if (move.reorder) await setItemPosition(octokit, ref, move.afterId)
}

export type NewItem = { title: string } | { contentId: string }

/**
 * Adds a draft issue (title) or an existing issue / pull request (contentId) to the project, then
 * gives it the column's status when it was added from a board column. Returns the new item id.
 */
export async function addProjectItem(octokit: GraphQL, projectId: string, item: NewItem, status?: { fieldId: string; optionId: string }) {
  let itemId: string
  if ('title' in item) {
    const res = await octokit.graphql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(ADD_DRAFT, { input: { projectId, title: item.title } })
    itemId = res.addProjectV2DraftIssue.projectItem.id
  } else {
    const res = await octokit.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_BY_ID, { input: { projectId, contentId: item.contentId } })
    itemId = res.addProjectV2ItemById.item.id
  }
  if (status) await setItemField(octokit, { projectId, itemId, fieldId: status.fieldId }, { singleSelectOptionId: status.optionId })
  return itemId
}

export async function archiveProjectItem(octokit: GraphQL, ref: ItemRef) {
  await octokit.graphql(ARCHIVE, { input: { projectId: ref.projectId, itemId: ref.itemId } })
}

export async function deleteProjectItem(octokit: GraphQL, ref: ItemRef) {
  await octokit.graphql(DELETE, { input: { projectId: ref.projectId, itemId: ref.itemId } })
}

/** Converts a draft issue item into an issue in a repository (the mutation takes no project id). */
export async function convertDraftToIssue(octokit: GraphQL, itemId: string, repositoryId: string) {
  const res = await octokit.graphql<{ convertProjectV2DraftIssueItemToIssue: { item: { id: string; content: { number?: number; repository?: { nameWithOwner: string } } | null } } }>(CONVERT, {
    input: { itemId, repositoryId },
  })
  return res.convertProjectV2DraftIssueItemToIssue.item
}

/** An issue or pull request "Add item" can add. */
export interface AddableItem {
  __typename: 'Issue' | 'PullRequest'
  id: string
  number: number
  title: string
  state: string
  stateReason?: string | null
  isDraft?: boolean
  repository?: { nameWithOwner: string }
}

/** Looks up one issue or pull request by number; null when there is none (GraphQL answers NOT_FOUND). */
export async function findItemByNumber(octokit: GraphQL, owner: string, repo: string, number: number): Promise<AddableItem | null> {
  try {
    const res = await octokit.graphql<{ repository: { issueOrPullRequest: AddableItem | null } | null }>(ITEM_BY_NUMBER, { owner, repo, number })
    return res.repository?.issueOrPullRequest ?? null
  } catch {
    return null
  }
}

/**
 * Orders the "#" list: an exact "#123" match, then recently updated items whose title contains the
 * typed text or whose number starts with it (GitHub search matches whole words only, so "mult" would
 * miss "multiply()"), then the search results for it. Each item once.
 */
export function mergeAddable(term: string, recent: AddableItem[], found: AddableItem[], exact: AddableItem | null): AddableItem[] {
  const t = term.toLowerCase()
  const seen = new Set<string>()
  const out: AddableItem[] = []
  const matches = (r: AddableItem) => !t || r.title.toLowerCase().includes(t) || String(r.number).startsWith(t)
  for (const it of [...(exact ? [exact] : []), ...recent.filter(matches), ...(t ? found : [])]) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out
}

/** The search qualifier for where "Add item" looks: the repository the page is on, or everything the project's owner has. */
export function searchQualifier(scope: ProjectScope) {
  return scope.kind === 'repo' ? `repo:${scope.owner}/${scope.repo}` : `${scope.kind}:${scope.owner}`
}

/** The "#" list of "Add item": the issues and pull requests matching `term` in the repository, or across the owner's repositories. */
export async function searchAddableItems(octokit: GraphQL, scope: ProjectScope, term: string): Promise<AddableItem[]> {
  // A bare number is an issue number only where there is one repository to look it up in.
  const number = scope.kind === 'repo' && /^\d+$/.test(term) ? Number(term) : null
  const recent = `${searchQualifier(scope)} sort:updated-desc`
  type Nodes = { nodes: Array<AddableItem | Record<string, never>> }
  const [res, exact] = await Promise.all([
    octokit.graphql<{ recent: Nodes; found: Nodes }>(SEARCH_ITEMS, { recent, q: term ? `${searchQualifier(scope)} ${term} sort:updated-desc` : recent }),
    number && scope.kind === 'repo' ? findItemByNumber(octokit, scope.owner, scope.repo, number) : null,
  ])
  const items = (c: Nodes) => c.nodes.filter((n): n is AddableItem => 'id' in n)
  return mergeAddable(term, items(res.recent), items(res.found), exact)
}

/** Repositories "Convert to issue" offers: the page's one (if any), the project's linked ones, then the viewer's; those with issues turned on, once each. */
export function convertTargets(current: RepositoryRef | null, ...lists: Array<Array<RepositoryRef & { hasIssuesEnabled?: boolean }>>): RepositoryRef[] {
  const seen = new Set(current ? [current.id] : [])
  const out = current ? [current] : []
  for (const r of lists.flat()) {
    if (seen.has(r.id) || r.hasIssuesEnabled === false) continue
    seen.add(r.id)
    out.push({ id: r.id, nameWithOwner: r.nameWithOwner })
  }
  return out
}

export async function fetchConvertTargets(octokit: GraphQL, projectId: string, current: RepositoryRef | null) {
  type Repos = { nodes: Array<RepositoryRef & { hasIssuesEnabled: boolean }> }
  const res = await octokit.graphql<{ node: { repositories?: Repos } | null; viewer: { repositories: Repos } }>(CONVERT_TARGETS, { projectId })
  return convertTargets(current, res.node?.repositories?.nodes ?? [], res.viewer.repositories.nodes)
}

/**
 * True when GitHub refused for what the token may do: INSUFFICIENT_SCOPES for a classic token without
 * read:project / project, "Resource not accessible by personal access token" for a fine-grained one
 * without the Projects permission.
 */
export function isScopeError(err: unknown) {
  const e = err as { errors?: Array<{ type?: string }>; message?: string } | null
  if (e?.errors?.some((x) => x?.type === 'INSUFFICIENT_SCOPES')) return true
  return /INSUFFICIENT_SCOPES|required scopes|read:project|not accessible by personal access token/i.test(String(e?.message ?? ''))
}

/** An issue or pull request URL pasted into "Add item": owner, repo and number. */
export function parseItemUrl(text: string, host = 'github.com') {
  const m = text.trim().match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)(?:[/?#]\S*)?$/)
  if (!m || m[1].toLowerCase() !== host.toLowerCase()) return null
  return { owner: m[2], repo: m[3], number: Number(m[5]) }
}
