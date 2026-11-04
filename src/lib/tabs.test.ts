import { describe, expect, it } from 'vitest'
import { linkTarget, safeNextPath } from './links'
import {
  closeTab,
  cycleTab,
  dedupeRepoTabs,
  navigationTarget,
  repoKeyFromUrl,
  iconFromPath,
  initialTabs,
  MAX_CLOSED_TABS,
  moveTab,
  openNewTab,
  openTabNext,
  parseSavedTabs,
  recordNavigation,
  reopenClosedTab,
  safeTabPath,
  selectTab,
  selectTabNumber,
  serializeTabs,
  setTabTitle,
  setTabUrl,
  tabsToUnload,
  tabTitle,
  titleFromLink,
  titleFromPath,
  unloadTabs,
  type TabsState,
  focusOtherPane,
  openTabToSide,
  setSplitRatio,
  splitTab,
  toggleSplit,
  visibleTabs,
} from './tabs'

const ids = (s: TabsState) => s.tabs.map((t) => t.id)

function three(): TabsState {
  let s = initialTabs('a')
  s = openNewTab(s, 'b', '/o/r')
  s = openNewTab(s, 'c', '/o/other/pulls')
  return s
}

describe('opening tabs', () => {
  it('starts with one live dashboard tab', () => {
    expect(initialTabs('a')).toEqual({ tabs: [{ id: 'a', url: '/', title: null }], activeId: 'a', closed: [], live: ['a'], split: null, splitRatio: 0.5 })
  })

  it('a new tab goes last and becomes active', () => {
    const s = three()
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    expect(s.activeId).toBe('c')
    expect(s.live).toEqual(['c', 'b', 'a'])
  })

  it('background links line up in order next to the current tab, and do not mount', () => {
    let s = selectTab(three(), 'a')
    s = openTabNext(s, { id: 'x', url: '/o/r/pull/1', background: true })
    s = openTabNext(s, { id: 'y', url: '/o/r/pull/2', background: true })
    expect(ids(s)).toEqual(['a', 'x', 'y', 'b', 'c'])
    expect(s.activeId).toBe('a')
    expect(s.live).not.toContain('x')
  })

  it('a foreground link becomes active next to the current tab', () => {
    const s = openTabNext(selectTab(three(), 'a'), { id: 'x', url: '/o/r/pull/1' })
    expect(ids(s)).toEqual(['a', 'x', 'b', 'c'])
    expect(s.activeId).toBe('x')
    expect(s.live[0]).toBe('x')
  })

  it('never opens a tab outside the app or on the sign-in page', () => {
    for (const url of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '/..//evil.example', 'javascript:alert(1)', '/login', '/login?add=1']) {
      expect(openTabNext(initialTabs('a'), { id: 'x', url }).tabs[1].url).toBe('/')
    }
  })
})

describe('switching tabs', () => {
  it('selects by number, with 9 meaning the last tab', () => {
    const s = three()
    expect(selectTabNumber(s, 1).activeId).toBe('a')
    expect(selectTabNumber(s, 2).activeId).toBe('b')
    expect(selectTabNumber(s, 8).activeId).toBe('c')
    expect(selectTabNumber(selectTab(s, 'a'), 9).activeId).toBe('c')
  })

  it('cycles both ways and wraps', () => {
    const s = three()
    expect(cycleTab(s, 1).activeId).toBe('a')
    expect(cycleTab(s, -1).activeId).toBe('b')
    expect(cycleTab(selectTab(s, 'a'), -1).activeId).toBe('c')
  })

  it('ignores an unknown tab', () => {
    const s = three()
    expect(selectTab(s, 'nope')).toBe(s)
  })
})

