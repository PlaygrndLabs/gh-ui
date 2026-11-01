import { describe, expect, it, vi } from 'vitest'
import { hunkIndexOf, hunkSlice, parsePatch, rangeContains, selectLines, sideLabel } from './diff'
import {
  applySuggestionEdits,
  decodeFileBytes,
  defaultSuggestionTitle,
  editsOverlap,
  hunkRange,
  hunkSide,
  insertSuggestion,
  parseSuggestions,
  suggestionBlock,
  suggestionCommitMessage,
  suggestionState,
  withSuggestion,
  type SuggestionSource,
} from './suggestions'
import { TOOLS_BY_NAME, inlineComment, type ToolContext } from './agent/tools'

const PATCH = '@@ -1,3 +1,7 @@\n export function add(a, b) {\n   return a + b\n }\n+\n+export function multiply(a, b) {\n+  return a + b\n+}\n@@ -20,3 +24,3 @@\n x\n-old\n+new\n z'

describe('line selection', () => {
  const lines = parsePatch(PATCH)
  it('selects one line, extends on shift-click from the first line, either direction', () => {
    const one = selectLines(lines, null, 'RIGHT', 6, false)
    expect(one).toEqual({ side: 'RIGHT', anchor: 6, start: 6, end: 6 })
    expect(selectLines(lines, one, 'RIGHT', 4, true)).toEqual({ side: 'RIGHT', anchor: 6, start: 4, end: 6 })
    expect(selectLines(lines, selectLines(lines, one, 'RIGHT', 4, true), 'RIGHT', 7, true)).toEqual({ side: 'RIGHT', anchor: 6, start: 6, end: 7 })
  })
  it('starts over instead of spanning sides or hunks', () => {
    const one = selectLines(lines, null, 'RIGHT', 6, false)
    expect(selectLines(lines, one, 'LEFT', 21, true)).toEqual({ side: 'LEFT', anchor: 21, start: 21, end: 21 })
    expect(selectLines(lines, one, 'RIGHT', 25, true)).toEqual({ side: 'RIGHT', anchor: 25, start: 25, end: 25 })
    expect(hunkIndexOf(lines, 'RIGHT', 6)).toBe(0)
    expect(hunkIndexOf(lines, 'RIGHT', 25)).toBe(1)
    expect(hunkIndexOf(lines, 'LEFT', 99)).toBe(-1)
  })
  it('matches lines by side, and labels them as github.com does', () => {
    expect(rangeContains({ side: 'RIGHT', start: 4, end: 7 }, 'RIGHT', 5)).toBe(true)
    expect(rangeContains({ side: 'RIGHT', start: 4, end: 7 }, 'LEFT', 5)).toBe(false)
    expect(rangeContains(null, 'RIGHT', 5)).toBe(false)
    expect(sideLabel('RIGHT', 12)).toBe('+12')
    expect(sideLabel('LEFT', 12)).toBe('-12')
  })
  it('slices a hunk to a multi-line comment', () => {
    expect(hunkSlice(PATCH, 'RIGHT', 5, 'RIGHT', 7)?.map((l) => l.content)).toEqual(['export function multiply(a, b) {', '  return a + b', '}'])
    expect(hunkSlice(PATCH, 'RIGHT', 50, 'RIGHT', 51)).toBeNull()
  })
})

describe('parseSuggestions', () => {
  it('reads each suggestion block, including empty ones and longer fences', () => {
    expect(parseSuggestions('Fix:\n\n```suggestion\n  return a * b\n```\n')).toEqual([['  return a * b']])
    expect(parseSuggestions('```suggestion\r\na\r\nb\r\n```')).toEqual([['a', 'b']])
    expect(parseSuggestions('```suggestion\n```')).toEqual([[]])
    expect(parseSuggestions('````suggestion\n```js\nx\n```\n````')).toEqual([['```js', 'x', '```']])
    expect(parseSuggestions('~~~suggestion\nx\n~~~\n\n```suggestion\ny\n```')).toEqual([['x'], ['y']])
  })
  it('ignores suggestion blocks quoted inside other code and other languages', () => {
    expect(parseSuggestions('````md\n```suggestion\nx\n```\n````')).toEqual([])
    expect(parseSuggestions('```diff\n-a\n+b\n```')).toEqual([])
    expect(parseSuggestions(null)).toEqual([])
  })
})

describe('suggestion text', () => {
  it('fences blocks longer than any fence inside them', () => {
    expect(suggestionBlock(['x'])).toBe('```suggestion\nx\n```')
    expect(suggestionBlock(['```js', 'x', '```'])).toBe('````suggestion\n```js\nx\n```\n````')
  })
  it('appends a suggestion to a body; an empty string suggests deleting the lines', () => {
    expect(withSuggestion('Use *', '  return a * b\n')).toBe('Use *\n\n```suggestion\n  return a * b\n```')
    expect(withSuggestion('', '')).toBe('```suggestion\n```')
    expect(withSuggestion('No change', undefined)).toBe('No change')
  })
  it('inserts a block on its own lines at the cursor and puts the cursor after the code', () => {
    const r = insertSuggestion('Try this', 8, 8, ['a', 'b'])
    expect(r.text).toBe('Try this\n```suggestion\na\nb\n```\n')
    expect(r.text.slice(0, r.cursor)).toBe('Try this\n```suggestion\na\nb')
    const empty = insertSuggestion('', 0, 0, ['x'])
    expect(empty.text).toBe('```suggestion\nx\n```\n')
    expect(insertSuggestion('a SEL b', 2, 5, ['x']).text).toBe('a \n```suggestion\nx\n```\n b')
  })
})

