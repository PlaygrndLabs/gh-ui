import { describe, expect, it, vi } from 'vitest'
import type { Octokit } from '@octokit/rest'
import {
  ITEMS_QUERY,
  OWNER_PROJECT_QUERY,
  PROJECT_QUERY,
  addProjectItem,
  applyBoardMove,
  archiveProjectItem,
  columnFieldOf,
  convertDraftToIssue,
  convertTargets,
  createProjectView,
  deleteProjectItem,
  deleteProjectView,
  displayValue,
  fetchProject,
  fetchProjectItems,
  formatProjectDate,
  groupItems,
  isScopeError,
  itemText,
  iterationRange,
  mergeAddable,
  moveBoardItem,
  newViewName,
  normalizeItems,
  normalizeProject,
  parseFieldInput,
  parseItemUrl,
  pickView,
  planBoardMove,
  projectPath,
  reorderItems,
  searchAddableItems,
  setItemField,
  setItemPosition,
  sortItems,
  statusFieldOf,
  updateProjectView,
  viewColumns,
  withFieldValue,
  withViewChanges,
  withoutItem,
  type AddableItem,
  type ProjectItem,
  type ProjectModel,
  type RawItem,
  type RawProject,
} from './projects'

/** An octokit whose graphql records each call and answers from `replies` in order. */
function fakeOctokit(...replies: unknown[]) {
  const graphql = vi.fn(async (_query: string, _vars?: Record<string, unknown>) => replies.shift() ?? {})
  return { octokit: { graphql } as unknown as Pick<Octokit, 'graphql'>, graphql }
}