describe('closing tabs', () => {
  it('moves to the right neighbour, or the left one at the end', () => {
    expect(closeTab(selectTab(three(), 'a'), 'a', 'f').activeId).toBe('b')
    expect(closeTab(three(), 'c', 'f').activeId).toBe('b')
  })

  it('closing a background tab keeps the active tab', () => {
    const s = closeTab(three(), 'a', 'f')
    expect(s.activeId).toBe('c')
    expect(ids(s)).toEqual(['b', 'c'])
    expect(s.live).toEqual(['c', 'b'])
  })

  it('the last tab leaves a fresh dashboard', () => {
    const s = closeTab(openNewTab(initialTabs('a'), 'b', '/o/r'), 'a', 'x')
    const last = closeTab(s, 'b', 'f')
    expect(last.tabs).toEqual([{ id: 'f', url: '/', title: null }])
    expect(last.activeId).toBe('f')
    expect(last.live).toEqual(['f'])
    expect(last.closed[0].url).toBe('/o/r')
  })

  it('closing a lone dashboard leaves nothing to reopen', () => {
    expect(closeTab(initialTabs('a'), 'a', 'f').closed).toEqual([])
  })

  it('reopens where it was, newest first, with its title', () => {
    let s = setTabTitle(three(), 'b', 'Repo')
    s = closeTab(s, 'b', 'f')
    s = closeTab(s, 'a', 'f')
    s = reopenClosedTab(s)
    expect(s.activeId).toBe('a')
    expect(ids(s)).toEqual(['a', 'c'])
    s = reopenClosedTab(s)
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    expect(s.tabs[1].title).toBe('Repo')
    expect(reopenClosedTab(s)).toBe(s)
  })

  it('keeps at least 10 closed tabs', () => {
    let s = initialTabs('a')
    for (let i = 0; i < MAX_CLOSED_TABS + 5; i++) {
      s = openNewTab(s, `t${i}`, `/o/r/pull/${i}`)
      s = closeTab(s, `t${i}`, 'f')
    }
    expect(MAX_CLOSED_TABS).toBeGreaterThanOrEqual(10)
    expect(s.closed.length).toBe(MAX_CLOSED_TABS)
    expect(s.closed[0].url).toBe(`/o/r/pull/${MAX_CLOSED_TABS + 4}`)
  })
})

describe('reordering', () => {
  it('moves a tab and clamps the target', () => {
    expect(ids(moveTab(three(), 'a', 2))).toEqual(['b', 'c', 'a'])
    expect(ids(moveTab(three(), 'c', 0))).toEqual(['c', 'a', 'b'])
    expect(ids(moveTab(three(), 'a', 99))).toEqual(['b', 'c', 'a'])
    const s = three()
    expect(moveTab(s, 'a', 0)).toBe(s)
  })
})

describe('urls and titles', () => {
  it('a new page clears the old title; a new query or hash keeps it', () => {
    let s = setTabTitle(initialTabs('a', '/o/r/pull/1'), 'a', '#1 Fix')
    s = setTabUrl(s, 'a', '/o/r/pull/1?x=1#y')
    expect(s.tabs[0].title).toBe('#1 Fix')
    s = setTabUrl(s, 'a', '/o/r/pull/1/files')
    expect(s.tabs[0].title).toBeNull()
  })

  it('does nothing when nothing changed', () => {
    const s = setTabTitle(initialTabs('a'), 'a', 'x')
    expect(setTabTitle(s, 'a', 'x')).toBe(s)
    expect(setTabUrl(s, 'a', '/')).toBe(s)
  })

  it('titles and icons come from the URL', () => {
    expect(titleFromPath('/')).toBe('New tab')
    expect(titleFromPath('/pulls?q=x')).toBe('Pull requests')
    expect(titleFromPath('/search?q=hello%20world')).toBe('Search: hello world')
    expect(titleFromPath('/octo')).toBe('octo')
    expect(titleFromPath('/octo/repo')).toBe('octo/repo')
    expect(titleFromPath('/octo/repo/pull/128/files')).toBe('#128')
    expect(titleFromPath('/octo/repo/issues/9')).toBe('#9')
    expect(titleFromPath('/octo/repo/actions/runs/55/job/1')).toBe('Run 55')
    expect(titleFromPath('/octo/repo/blob/main/src/a%20b.ts')).toBe('a b.ts')
    expect(titleFromPath('/octo/repo/commit/abcdef1234')).toBe('abcdef1')
    expect(titleFromPath('/octo/repo/pulls')).toBe('Pull requests · repo')
    expect(titleFromPath('/octo/repo/bad%zz')).toBe('bad%zz · repo')
    expect(iconFromPath('/')).toBe('home')
    expect(iconFromPath('/octo/repo')).toBe('repo')
    expect(iconFromPath('/octo/repo/pull/1')).toBe('pull')
    expect(iconFromPath('/octo/repo/issues/1')).toBe('issue')
    expect(iconFromPath('/octo/repo/actions/runs/1')).toBe('run')
    expect(iconFromPath('/octo')).toBe('person')
    expect(tabTitle({ url: '/octo', title: null })).toBe('octo')
    expect(tabTitle({ url: '/octo', title: 'Named' })).toBe('Named')
  })

  it('takes a title from a pull request or issue link', () => {
    expect(titleFromLink('/o/r/pull/128', ' Retry failed\n uploads ')).toBe('#128 Retry failed uploads')
    expect(titleFromLink('/o/r/issues/9', '#9')).toBeNull()
    expect(titleFromLink('/o/r/issues/9', 'fixes #9')).toBeNull()
    expect(titleFromLink('/o/r/pulls', 'Pulls')).toBeNull()
  })
})

