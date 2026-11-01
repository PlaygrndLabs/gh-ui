import type { Octokit } from '@octokit/rest'

// Projects (v2): the project query, the item mutations the board and table views send, and the
// pure helpers behind their optimistic updates. Every mutation takes its input as one typed
// variable so the exact input object can be checked against GitHub's schema (and in tests).

type GraphQL = Pick<Octokit, 'graphql'>

/** A ProjectV2FieldValue input: exactly what updateProjectV2ItemFieldValue takes as `value`. */
export type ProjectFieldValue = { text: string } | { number: number } | { date: string } | { singleSelectOptionId: string } | { iterationId: string }

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
  content: ProjectItemContent | null
}

export interface ProjectModel {
  id: string
  title: string
  url: string
  viewerCanUpdate: boolean
  fields: ProjectField[]
  /** Items in project order (the position updateProjectV2ItemPosition changes). */
  items: ProjectItem[]
  total: number
  /** The repository the page is on: the default target for "Convert to issue". */
  repository: { id: string; nameWithOwner: string }
}

/** Field types an item's cell can be edited in (updateProjectV2ItemFieldValue). */
export const EDITABLE_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION']

const FIELD_ID = 'field{ ... on ProjectV2FieldCommon{ id } }'
const ITERATION = 'id title startDate duration'