/** The mutation name and variables of every graphql call, in order. */
function sent(graphql: ReturnType<typeof fakeOctokit>['graphql']) {
  return graphql.mock.calls.map(([query, vars]) => [query.match(/\{\s*(\w+)\(/)?.[1], vars])
}

const ref = { projectId: 'PVT_1', itemId: 'PVTI_1' }

describe('project mutations', () => {
  it('sets each field type with its ProjectV2FieldValue input', async () => {
    const { octokit, graphql } = fakeOctokit()
    await setItemField(octokit, { ...ref, fieldId: 'F_status' }, { singleSelectOptionId: 'opt_done' })
    await setItemField(octokit, { ...ref, fieldId: 'F_text' }, { text: 'hello' })
    await setItemField(octokit, { ...ref, fieldId: 'F_num' }, { number: 3.5 })
    await setItemField(octokit, { ...ref, fieldId: 'F_date' }, { date: '2026-10-31' })
    await setItemField(octokit, { ...ref, fieldId: 'F_iter' }, { iterationId: 'it_2' })
    expect(sent(graphql)).toEqual([
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_status', value: { singleSelectOptionId: 'opt_done' } } }],
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_text', value: { text: 'hello' } } }],
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_num', value: { number: 3.5 } } }],
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_date', value: { date: '2026-10-31' } } }],
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_iter', value: { iterationId: 'it_2' } } }],
    ])
    expect(graphql.mock.calls[0][0]).toContain('$input:UpdateProjectV2ItemFieldValueInput!')
  })

  it('clears a field with clearProjectV2ItemFieldValue', async () => {
    const { octokit, graphql } = fakeOctokit()
    await setItemField(octokit, { ...ref, fieldId: 'F_text' }, null)
    expect(sent(graphql)).toEqual([['clearProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_text' } }]])
    expect(graphql.mock.calls[0][0]).toContain('$input:ClearProjectV2ItemFieldValueInput!')
  })

  it('positions after an item, or omits afterId to move to the top', async () => {
    const { octokit, graphql } = fakeOctokit()
    await setItemPosition(octokit, ref, 'PVTI_0')
    await setItemPosition(octokit, ref, null)
    expect(sent(graphql)).toEqual([
      ['updateProjectV2ItemPosition', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', afterId: 'PVTI_0' } }],
      ['updateProjectV2ItemPosition', { input: { projectId: 'PVT_1', itemId: 'PVTI_1' } }],
    ])
  })

  it('sends a board move as status then position, skipping what did not change', async () => {
    const { octokit, graphql } = fakeOctokit()
    await moveBoardItem(octokit, 'PVT_1', 'F_status', { itemId: 'PVTI_1', toColumn: 'opt_done', afterId: 'PVTI_9', statusChange: true, reorder: true })
    await moveBoardItem(octokit, 'PVT_1', 'F_status', { itemId: 'PVTI_1', toColumn: null, afterId: null, statusChange: true, reorder: false })
    await moveBoardItem(octokit, 'PVT_1', 'F_status', { itemId: 'PVTI_1', toColumn: 'opt_done', afterId: null, statusChange: false, reorder: true })
    expect(sent(graphql)).toEqual([
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_status', value: { singleSelectOptionId: 'opt_done' } } }],
      ['updateProjectV2ItemPosition', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', afterId: 'PVTI_9' } }],
      ['clearProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_status' } }],
      ['updateProjectV2ItemPosition', { input: { projectId: 'PVT_1', itemId: 'PVTI_1' } }],
    ])
  })

  it('adds a draft issue, then sets the column status on the new item', async () => {
    const { octokit, graphql } = fakeOctokit({ addProjectV2DraftIssue: { projectItem: { id: 'PVTI_new' } } })
    const id = await addProjectItem(octokit, 'PVT_1', { title: 'Write docs' }, { fieldId: 'F_status', optionId: 'opt_todo' })
    expect(id).toBe('PVTI_new')
    expect(sent(graphql)).toEqual([
      ['addProjectV2DraftIssue', { input: { projectId: 'PVT_1', title: 'Write docs' } }],
      ['updateProjectV2ItemFieldValue', { input: { projectId: 'PVT_1', itemId: 'PVTI_new', fieldId: 'F_status', value: { singleSelectOptionId: 'opt_todo' } } }],
    ])
  })

  it('adds an existing issue or pull request by content id', async () => {
    const { octokit, graphql } = fakeOctokit({ addProjectV2ItemById: { item: { id: 'PVTI_7' } } })
    expect(await addProjectItem(octokit, 'PVT_1', { contentId: 'I_kwDO' })).toBe('PVTI_7')
    expect(sent(graphql)).toEqual([['addProjectV2ItemById', { input: { projectId: 'PVT_1', contentId: 'I_kwDO' } }]])
  })

  it('archives, deletes and converts drafts with their inputs', async () => {
    const { octokit, graphql } = fakeOctokit({}, {}, { convertProjectV2DraftIssueItemToIssue: { item: { id: 'PVTI_1', content: { number: 5, repository: { nameWithOwner: 'o/r' } } } } })
    await archiveProjectItem(octokit, ref)
    await deleteProjectItem(octokit, ref)
    const item = await convertDraftToIssue(octokit, 'PVTI_1', 'R_1')
    expect(item.content).toEqual({ number: 5, repository: { nameWithOwner: 'o/r' } })
    expect(sent(graphql)).toEqual([
      ['archiveProjectV2Item', { input: { projectId: 'PVT_1', itemId: 'PVTI_1' } }],
      ['deleteProjectV2Item', { input: { projectId: 'PVT_1', itemId: 'PVTI_1' } }],
      ['convertProjectV2DraftIssueItemToIssue', { input: { itemId: 'PVTI_1', repositoryId: 'R_1' } }],
    ])
  })
})