describe('unloading', () => {
  const live = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

  it('leaves 8 or fewer alone', () => {
    expect(tabsToUnload(live.slice(0, 8), 'a', () => false)).toEqual([])
  })

  it('unloads the least recently used', () => {
    expect(tabsToUnload(live, 'a', () => false)).toEqual(['j', 'i'])
  })

  it('never unloads the active tab, or one that must stay', () => {
    expect(tabsToUnload(live, 'j', (id) => id === 'i')).toEqual(['h', 'g'])
    expect(tabsToUnload(live, 'a', () => true)).toEqual([])
  })

  it('an unloaded tab stops being live but stays open', () => {
    const s = unloadTabs(three(), ['a'])
    expect(s.live).toEqual(['c', 'b'])
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    expect(selectTab(s, 'a').live[0]).toBe('a')
  })
})

describe('per-tab history', () => {
  const start = { entries: [{ path: '/', key: 'k0' }], index: 0 }

  it('push truncates the forward entries', () => {
    let h = recordNavigation(start, 'PUSH', { path: '/a', key: 'k1' })
    h = recordNavigation(h, 'PUSH', { path: '/b', key: 'k2' })
    h = recordNavigation(h, 'POP', { path: '/', key: 'k0' })
    expect(h.index).toBe(0)
    h = recordNavigation(h, 'PUSH', { path: '/c', key: 'k3' })
    expect(h.entries.map((e) => e.path)).toEqual(['/', '/c'])
    expect(h.index).toBe(1)
  })

  it('replace keeps the position', () => {
    const h = recordNavigation(start, 'REPLACE', { path: '/r', key: 'k9' })
    expect(h).toEqual({ entries: [{ path: '/r', key: 'k9' }], index: 0 })
  })
})

describe('saved state', () => {
  it('round-trips through JSON, mounting only the active tab', () => {
    const s = setTabTitle(closeTab(three(), 'b', 'f'), 'a', 'Home')
    const back = parseSavedTabs(JSON.parse(JSON.stringify(serializeTabs(s))), 'fresh')
    expect(back.tabs).toEqual([{ id: 'a', url: '/', title: 'Home' }, { id: 'c', url: '/o/other/pulls', title: null }])
    expect(back.activeId).toBe('c')
    expect(back.live).toEqual(['c'])
    expect(back.closed).toEqual([{ id: 'b', url: '/o/r', title: null, index: 1 }])
  })

  it('anything corrupted falls back to one dashboard tab', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { tabs: 'x' }, { tabs: [] }, { tabs: [null, 1, { id: 'a' }, { url: '/' }, { id: '../x', url: '/' }, { id: 'a', url: '//evil.example' }, { id: 'b', url: 'https://evil.example/' }, { id: 'c', url: '/login' }] }]) {
      expect(parseSavedTabs(bad, 'fresh')).toEqual(initialTabs('fresh'))
    }
  })

  it('unsafe URLs, duplicates and bad fields drop out', () => {
    const s = parseSavedTabs(
      {
        tabs: [
          { id: 'bad', url: 'https://evil.example/' },
          { id: 'a', url: '/o', title: 5 },
          { id: 'a', url: '/dup' },
          { id: 'b', url: '//evil.example' },
          { id: 'c', url: '/login?next=/x' },
          { id: 'd', url: '/o/r', title: 'x'.repeat(500) },
        ],
        activeId: 'missing',
        closed: [{ id: 'a', url: '/dup' }, { id: 'e', url: 'javascript:alert(1)' }, { id: 'f', url: '/o/r/pull/1', index: -1 }, 7],
      },
      'fresh',
    )
    expect(s.tabs.map((t) => t.url)).toEqual(['/o', '/o/r'])
    expect(s.tabs[0].title).toBeNull()
    expect(s.tabs[1].title).toHaveLength(200)
    expect(s.activeId).toBe('a')
    expect(s.closed).toEqual([{ id: 'f', url: '/o/r/pull/1', title: null, index: 0 }])
  })

  it('keeps a URL that validation only tidies, in the tidied form', () => {
    const s = parseSavedTabs(
      { tabs: [{ id: 'a', url: "/search?q=what's%20new" }], activeId: 'a', closed: [{ id: 'b', url: "/search?q=don't", index: 0 }] },
      'fresh',
    )
    expect(s.tabs[0].url).toBe('/search?q=what%27s%20new')
    expect(s.closed[0].url).toBe('/search?q=don%27t')
    expect(setTabUrl(initialTabs('a'), 'a', "/search?q=don't").tabs[0].url).toBe('/search?q=don%27t')
  })

  it('safeTabPath keeps in-app paths whole', () => {
    expect(safeTabPath('/o/r/pull/1?x=1#y')).toBe('/o/r/pull/1?x=1#y')
    expect(safeTabPath(null)).toBe('/')
  })
})

