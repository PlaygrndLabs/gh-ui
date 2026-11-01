import { describe, expect, it, vi } from 'vitest'
import type { Octokit } from '@octokit/rest'
import {
  addProjectItem,
  applyBoardMove,
  archiveProjectItem,
  convertDraftToIssue,
  convertTargets,
  deleteProjectItem,
  displayValue,
  formatProjectDate,
  isScopeError,
  iterationRange,
  mergeAddable,
  moveBoardItem,
  normalizeProject,
  parseFieldInput,
  parseItemUrl,
  planBoardMove,
  reorderItems,
  searchAddableItems,
  setItemField,
  setItemPosition,
  statusFieldOf,
  withFieldValue,
  withoutItem,
  type AddableItem,
  type ProjectItem,
  type ProjectModel,
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
          {
            __typename: 'ProjectV2IterationField',
            id: 'F_iter',
            name: 'Iteration',
            dataType: 'ITERATION',
            configuration: { iterations: [{ id: 'it2', title: 'Iteration 2', startDate: '2026-10-28', duration: 14 }], completedIterations: [{ id: 'it1', title: 'Iteration 1', startDate: '2026-10-14', duration: 14 }] },
          },
        ],
      },
      items: {
        totalCount: 2,
        nodes: [
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
          { id: 'B', type: 'ISSUE', fieldValues: { nodes: [{ __typename: 'ProjectV2ItemUserValue' }] }, content: null },
        ],
      },
    },
  },
}

function item(id: string, status?: string): ProjectItem {
  return { id, type: 'ISSUE', content: null, values: status ? { S: { singleSelectOptionId: status } } : {} }
}

describe('project model', () => {
  it('keeps editable field values by field id and skips the title', () => {
    const m = normalizeProject(RAW)!
    expect(m.items[0].values).toEqual({ F_status: { singleSelectOptionId: 'todo' }, F_est: { number: 0 }, F_iter: { iterationId: 'it1' } })
    expect(m.items[1].values).toEqual({})
    expect(m.fields.find((f) => f.id === 'F_iter')!.iterations!.map((i) => [i.id, i.completed])).toEqual([
      ['it2', false],
      ['it1', true],
    ])
    expect(statusFieldOf(m)?.id).toBe('F_status')
    expect(m.repository).toEqual({ id: 'R_1', nameWithOwner: 'o/r' })
    expect(normalizeProject({ repository: { id: 'R', nameWithOwner: 'o/r', projectV2: null } })).toBeNull()
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
    const m: ProjectModel = { id: 'P', title: '', url: '', viewerCanUpdate: true, fields: [], items: [item('a', 'x'), item('b')], total: 2, repository: { id: 'R', nameWithOwner: 'o/r' } }
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
    const m: ProjectModel = { id: 'P', title: '', url: '', viewerCanUpdate: true, fields: [], items, total: 5, repository: { id: 'R', nameWithOwner: 'o/r' } }
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
    expect((await searchAddableItems(octokit, 'o', 'r', 'mult')).map((i) => i.id)).toEqual(['A'])
    expect(graphql.mock.calls[0][1]).toEqual({ recent: 'repo:o/r sort:updated-desc', q: 'repo:o/r mult sort:updated-desc' })

    const n = fakeOctokit({ recent: { nodes: [] }, found: { nodes: [] } }, { repository: { issueOrPullRequest: pr('B', 12, 'Old') } })
    expect((await searchAddableItems(n.octokit, 'o', 'r', '12')).map((i) => i.id)).toEqual(['B'])
    expect(n.graphql.mock.calls[1][1]).toEqual({ owner: 'o', repo: 'r', number: 12 })
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
  })
})