const RAW: RawProject = {
  repository: {
    id: 'R_1',
    nameWithOwner: 'o/r',
    projectV2: {
      id: 'PVT_1',
      title: 'Roadmap',
      url: 'https://github.com/users/o/projects/1',
      viewerCanUpdate: true,
      fields: {
        nodes: [
          { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title', dataType: 'TITLE' },
          { __typename: 'ProjectV2Field', id: 'F_assignees', name: 'Assignees', dataType: 'ASSIGNEES' },
          { __typename: 'ProjectV2Field', id: 'F_labels', name: 'Labels', dataType: 'LABELS' },
          { __typename: 'ProjectV2Field', id: 'F_pulls', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
          { __typename: 'ProjectV2Field', id: 'F_reviewers', name: 'Reviewers', dataType: 'REVIEWERS' },
          { __typename: 'ProjectV2Field', id: 'F_milestone', name: 'Milestone', dataType: 'MILESTONE' },
          { __typename: 'ProjectV2Field', id: 'F_repo', name: 'Repository', dataType: 'REPOSITORY' },
          { __typename: 'ProjectV2Field', id: 'F_tracks', name: 'Tracks', dataType: 'TRACKS' },
          {
            __typename: 'ProjectV2SingleSelectField',
            id: 'F_status',
            name: 'Status',
            dataType: 'SINGLE_SELECT',
            options: [
              { id: 'todo', name: 'Todo', color: 'GREEN', description: null },
              { id: 'done', name: 'Done', color: 'PURPLE', description: null },
            ],
          },
          { __typename: 'ProjectV2Field', id: 'F_est', name: 'Estimate', dataType: 'NUMBER' },
          { __typename: 'ProjectV2SingleSelectField', id: 'F_prio', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ id: 'hi', name: 'High', color: 'RED', description: null }] },
          {
            __typename: 'ProjectV2IterationField',
            id: 'F_iter',
            name: 'Iteration',
            dataType: 'ITERATION',
            configuration: { iterations: [{ id: 'it2', title: 'Iteration 2', startDate: '2026-10-28', duration: 14 }], completedIterations: [{ id: 'it1', title: 'Iteration 1', startDate: '2026-10-14', duration: 14 }] },
          },
        ],
      },
      views: {
        nodes: [
          {
            id: 'V_1',
            number: 1,
            name: 'Backlog',
            layout: 'TABLE_LAYOUT',
            filter: 'assignee:octocat is:open',
            fields: { nodes: [{ id: 'F_title' }, { id: 'F_labels' }, { id: 'F_status' }, { id: 'F_assignees' }, {}, null] },
            sortByFields: { nodes: [{ direction: 'DESC', field: { id: 'F_est' } }, { direction: 'ASC', field: null }] },
            groupByFields: { nodes: [{ id: 'F_status' }] },
            verticalGroupByFields: { nodes: [] },
          },
          null,
          { id: 'V_2', number: 4, name: 'Board', layout: 'BOARD_LAYOUT', filter: null, verticalGroupByFields: { nodes: [{ id: 'F_prio' }] } },
        ],
      },
    },
  },
}

const RAW_ITEMS: RawItem[] = [
  {
    id: 'A',
    type: 'DRAFT_ISSUE',
    fieldValues: {
      nodes: [
        { __typename: 'ProjectV2ItemFieldTextValue', text: 'Draft A', field: { id: 'F_title' } },
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: 'todo', field: { id: 'F_status' } },
        { __typename: 'ProjectV2ItemFieldNumberValue', number: 0, field: { id: 'F_est' } },
        { __typename: 'ProjectV2ItemFieldIterationValue', iterationId: 'it1', field: { id: 'F_iter' } },
      ],
    },
    content: { __typename: 'DraftIssue', id: 'DI_1', title: 'Draft A' },
  },
  {
    id: 'B',
    type: 'ISSUE',
    fieldValues: {
      nodes: [
        null,
        { __typename: 'ProjectV2ItemFieldUserValue', users: { nodes: [{ login: 'octocat', avatarUrl: 'https://a/1' }, null, { login: 'hubot', avatarUrl: 'https://a/2' }] }, field: { id: 'F_assignees' } },
        { __typename: 'ProjectV2ItemFieldLabelValue', labels: { nodes: [{ name: 'priority:5-critical', color: 'b60205' }] }, field: { id: 'F_labels' } },
        { __typename: 'ProjectV2ItemFieldPullRequestValue', pullRequests: { nodes: [{ number: 7, title: 'Fix it', repository: { nameWithOwner: 'o/r' } }] }, field: { id: 'F_pulls' } },
        { __typename: 'ProjectV2ItemFieldReviewerValue', reviewers: { nodes: [{ login: 'mona' }, { name: 'core' }] }, field: { id: 'F_reviewers' } },
        { __typename: 'ProjectV2ItemFieldMilestoneValue', milestone: { title: 'v1' }, field: { id: 'F_milestone' } },
        { __typename: 'ProjectV2ItemFieldRepositoryValue', repository: { nameWithOwner: 'o/r' }, field: { id: 'F_repo' } },
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: 'done', field: { id: 'F_status' } },
        { __typename: 'ProjectV2ItemFieldNumberValue', number: 8, field: { id: 'F_est' } },
      ],
    },
    content: { __typename: 'Issue', id: 'I_1', number: 12, title: 'Fix login', state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
  },
  { id: 'C', type: 'REDACTED', fieldValues: { nodes: [{ __typename: 'ProjectV2ItemUserValue' }] }, content: null },
]

function item(id: string, status?: string): ProjectItem {
  return { id, type: 'ISSUE', content: null, values: status ? { S: { singleSelectOptionId: status } } : {}, info: {} }
}

