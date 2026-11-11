import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DiffView, findUnits, patchText } from '../components/DiffView'
import { parsePatch } from './diff'
import { matchesIn, queryRegExp } from './find'

// Primer's package imports CSS, which plain Node can't load; DiffView itself draws none of these.
vi.mock('@primer/react', () => ({ Avatar: () => null, Button: () => null, IconButton: () => null, Spinner: () => null, Tooltip: () => null }))

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' const a = 1 < 2 && "x"',
  '-let old = a',
  '+let fresh = a',
  '+let more = fresh',
  ' export { a }',
  '\\ No newline at end of file',
].join('\n')

/** The text of each code cell in DiffView's markup, the way a search on the drawn page reads it. */
function drawnUnits(split: boolean) {
  const html = renderToStaticMarkup(createElement(DiffView, { path: 'a.ts', lines: parsePatch(PATCH), split }))
  const cells = [...html.matchAll(/<td[^>]*data-find-unit=""[^>]*>(.*?)<\/td>/g)].map((m) => m[1])
  const decode = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
  return cells.map(decode).filter(Boolean)
}

describe('find', () => {
  it('matches the query literally, case-insensitive unless asked', () => {
    expect(matchesIn('a.b aXb A.B', queryRegExp('a.b'))).toEqual([
      [0, 3],
      [8, 11],
    ])
    expect(matchesIn('a.b A.B', queryRegExp('A.B', { caseSensitive: true }))).toEqual([[4, 7]])
    expect(matchesIn('aaaa', queryRegExp('aa'))).toEqual([
      [0, 2],
      [2, 4],
    ])
    expect(matchesIn('anything', queryRegExp(''))).toEqual([])
  })

  // An undrawn diff is searched as the units it would draw; going to a match there relies on both counting the same.
  it.each([false, true])('searches an undrawn diff as the drawn one reads (split: %s)', (split) => {
    expect(findUnits(parsePatch(PATCH), split).filter(Boolean)).toEqual(drawnUnits(split))
  })

  it('copies an undrawn file as git diff prints it', () => {
    expect(patchText({ path: 'src/b.ts', previousPath: 'src/a.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' })).toBe(
      ['diff --git a/src/a.ts b/src/b.ts', 'rename from src/a.ts', 'rename to src/b.ts', '--- a/src/a.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    )
    expect(patchText({ path: 'new.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+hi' }).split('\n').slice(1, 3)).toEqual(['--- /dev/null', '+++ b/new.txt'])
    expect(patchText({ path: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: null })).toContain('Binary files a/logo.png and b/logo.png differ')
  })
})