describe('diff hunks of review comments', () => {
  it('tells the side from the last hunk line and reads line ranges', () => {
    expect(hunkSide('@@ -1,2 +1,2 @@\n a\n-b')).toBe('LEFT')
    expect(hunkSide(PATCH.split('\n@@ -20')[0])).toBe('RIGHT')
    expect(hunkRange(PATCH, 'RIGHT', 6, 7)).toEqual(['  return a + b', '}'])
    expect(hunkRange(PATCH, 'LEFT', 21, 21)).toEqual(['old'])
    expect(hunkRange(PATCH, 'RIGHT', 8, 9)).toBeNull()
  })
})

describe('applySuggestionEdits', () => {
  const file = 'a\nb\nc\nd\ne\n'
  it('applies several suggestions bottom-up and keeps the final newline', () => {
    const out = applySuggestionEdits(file, [
      { path: 'f', startLine: 1, endLine: 1, expected: ['a'], replacement: ['A1', 'A2'] },
      { path: 'f', startLine: 3, endLine: 4, expected: ['c', 'd'], replacement: ['CD'] },
    ])
    expect(out).toEqual({ text: 'A1\nA2\nb\nCD\ne\n' })
  })
  it('deletes lines for an empty suggestion and keeps CRLF line endings', () => {
    expect(applySuggestionEdits('a\r\nb\r\nc', [{ path: 'f', startLine: 2, endLine: 2, expected: ['b'], replacement: [] }])).toEqual({ text: 'a\r\nc' })
  })
  it('refuses lines that changed and overlapping suggestions', () => {
    expect(applySuggestionEdits(file, [{ path: 'f', startLine: 2, endLine: 2, expected: ['x'], replacement: ['y'] }])).toEqual({ error: "f changed at line 2 since the suggestion was made, so it can't be applied." })
    expect(applySuggestionEdits(file, [{ path: 'f', startLine: 5, endLine: 6, expected: ['e', ''], replacement: ['y'] }])).toHaveProperty('error')
    const overlap = applySuggestionEdits(file, [
      { path: 'f', startLine: 1, endLine: 2, expected: ['a', 'b'], replacement: ['x'] },
      { path: 'f', startLine: 2, endLine: 3, expected: ['b', 'c'], replacement: ['y'] },
    ])
    expect(overlap).toHaveProperty('error')
    expect(editsOverlap({ path: 'f', startLine: 1, endLine: 2, expected: [], replacement: [] }, { path: 'f', startLine: 2, endLine: 2, expected: [], replacement: [] })).toBe(true)
    expect(editsOverlap({ path: 'f', startLine: 1, endLine: 2, expected: [], replacement: [] }, { path: 'g', startLine: 2, endLine: 2, expected: [], replacement: [] })).toBe(false)
  })
})

describe('suggestionState', () => {
  const hunk = PATCH.split('\n@@ -20')[0]
  const base: SuggestionSource = {
    body: 'Use *\n```suggestion\n  return a * b\n```',
    path: 'src/math.js',
    side: 'RIGHT',
    line: 6,
    startLine: null,
    originalLine: 6,
    originalStartLine: null,
    diffHunk: hunk,
  }
  const open = { prOpen: true, outdated: false }
  it('returns the edit for an applicable suggestion, at the current lines', () => {
    expect(suggestionState(base, open)).toEqual({ ok: true, edit: { path: 'src/math.js', startLine: 6, endLine: 6, expected: ['  return a + b'], replacement: ['  return a * b'] } })
    // The thread moved down two lines since it was written.
    const moved = suggestionState({ ...base, line: 8, startLine: 7, originalLine: 6, originalStartLine: 5, body: '```suggestion\nx\ny\n```' }, { ...open, currentLine: (n) => ({ 7: 'export function multiply(a, b) {', 8: '  return a + b' })[n] })
    expect(moved).toMatchObject({ ok: true, edit: { startLine: 7, endLine: 8, expected: ['export function multiply(a, b) {', '  return a + b'], replacement: ['x', 'y'] } })
  })
  it("gives github.com's reasons when it can't be applied", () => {
    const reason = (s: ReturnType<typeof suggestionState>) => (s && !s.ok ? s.reason : null)
    expect(suggestionState({ ...base, body: 'no suggestion' }, open)).toBeNull()
    expect(reason(suggestionState(base, { ...open, pending: true }))).toBe('Suggestions cannot be applied from pending reviews.')
    expect(reason(suggestionState(base, { ...open, prOpen: false }))).toBe('Suggestions cannot be applied while the pull request is closed.')
    expect(reason(suggestionState(base, { ...open, outdated: true }))).toBe('Outdated suggestions cannot be applied.')
    expect(reason(suggestionState({ ...base, line: null }, open))).toBe('Outdated suggestions cannot be applied.')
    expect(reason(suggestionState(base, { ...open, currentLine: () => '  return a - b' }))).toBe('Outdated suggestions cannot be applied.')
    expect(reason(suggestionState({ ...base, side: 'LEFT' }, open))).toBe('Applying suggestions on deleted lines is not supported.')
    expect(reason(suggestionState({ ...base, body: '```suggestion\n  return a + b\n```' }, open))).toBe('This suggestion is invalid because no changes were made to the code.')
    expect(reason(suggestionState(base, { ...open, resolved: true }))).toBe('This suggestion has been applied or marked resolved.')
  })
})