describe('project model', () => {
  it('keeps editable field values by field id and skips the title', () => {
    const m = normalizeProject(RAW)!
    const items = normalizeItems(RAW_ITEMS, m.fields)
    expect(items[0].values).toEqual({ F_status: { singleSelectOptionId: 'todo' }, F_est: { number: 0 }, F_iter: { iterationId: 'it1' } })
    expect(items[0].info).toEqual({})
    expect(items[2]).toMatchObject({ values: {}, info: {}, content: null })
    expect(m.fields.find((f) => f.id === 'F_iter')!.iterations!.map((i) => [i.id, i.completed])).toEqual([
      ['it2', false],
      ['it1', true],
    ])
    expect(statusFieldOf(m)?.id).toBe('F_status')
    expect(m.repository).toEqual({ id: 'R_1', nameWithOwner: 'o/r' })
    expect(normalizeProject({ repository: { id: 'R', nameWithOwner: 'o/r', projectV2: null } })).toBeNull()
  })

  it('keeps the values of fields that mirror the issue, to show them', () => {
    const m = normalizeProject(RAW)!
    const b = normalizeItems(RAW_ITEMS, m.fields)[1]
    expect(b.info).toEqual({
      F_assignees: { users: [{ login: 'octocat', avatarUrl: 'https://a/1' }, { login: 'hubot', avatarUrl: 'https://a/2' }] },
      F_labels: { labels: [{ name: 'priority:5-critical', color: 'b60205' }] },
      F_pulls: { pulls: [{ number: 7, title: 'Fix it', repository: { nameWithOwner: 'o/r' } }] },
      F_reviewers: { text: 'mona, core' },
      F_milestone: { text: 'v1' },
      F_repo: { text: 'o/r' },
    })
    const text = (id: string) => itemText(m.fields.find((f) => f.id === id)!, b)
    expect([text('F_title'), text('F_assignees'), text('F_labels'), text('F_pulls'), text('F_status'), text('F_est')]).toEqual(['Fix login', 'octocat, hubot', 'priority:5-critical', '#7', 'Done', '8'])
  })

  it('reads a project the same from its repository or from its owner', () => {
    const { repository } = RAW
    const owned = normalizeProject({ repositoryOwner: { projectV2: repository!.projectV2 } })!
    expect(owned.repository).toBeNull()
    expect(owned.views).toEqual(normalizeProject(RAW)!.views)
    expect(normalizeProject({ repositoryOwner: null })).toBeNull()
    // A user that is not a ProjectV2Owner answers an empty object.
    expect(normalizeProject({ repositoryOwner: {} })).toBeNull()
  })

  it('displays values the way github.com does', () => {
    const m = normalizeProject(RAW)!
    const field = (id: string) => m.fields.find((f) => f.id === id)!
    expect(displayValue(field('F_status'), { singleSelectOptionId: 'done' })).toBe('Done')
    expect(displayValue(field('F_iter'), { iterationId: 'it2' })).toBe('Iteration 2')
    expect(displayValue(field('F_est'), { number: 0 })).toBe('0')
    expect(displayValue(field('F_est'), undefined)).toBe('')
    expect(formatProjectDate('2026-01-05')).toBe('Jan 5, 2026')
    expect(iterationRange({ startDate: '2026-10-28', duration: 14 })).toBe('Oct 28 - Nov 10')
  })

  it('parses editor input per field type', () => {
    expect(parseFieldInput('NUMBER', ' 4.25 ')).toEqual({ number: 4.25 })
    expect(parseFieldInput('NUMBER', 'abc')).toBeUndefined()
    expect(parseFieldInput('NUMBER', '')).toBeNull()
    expect(parseFieldInput('DATE', '2026-10-31')).toEqual({ date: '2026-10-31' })
    expect(parseFieldInput('DATE', '10/31/2026')).toBeUndefined()
    expect(parseFieldInput('TEXT', '  hi ')).toEqual({ text: 'hi' })
    expect(parseFieldInput('TEXT', '   ')).toBeNull()
  })

  it('reorders like updateProjectV2ItemPosition', () => {
    const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).join('')
    const xs = [item('a'), item('b'), item('c'), item('d')]
    expect(ids(reorderItems(xs, 'd', 'a'))).toBe('adbc')
    expect(ids(reorderItems(xs, 'a', 'c'))).toBe('bcad')
    expect(ids(reorderItems(xs, 'c', null))).toBe('cabd')
    expect(ids(reorderItems(xs, 'c', 'missing'))).toBe('abcd')
  })

  it('updates, clears and removes items without touching the others', () => {
    const m: ProjectModel = { id: 'P', title: '', url: '', viewerCanUpdate: true, fields: [], views: [], items: [item('a', 'x'), item('b')], total: 2, repository: { id: 'R', nameWithOwner: 'o/r' } }
    expect(withFieldValue(m, 'b', 'S', { singleSelectOptionId: 'y' }).items.map((i) => i.values)).toEqual([{ S: { singleSelectOptionId: 'x' } }, { S: { singleSelectOptionId: 'y' } }])
    expect(withFieldValue(m, 'a', 'S', null).items[0].values).toEqual({})
    expect(m.items[0].values).toEqual({ S: { singleSelectOptionId: 'x' } })
    expect(withoutItem(m, 'a')).toMatchObject({ items: [{ id: 'b' }], total: 1 })
  })
})