describe('links opened in a new tab', () => {
  const host = 'github.com'
  const route = '/o/r/blob/main/docs/a.md'

  it('keeps in-app paths whole, including what appPathFromUrl would drop', () => {
    expect(linkTarget('/octo?tab=stars', host, route)).toEqual({ app: '/octo?tab=stars' })
    expect(linkTarget('/settings/agent', host, route)).toEqual({ app: '/settings/agent' })
  })

  it('reads an absolute path in rendered markdown as a page on GitHub, not an in-app route', () => {
    expect(linkTarget('/local?clone=o/r', host, route, true)).toEqual({ external: 'https://github.com/local?clone=o/r' })
    expect(linkTarget('/settings/agent', host, route, true)).toEqual({ external: 'https://github.com/settings/agent' })
    expect(linkTarget('/o/r/raw/main/a.md', host, route, true)).toEqual({ external: 'https://github.com/o/r/raw/main/a.md' })
    expect(linkTarget('/login', host, route, true)).toEqual({ external: 'https://github.com/login' })
    expect(linkTarget('/o/r/pull/3', host, route, true)).toEqual({ app: '/o/r/pull/3' })
  })

  it('maps GitHub URLs in, and resolves relative ones against the route', () => {
    expect(linkTarget('https://github.com/o/r/pull/3', host, route)).toEqual({ app: '/o/r/pull/3' })
    expect(linkTarget('b.md', host, route)).toEqual({ app: '/o/r/blob/main/docs/b.md' })
    expect(linkTarget('#top', host, route)).toEqual({ app: `${route}#top` })
  })

  it('sends everything else to the browser, or nowhere', () => {
    expect(linkTarget('https://example.com/x', host, route)).toEqual({ external: 'https://example.com/x' })
    expect(linkTarget('//example.com/x', host, route)).toEqual({ external: 'https://example.com/x' })
    expect(linkTarget('mailto:a@example.com', host, route)).toEqual({ external: 'mailto:a@example.com' })
    expect(linkTarget('javascript:alert(1)', host, route)).toBeNull()
  })

  it('an unsafe path resolves to the dashboard', () => {
    expect(linkTarget('/..//evil.example/x', host, route)).toEqual({ app: '/' })
    expect(safeNextPath('/..//evil.example/x')).toBe('/')
  })
})