describe('suggestion commits', () => {
  it('titles one suggestion after its author and a batch after the review', () => {
    expect(defaultSuggestionTitle(['coderabbitai[bot]'])).toBe('Apply suggestion from @coderabbitai[bot]')
    expect(defaultSuggestionTitle(['a', 'a'])).toBe('Apply suggestions from code review')
  })
  it('credits each other suggester once as a co-author', () => {
    const msg = suggestionCommitMessage({
      title: 'Apply suggestions from code review',
      description: 'Both fixes.',
      authors: [
        { login: 'coderabbitai[bot]', id: 136622811 },
        { login: 'devbymak', id: 1 },
        { login: 'coderabbitai[bot]', id: 136622811 },
      ],
      viewerLogin: 'DevByMak',
      host: 'github.com',
    })
    expect(msg).toBe('Apply suggestions from code review\n\nBoth fixes.\n\nCo-authored-by: coderabbitai[bot] <136622811+coderabbitai[bot]@users.noreply.github.com>')
    expect(suggestionCommitMessage({ title: 'T', authors: [{ login: 'x', id: 2 }], viewerLogin: 'me', host: 'ghe.example.com' })).toBe('T\n\nCo-authored-by: x <2+x@users.noreply.ghe.example.com>')
  })
})

describe('agent review comment tools', () => {
  it('sends start_line/start_side only for a real range and appends the suggestion block', () => {
    expect(inlineComment({ path: 'a.ts', line: 7, start_line: 5, body: 'Simplify', suggestion: 'x\ny' })).toEqual({
      path: 'a.ts',
      line: 7,
      side: 'RIGHT',
      start_line: 5,
      start_side: 'RIGHT',
      body: 'Simplify\n\n```suggestion\nx\ny\n```',
    })
    expect(inlineComment({ path: 'a.ts', line: 7, start_line: 7, side: 'LEFT', body: 'Why?' })).toEqual({ path: 'a.ts', line: 7, side: 'LEFT', body: 'Why?' })
  })

  it('posts a multi-line suggestion comment at the head commit, and explains a pending-review conflict', async () => {
    const createReviewComment = vi.fn(async (args: Record<string, unknown>) => ({ data: { id: 1, html_url: 'u', start_line: args.start_line, line: args.line } }))
    const pulls = { get: vi.fn(async () => ({ data: { head: { sha: 'abc' } } })), createReviewComment }
    const ctx = { octokit: { rest: { pulls } }, account: {} } as unknown as ToolContext
    const tool = TOOLS_BY_NAME.get('add_review_comment')!
    expect(tool.kind).toBe('write')
    const out = await tool.run({ owner: 'o', repo: 'r', number: 1, path: 'src/math.js', start_line: 6, line: 7, body: 'Product', suggestion: '  return a * b\n}' }, ctx)
    expect(out).toEqual({ id: 1, url: 'u', start_line: 6, line: 7 })
    expect(createReviewComment.mock.calls[0][0]).toMatchObject({ commit_id: 'abc', start_line: 6, start_side: 'RIGHT', line: 7, side: 'RIGHT', body: 'Product\n\n```suggestion\n  return a * b\n}\n```' })
    expect(tool.summarize({ owner: 'o', repo: 'r', number: 1, path: 'src/math.js', start_line: 6, line: 7, body: '', suggestion: 'x' })).toBe('Comment on src/math.js:6-7 with a suggestion')

    createReviewComment.mockRejectedValueOnce({ response: { data: { message: 'Validation Failed', errors: [{ message: 'user_id can only have one pending review per pull request' }] } } })
    const conflict = (await tool.run({ owner: 'o', repo: 'r', number: 1, path: 'a', line: 1, body: 'x' }, ctx)) as { error: string }
    expect(conflict.error).toMatch(/pending\) review on this pull request/)
  })
})

describe('suggestion commits keep the file bytes', () => {
  it('keeps a byte order mark and matches line 1 without it', () => {
    const out = applySuggestionEdits('﻿a\r\nb\r\n', [{ path: 'f', startLine: 1, endLine: 1, expected: ['a'], replacement: ['A'] }])
    expect(out).toEqual({ text: '﻿A\r\nb\r\n' })
  })
  it('decodes UTF-8 with its BOM and refuses other encodings', () => {
    expect(decodeFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a')
    expect(decodeFileBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBeNull()
  })
})