describe('planBoardMove', () => {
  // Project order a b c d e; columns: todo = a c e, done = b d.
  const items = [item('a', 'todo'), item('b', 'done'), item('c', 'todo'), item('d', 'done'), item('e', 'todo')]

  it('reorders within a column after the card above the drop point', () => {
    expect(planBoardMove(items, 'S', 'e', 'todo', 1)).toEqual({ itemId: 'e', toColumn: 'todo', afterId: 'a', statusChange: false, reorder: true })
    expect(planBoardMove(items, 'S', 'c', 'todo', 0)).toEqual({ itemId: 'c', toColumn: 'todo', afterId: null, statusChange: false, reorder: true })
  })

  it('is a no-op when the card is dropped where it already is', () => {
    expect(planBoardMove(items, 'S', 'c', 'todo', 1)).toBeNull()
    expect(planBoardMove(items, 'S', 'missing', 'todo', 0)).toBeNull()
  })

  it('changes the status, and the position only when the card would land elsewhere', () => {
    // c lands between b and d in done, which project order already gives it.
    expect(planBoardMove(items, 'S', 'c', 'done', 1)).toEqual({ itemId: 'c', toColumn: 'done', afterId: 'b', statusChange: true, reorder: false })
    expect(planBoardMove(items, 'S', 'a', 'done', 2)).toEqual({ itemId: 'a', toColumn: 'done', afterId: 'd', statusChange: true, reorder: true })
    expect(planBoardMove(items, 'S', 'b', null, 0)).toEqual({ itemId: 'b', toColumn: null, afterId: null, statusChange: true, reorder: false })
    // Indexes past the end clamp to the bottom of the column.
    expect(planBoardMove(items, 'S', 'a', 'done', 99)?.afterId).toBe('d')
  })

  it('applies a move to the model for the optimistic update', () => {
    const m: ProjectModel = { id: 'P', title: '', url: '', viewerCanUpdate: true, fields: [], views: [], items, total: 5, repository: null }
    const move = planBoardMove(items, 'S', 'a', 'done', 2)!
    const next = applyBoardMove(m, 'S', move)
    expect(next.items.map((i) => i.id).join('')).toBe('bcdae')
    expect(next.items.find((i) => i.id === 'a')!.values.S).toEqual({ singleSelectOptionId: 'done' })
  })
})

describe('helpers', () => {
  it('recognizes INSUFFICIENT_SCOPES errors', () => {
    expect(isScopeError({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'x' }], message: 'Request failed' })).toBe(true)
    expect(isScopeError(new Error("Your token has not been granted the required scopes to execute this query. The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project']"))).toBe(true)
    // A fine-grained token without the Projects permission.
    expect(isScopeError({ errors: [{ type: 'FORBIDDEN' }], message: 'Resource not accessible by personal access token' })).toBe(true)
    expect(isScopeError({ errors: [{ type: 'NOT_FOUND' }], message: 'Could not resolve to a node' })).toBe(false)
    expect(isScopeError(null)).toBe(false)
  })

  it('parses pasted issue and pull request URLs for the signed-in host', () => {
    expect(parseItemUrl('https://github.com/o/r/issues/12')).toEqual({ owner: 'o', repo: 'r', number: 12 })
    expect(parseItemUrl(' https://github.com/o/r/pull/3/files ')).toEqual({ owner: 'o', repo: 'r', number: 3 })
    expect(parseItemUrl('https://ghe.example.com/o/r/pull/3', 'ghe.example.com')).toEqual({ owner: 'o', repo: 'r', number: 3 })
    expect(parseItemUrl('https://example.com/o/r/issues/1')).toBeNull()
    expect(parseItemUrl('Fix the issues/1 page')).toBeNull()
  })
})