describe('one tab per repository', () => {
  const state = (...urls: string[]): TabsState => ({ tabs: urls.map((url, i) => ({ id: `t${i}`, url, title: null })), activeId: 't0', closed: [], live: ['t0'], split: null, splitRatio: 0.5 })

  it('names the repository a page belongs to', () => {
    expect(repoKeyFromUrl('/Acme/Web/pull/2?x=1')).toBe('acme/web')
    expect(repoKeyFromUrl('/local/abc')).toBe('local/abc')
    for (const url of ['/', '/local', '/search?q=x', '/settings/agent', '/lena', '/orgs/acme/people', '/pulls']) expect(repoKeyFromUrl(url)).toBeNull()
  })

  it('titles a repository tab after the repository on every page', () => {
    expect(tabTitle({ url: '/acme/web/pull/2', title: '#2 Fix' })).toBe('web')
    expect(tabTitle({ url: '/local/abc', title: 'notes' })).toBe('notes')
    expect(tabTitle({ url: '/settings', title: null })).toBe('Settings')
  })

  it('keeps a repository’s pages in its tab', () => {
    expect(navigationTarget(state('/acme/web'), 't0', '/acme/web/pulls')).toEqual({ kind: 'stay' })
    expect(navigationTarget(state('/acme/web'), 't0', '/ACME/web/actions')).toEqual({ kind: 'stay' })
  })

  it('moves to another repository’s tab, or opens one', () => {
    const s = state('/acme/web', '/acme/api/pulls', '/search?q=a')
    expect(navigationTarget(s, 't0', '/acme/api')).toEqual({ kind: 'focus', id: 't1' })
    expect(navigationTarget(s, 't0', '/acme/docs')).toEqual({ kind: 'open' })
  })

  it('lets a tab on no repository become one, unless that repository has a tab', () => {
    expect(navigationTarget(state('/', '/acme/api'), 't0', '/acme/docs')).toEqual({ kind: 'stay' })
    expect(navigationTarget(state('/', '/acme/api'), 't0', '/acme/api/pulls')).toEqual({ kind: 'focus', id: 't1' })
    expect(navigationTarget(state('/search?q=a'), 't0', '/settings')).toEqual({ kind: 'stay' })
  })

  it('opens pages outside a repository in their own tab, reusing one on that page', () => {
    expect(navigationTarget(state('/acme/web'), 't0', '/settings')).toEqual({ kind: 'open' })
    expect(navigationTarget(state('/acme/web', '/settings'), 't0', '/settings/agent')).toEqual({ kind: 'open' })
    expect(navigationTarget(state('/acme/web', '/settings'), 't0', '/settings')).toEqual({ kind: 'focus', id: 't1' })
  })

  it('merges tabs saved before this rule, keeping the active repository active', () => {
    const s = { ...state('/acme/web', '/acme/web/pulls', '/', '/acme/api'), activeId: 't1', live: ['t1'] }
    const next = dedupeRepoTabs(s)
    expect(ids(next)).toEqual(['t0', 't2', 't3'])
    expect(next.activeId).toBe('t0')
    expect(next.live).toEqual(['t0'])
    expect(dedupeRepoTabs(state('/', '/acme/web'))).toEqual(state('/', '/acme/web'))
  })

  it('reopens to the repository’s tab when it has one again', () => {
    const s: TabsState = { ...state('/acme/web', '/acme/api'), closed: [{ id: 'old', url: '/acme/api/pulls', title: null, index: 0 }] }
    const next = reopenClosedTab(s)
    expect(ids(next)).toEqual(['t0', 't1'])
    expect(next.activeId).toBe('t1')
    expect(next.closed).toEqual([])
  })
})