export const PROJECT_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    id nameWithOwner
    projectV2(number:$number){
      id title url viewerCanUpdate
      fields(first:50){ nodes{ __typename
        ... on ProjectV2FieldCommon{ id name dataType }
        ... on ProjectV2SingleSelectField{ options{ id name color description } }
        ... on ProjectV2IterationField{ configuration{ iterations{ ${ITERATION} } completedIterations{ ${ITERATION} } } } } }
      items(first:100){ totalCount nodes{ id type
        fieldValues(first:30){ nodes{ __typename
          ... on ProjectV2ItemFieldSingleSelectValue{ optionId ${FIELD_ID} }
          ... on ProjectV2ItemFieldTextValue{ text ${FIELD_ID} }
          ... on ProjectV2ItemFieldNumberValue{ number ${FIELD_ID} }
          ... on ProjectV2ItemFieldDateValue{ date ${FIELD_ID} }
          ... on ProjectV2ItemFieldIterationValue{ iterationId ${FIELD_ID} } } }
        content{ __typename
          ... on Issue{ id number title state stateReason repository{nameWithOwner} assignees(first:3){nodes{login}} }
          ... on PullRequest{ id number title state isDraft repository{nameWithOwner} assignees(first:3){nodes{login}} }
          ... on DraftIssue{ id title } } } }
    }
  }
}`

interface RawIteration {
  id: string
  title: string
  startDate: string
  duration: number
}

export interface RawProject {
  repository: {
    id: string
    nameWithOwner: string
    projectV2: {
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
      items: {
        totalCount: number
        nodes: Array<{
          id: string
          type: ProjectItem['type']
          fieldValues: {
            nodes: Array<{ __typename: string; optionId?: string; text?: string; number?: number; date?: string; iterationId?: string; field?: { id?: string } }>
          }
          content: ProjectItemContent | null
        }>
      }
    } | null
  }
}

/** Flattens the project query into the model the views and optimistic updates work on. */
export function normalizeProject(raw: RawProject): ProjectModel | null {
  const p = raw.repository.projectV2
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
  const editable = new Set(fields.filter((f) => EDITABLE_TYPES.includes(f.dataType)).map((f) => f.id))
  const items: ProjectItem[] = p.items.nodes.map((it) => {
    const values: Record<string, ProjectFieldValue> = {}
    for (const v of it.fieldValues.nodes) {
      const id = v.field?.id
      if (!id || !editable.has(id)) continue
      if (v.optionId) values[id] = { singleSelectOptionId: v.optionId }
      else if (v.iterationId) values[id] = { iterationId: v.iterationId }
      else if (typeof v.number === 'number') values[id] = { number: v.number }
      else if (v.date) values[id] = { date: v.date }
      else if (typeof v.text === 'string' && v.text) values[id] = { text: v.text }
    }
    return { id: it.id, type: it.type, content: it.content, values }
  })
  return {
    id: p.id,
    title: p.title,
    url: p.url,
    viewerCanUpdate: p.viewerCanUpdate,
    fields,
    items,
    total: p.items.totalCount,
    repository: { id: raw.repository.id, nameWithOwner: raw.repository.nameWithOwner },
  }
}

export async function fetchProject(octokit: GraphQL, owner: string, repo: string, number: number) {
  return normalizeProject(await octokit.graphql<RawProject>(PROJECT_QUERY, { owner, repo, number }))
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

const ADDABLE = '__typename ... on Issue{ id number title state stateReason } ... on PullRequest{ id number title state isDraft }'
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
export const PROJECT_DOCUMENTS = { PROJECT_QUERY, UPDATE_FIELD, CLEAR_FIELD, UPDATE_POSITION, ADD_DRAFT, ADD_BY_ID, ARCHIVE, DELETE, CONVERT, SEARCH_ITEMS, ITEM_BY_NUMBER, CONVERT_TARGETS }

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

/** The "#" list of "Add item": the repository's issues and pull requests matching `term`. */
export async function searchAddableItems(octokit: GraphQL, owner: string, repo: string, term: string): Promise<AddableItem[]> {
  const number = /^\d+$/.test(term) ? Number(term) : null
  const recent = `repo:${owner}/${repo} sort:updated-desc`
  type Nodes = { nodes: Array<AddableItem | Record<string, never>> }
  const [res, exact] = await Promise.all([
    octokit.graphql<{ recent: Nodes; found: Nodes }>(SEARCH_ITEMS, { recent, q: term ? `repo:${owner}/${repo} ${term} sort:updated-desc` : recent }),
    number ? findItemByNumber(octokit, owner, repo, number) : null,
  ])
  const items = (c: Nodes) => c.nodes.filter((n): n is AddableItem => 'id' in n)
  return mergeAddable(term, items(res.recent), items(res.found), exact)
}

export interface RepositoryRef {
  id: string
  nameWithOwner: string
}

/** Repositories "Convert to issue" offers: this one, the project's linked ones, then the viewer's; those with issues turned on, once each. */
export function convertTargets(current: RepositoryRef, ...lists: Array<Array<RepositoryRef & { hasIssuesEnabled?: boolean }>>): RepositoryRef[] {
  const seen = new Set([current.id])
  const out = [current]
  for (const r of lists.flat()) {
    if (seen.has(r.id) || r.hasIssuesEnabled === false) continue
    seen.add(r.id)
    out.push({ id: r.id, nameWithOwner: r.nameWithOwner })
  }
  return out
}

export async function fetchConvertTargets(octokit: GraphQL, projectId: string, current: RepositoryRef) {
  type Repos = { nodes: Array<RepositoryRef & { hasIssuesEnabled: boolean }> }
  const res = await octokit.graphql<{ node: { repositories?: Repos } | null; viewer: { repositories: Repos } }>(CONVERT_TARGETS, { projectId })
  return convertTargets(current, res.node?.repositories?.nodes ?? [], res.viewer.repositories.nodes)
}

/** True for GraphQL INSUFFICIENT_SCOPES errors: the token lacks read:project / project. */
export function isScopeError(err: unknown) {
  const e = err as { errors?: Array<{ type?: string }>; message?: string } | null
  if (e?.errors?.some((x) => x?.type === 'INSUFFICIENT_SCOPES')) return true
  return /INSUFFICIENT_SCOPES|required scopes|read:project/i.test(String(e?.message ?? ''))
}

/** An issue or pull request URL pasted into "Add item": owner, repo and number. */
export function parseItemUrl(text: string, host = 'github.com') {
  const m = text.trim().match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)(?:[/?#]\S*)?$/)
  if (!m || m[1].toLowerCase() !== host.toLowerCase()) return null
  return { owner: m[2], repo: m[3], number: Number(m[5]) }
}