describe('"Add item" lookups', () => {
  const pr = (id: string, number: number, title: string): AddableItem => ({ __typename: 'PullRequest', id, number, title, state: 'OPEN', isDraft: false })

  it('searches recent items and the typed text in one query, plus the number when it is one', async () => {
    const { octokit, graphql } = fakeOctokit({ recent: { nodes: [pr('A', 1, 'Add multiply()'), {}] }, found: { nodes: [] } })
    expect((await searchAddableItems(octokit, { kind: 'repo', owner: 'o', repo: 'r' }, 'mult')).map((i) => i.id)).toEqual(['A'])
    expect(graphql.mock.calls[0][1]).toEqual({ recent: 'repo:o/r sort:updated-desc', q: 'repo:o/r mult sort:updated-desc' })

    const n = fakeOctokit({ recent: { nodes: [] }, found: { nodes: [] } }, { repository: { issueOrPullRequest: pr('B', 12, 'Old') } })
    expect((await searchAddableItems(n.octokit, { kind: 'repo', owner: 'o', repo: 'r' }, '12')).map((i) => i.id)).toEqual(['B'])
    expect(n.graphql.mock.calls[1][1]).toEqual({ owner: 'o', repo: 'r', number: 12 })
  })

  it("searches across the owner's repositories on an organization's or user's project, with no number lookup", async () => {
    const org = fakeOctokit({ recent: { nodes: [] }, found: { nodes: [pr('A', 12, 'Fix login')] } })
    expect((await searchAddableItems(org.octokit, { kind: 'org', owner: 'acme' }, '12')).map((i) => i.id)).toEqual(['A'])
    expect(org.graphql.mock.calls).toHaveLength(1)
    expect(org.graphql.mock.calls[0][1]).toEqual({ recent: 'org:acme sort:updated-desc', q: 'org:acme 12 sort:updated-desc' })

    const user = fakeOctokit({ recent: { nodes: [] }, found: { nodes: [] } })
    await searchAddableItems(user.octokit, { kind: 'user', owner: 'octocat' }, '')
    expect(user.graphql.mock.calls[0][1]).toEqual({ recent: 'user:octocat sort:updated-desc', q: 'user:octocat sort:updated-desc' })
  })

  it('lists an exact number first, then title or number prefix matches, then search hits, once each', () => {
    const recent = [pr('A', 1, 'Add multiply()'), pr('B', 12, 'Fix login'), pr('C', 3, 'Docs')]
    expect(mergeAddable('MULT', recent, [pr('D', 9, 'Multiplication table'), pr('A', 1, 'Add multiply()')], null).map((i) => i.id)).toEqual(['A', 'D'])
    expect(mergeAddable('1', recent, [], pr('A', 1, 'Add multiply()')).map((i) => i.id)).toEqual(['A', 'B'])
    expect(mergeAddable('', recent, [pr('D', 9, 'x')], null).map((i) => i.id)).toEqual(['A', 'B', 'C'])
  })

  it('offers this repository first for "Convert to issue", skipping duplicates and repos without issues', () => {
    const current = { id: 'R1', nameWithOwner: 'o/r' }
    expect(
      convertTargets(current, [{ id: 'R2', nameWithOwner: 'o/linked', hasIssuesEnabled: true }], [
        { id: 'R1', nameWithOwner: 'o/r', hasIssuesEnabled: true },
        { id: 'R3', nameWithOwner: 'o/no-issues', hasIssuesEnabled: false },
        { id: 'R2', nameWithOwner: 'o/linked', hasIssuesEnabled: true },
      ]).map((r) => r.nameWithOwner),
    ).toEqual(['o/r', 'o/linked'])
    // An organization's or user's project page has no repository of its own to put first.
    expect(convertTargets(null, [{ id: 'R2', nameWithOwner: 'o/linked', hasIssuesEnabled: true }]).map((r) => r.nameWithOwner)).toEqual(['o/linked'])
  })
})