describe('split view', () => {
  const three = () => {
    let s = initialTabs('a', '/one')
    s = openTabNext(s, { id: 'b', url: '/two', background: true })
    return openTabNext(s, { id: 'c', url: '/three', background: true })
  }

  it('opens a link beside the focused tab and focuses it', () => {
    const s = openTabToSide(initialTabs('a', '/one'), { id: 'b', url: '/two' })
    expect(s.split).toEqual(['a', 'b'])
    expect(s.activeId).toBe('b')
    expect(visibleTabs(s)).toEqual(['a', 'b'])
    expect(s.live).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('replaces the other pane, not the focused one, when already split', () => {
    const left = openTabToSide(selectTab(openTabToSide(initialTabs('a', '/one'), { id: 'b', url: '/two' }), 'a'), { id: 'c', url: '/three' })
    expect(left.split).toEqual(['a', 'c'])
    const right = openTabToSide(openTabToSide(initialTabs('a', '/one'), { id: 'b', url: '/two' }), { id: 'c', url: '/three' })
    expect(right.split).toEqual(['c', 'b'])
  })

  it('only moves focus for a tab on screen, and swaps the focused pane for one that is not', () => {
    const s = splitTab(three(), 'b')
    expect(s.split).toEqual(['a', 'b'])
    const focus = selectTab(s, 'a')
    expect(focus.split).toEqual(['a', 'b'])
    expect(focus.activeId).toBe('a')
    const swapped = selectTab(focus, 'c')
    expect(swapped.split).toEqual(['c', 'b'])
    expect(swapped.activeId).toBe('c')
  })

  it('puts a dragged tab on the side it was dropped', () => {
    expect(splitTab(three(), 'b', 'left').split).toEqual(['b', 'a'])
    expect(splitTab(three(), 'b', 'right').split).toEqual(['a', 'b'])
  })

  it('has nothing to split a lone tab with, unless the toggle makes a new one', () => {
    const lone = initialTabs('a', '/one')
    expect(splitTab(lone, 'a')).toBe(lone)
    const toggled = toggleSplit(lone, 'fresh')
    expect(toggled.split).toEqual(['a', 'fresh'])
    expect(toggled.tabs.find((t) => t.id === 'fresh')?.url).toBe('/')
  })

  it('toggles off keeping the focused tab, and back on with the last one used', () => {
    const on = toggleSplit(selectTab(selectTab(three(), 'c'), 'a'), 'x')
    expect(on.split).toEqual(['a', 'c'])
    expect(on.tabs).toHaveLength(3)
    const off = toggleSplit(on, 'x')
    expect(off.split).toBeNull()
    expect(off.activeId).toBe(on.activeId)
  })

  it('moves focus between panes', () => {
    const s = splitTab(three(), 'b')
    expect(focusOtherPane(s).activeId).toBe('a')
    expect(focusOtherPane(focusOtherPane(s)).activeId).toBe('b')
    const single = three()
    expect(focusOtherPane(single)).toBe(single)
  })

  it('closing a pane leaves the other filling the window', () => {
    const s = splitTab(three(), 'b')
    const closedFocused = closeTab(s, 'b', 'fresh')
    expect(closedFocused.split).toBeNull()
    expect(closedFocused.activeId).toBe('a')
    const closedOther = closeTab(s, 'a', 'fresh')
    expect(closedOther.split).toBeNull()
    expect(closedOther.activeId).toBe('b')
    const closedElsewhere = closeTab(s, 'c', 'fresh')
    expect(closedElsewhere.split).toEqual(['a', 'b'])
  })

  it('never unloads a tab on screen', () => {
    const s = splitTab(three(), 'b')
    expect(unloadTabs(s, ['a', 'b']).live).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('keeps the ratio within limits', () => {
    const s = initialTabs('a')
    expect(setSplitRatio(s, 0.01).splitRatio).toBe(0.25)
    expect(setSplitRatio(s, 0.99).splitRatio).toBe(0.75)
    expect(setSplitRatio(s, Number.NaN).splitRatio).toBe(0.5)
  })

  it('restores a saved split and mounts both panes', () => {
    const s = setSplitRatio(splitTab(three(), 'b'), 0.6)
    const restored = parseSavedTabs(JSON.parse(JSON.stringify(serializeTabs(s))), 'fresh')
    expect(restored.split).toEqual(['a', 'b'])
    expect(restored.splitRatio).toBe(0.6)
    expect(restored.live.sort()).toEqual(['a', 'b'])
  })

  it.each([
    ['a tab that no longer exists', ['a', 'gone']],
    ['the same tab twice', ['b', 'b']],
    ['a pair without the active tab', ['a', 'c']],
    ['the wrong shape', 'a,b'],
    ['too many', ['a', 'b', 'c']],
  ])('ignores a saved split with %s', (_name, split) => {
    const saved = { ...serializeTabs(three()), activeId: 'b', split }
    const restored = parseSavedTabs(JSON.parse(JSON.stringify(saved)), 'fresh')
    expect(restored.split).toBeNull()
    expect(restored.activeId).toBe('b')
  })

  it('state saved before split view existed still loads', () => {
    const { split, splitRatio, ...old } = serializeTabs(three())
    void split
    void splitRatio
    const restored = parseSavedTabs(JSON.parse(JSON.stringify(old)), 'fresh')
    expect(restored.split).toBeNull()
    expect(restored.splitRatio).toBe(0.5)
  })
})