describe('project scopes', () => {
  it('uses the paths github.com has for a project and its views', () => {
    expect(projectPath({ kind: 'repo', owner: 'o', repo: 'r' }, 3)).toBe('/o/r/projects/3')
    expect(projectPath({ kind: 'org', owner: 'acme' }, 3, 2)).toBe('/orgs/acme/projects/3/views/2')
    expect(projectPath({ kind: 'user', owner: 'octocat' }, 1)).toBe('/users/octocat/projects/1')
  })

  it('asks the repository or the owner for the project', async () => {
    const repo = fakeOctokit(RAW)
    expect((await fetchProject(repo.octokit, { kind: 'repo', owner: 'o', repo: 'r' }, 1))?.title).toBe('Roadmap')
    expect(repo.graphql.mock.calls[0]).toEqual([PROJECT_QUERY, { owner: 'o', repo: 'r', number: 1 }])

    const org = fakeOctokit({ repositoryOwner: { projectV2: RAW.repository!.projectV2 } })
    expect((await fetchProject(org.octokit, { kind: 'org', owner: 'acme' }, 7))?.repository).toBeNull()
    expect(org.graphql.mock.calls[0]).toEqual([OWNER_PROJECT_QUERY, { owner: 'acme', number: 7 }])
  })
})

describe('project items', () => {
  const page = (ids: string[], endCursor: string | null, totalCount = 3) => ({
    node: { items: { totalCount, pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: ids.map((id) => ({ id, type: 'ISSUE', fieldValues: { nodes: [] }, content: null })) } },
  })

  it("sends the view's filter to GitHub and follows the pages", async () => {
    const { octokit, graphql } = fakeOctokit(page(['a', 'b'], 'c1'), page(['c'], null))
    const res = await fetchProjectItems(octokit, 'PVT_1', [], ' assignee:octocat is:open ')
    expect(res.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(res.total).toBe(3)
    expect(graphql.mock.calls.map((c) => c[1])).toEqual([
      { id: 'PVT_1', after: null, filter: 'assignee:octocat is:open' },
      { id: 'PVT_1', after: 'c1', filter: 'assignee:octocat is:open' },
    ])
    // octokit rejects a variable called "query": the document must not declare one.
    expect(ITEMS_QUERY).not.toContain('$query')
  })

  it('asks for every item when there is no filter, and stops at the cap', async () => {
    const all = fakeOctokit(page(['a'], null, 1))
    await fetchProjectItems(all.octokit, 'PVT_1', [])
    expect(all.graphql.mock.calls[0][1]).toEqual({ id: 'PVT_1', after: null, filter: null })

    const hundred = Array.from({ length: 100 }, (_, i) => `i${i}`)
    const many = fakeOctokit(...Array.from({ length: 12 }, (_, i) => page(hundred, `c${i}`, 5000)))
    const res = await fetchProjectItems(many.octokit, 'PVT_1', [])
    expect(res.items).toHaveLength(1000)
    expect(res.total).toBe(5000)
    expect(many.graphql.mock.calls).toHaveLength(10)

    // A node id that is not a project.
    expect(await fetchProjectItems(fakeOctokit({ node: {} }).octokit, 'X', [])).toEqual({ items: [], total: 0 })
  })
})

describe('project views', () => {
  const m = normalizeProject(RAW)!
  const items = normalizeItems(RAW_ITEMS, m.fields)
  const field = (id: string) => m.fields.find((f) => f.id === id)!
  const ids = (xs: ProjectItem[]) => xs.map((i) => i.id).join('')

  it('reads saved views with their filter, visible fields, sorting and grouping', () => {
    expect(m.views).toEqual([
      {
        id: 'V_1',
        number: 1,
        name: 'Backlog',
        layout: 'TABLE_LAYOUT',
        filter: 'assignee:octocat is:open',
        fieldIds: ['F_title', 'F_labels', 'F_status', 'F_assignees'],
        sortBy: [{ fieldId: 'F_est', direction: 'DESC' }],
        groupBy: ['F_status'],
        columnBy: [],
      },
      { id: 'V_2', number: 4, name: 'Board', layout: 'BOARD_LAYOUT', filter: '', fieldIds: [], sortBy: [], groupBy: [], columnBy: ['F_prio'] },
    ])
  })

  it('shows the view with the number in the path, else the first', () => {
    expect(pickView(m.views, 4)?.name).toBe('Board')
    expect(pickView(m.views, 99)?.name).toBe('Backlog')
    expect(pickView(m.views)?.name).toBe('Backlog')
    expect(pickView([], 1)).toBeUndefined()
  })

  it("lists the view's visible fields as columns, in its order, without the title or unsupported types", () => {
    expect(viewColumns(m.fields, m.views[0]).map((f) => f.name)).toEqual(['Labels', 'Status', 'Assignees'])
    // A view that names no fields shows every field the table can.
    expect(viewColumns(m.fields, m.views[1]).map((f) => f.id)).toEqual(['F_assignees', 'F_labels', 'F_pulls', 'F_reviewers', 'F_milestone', 'F_repo', 'F_status', 'F_est', 'F_prio', 'F_iter'])
    expect(viewColumns(m.fields).map((f) => f.id)).not.toContain('F_tracks')
  })

  it("takes the board's columns from the view's column field, else Status", () => {
    expect(columnFieldOf(m, m.views[1])?.id).toBe('F_prio')
    expect(columnFieldOf(m, m.views[0])?.id).toBe('F_status')
    expect(columnFieldOf(m)?.id).toBe('F_status')
  })

  it("sorts by the view's fields: numbers as numbers, selects by option order, empty values last", () => {
    expect(ids(sortItems(items, m.fields, []))).toBe('ABC')
    expect(ids(sortItems(items, m.fields, [{ fieldId: 'F_est', direction: 'DESC' }]))).toBe('BAC')
    expect(ids(sortItems(items, m.fields, [{ fieldId: 'F_est', direction: 'ASC' }]))).toBe('ABC')
    expect(ids(sortItems(items, m.fields, [{ fieldId: 'F_status', direction: 'DESC' }]))).toBe('BAC')
    expect(ids(sortItems(items, m.fields, [{ fieldId: 'F_title', direction: 'DESC' }]))).toBe('BAC')
    expect(ids(sortItems(items, m.fields, [{ fieldId: 'F_assignees', direction: 'ASC' }]))).toBe('BAC')
    // A field the project no longer has is skipped; ties fall through to the next field.
    expect(ids(sortItems(items, m.fields, [{ fieldId: 'gone', direction: 'ASC' }, { fieldId: 'F_prio', direction: 'ASC' }, { fieldId: 'F_est', direction: 'DESC' }]))).toBe('BAC')
    const ten = [
      { ...items[0], id: 'x', values: { F_est: { number: 10 } } },
      { ...items[0], id: 'y', values: { F_est: { number: 9 } } },
    ]
    expect(ids(sortItems(ten, m.fields, [{ fieldId: 'F_est', direction: 'ASC' }]))).toBe('yx')
  })

  it('groups by a field: options in their order, other values as they appear, items without one last', () => {
    expect(groupItems(items, field('F_status')).map((g) => [g.label, g.color, ids(g.items)])).toEqual([
      ['Todo', 'GREEN', 'A'],
      ['Done', 'PURPLE', 'B'],
      ['No Status', undefined, 'C'],
    ])
    expect(groupItems(items, field('F_assignees')).map((g) => [g.key, ids(g.items)])).toEqual([
      ['octocat, hubot', 'B'],
      ['', 'AC'],
    ])
    expect(groupItems([], field('F_status'))).toEqual([])
  })

  it('creates, updates and deletes views with their inputs', async () => {
    const { octokit, graphql } = fakeOctokit({ createProjectV2View: { projectV2View: { id: 'V_9', number: 9 } } }, {}, {}, {})
    expect(await createProjectView(octokit, 'PVT_1', 'View 3', 'BOARD_LAYOUT')).toEqual({ id: 'V_9', number: 9 })
    await updateProjectView(octokit, 'V_9', { filter: 'is:open' })
    await updateProjectView(octokit, 'V_9', { name: 'Mine', layout: 'TABLE_LAYOUT' })
    await deleteProjectView(octokit, 'V_9')
    expect(sent(graphql)).toEqual([
      ['createProjectV2View', { input: { projectId: 'PVT_1', name: 'View 3', layout: 'BOARD_LAYOUT' } }],
      ['updateProjectV2View', { input: { viewId: 'V_9', filter: 'is:open' } }],
      ['updateProjectV2View', { input: { viewId: 'V_9', name: 'Mine', layout: 'TABLE_LAYOUT' } }],
      ['deleteProjectV2View', { input: { viewId: 'V_9' } }],
    ])
  })

  it('applies a saved change to the view, and names new views', () => {
    const next = withViewChanges(m, 'V_1', { filter: 'is:open', layout: 'BOARD_LAYOUT' })
    expect(next.views[0]).toMatchObject({ name: 'Backlog', filter: 'is:open', layout: 'BOARD_LAYOUT' })
    expect(next.views[1]).toBe(m.views[1])
    expect(m.views[0].filter).toBe('assignee:octocat is:open')
    expect(newViewName(m.views)).toBe('View 3')
    expect(newViewName([{ name: 'view 2' }])).toBe('View 3')
    expect(newViewName([])).toBe('View 1')
  })
})
