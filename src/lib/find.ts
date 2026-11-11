/**
 * Find in page that also sees what isn't drawn. Long lists (a pull request's diffs) only draw what's near the screen,
 * which leaves the browser's own find and copy blind to the rest. Such a list registers each undrawn part here with the
 * text it would draw, so a search walks the page in order and counts those parts as if they were there; going to a match
 * in one asks it to draw itself. Copying a selection that runs over undrawn parts fills them in the same way.
 */

/** Text an undrawn part of the page would show, in the units it would draw it in (a diff's code cells). */
export interface FindSource {
  /** The element that owns this text whether drawn or not, such as a file's box. Matches are counted per owner. */
  owner: Element
  units(): string[]
  /** Draws the part. A search run after the page settles finds the same matches as text on the page. */
  reveal(): void
}

/** What a part of the page puts on the clipboard when a copy runs over it while it isn't (fully) drawn. */
export interface CopySource {
  drawn(): boolean
  text(): string
}

const findSources = new Map<Element, FindSource>()
const copySources = new Map<Element, CopySource>()

/** Marks `el`, a stand-in on the page, as holding the source's text. Returns the unregister function. */
export function registerFindSource(el: Element, source: FindSource) {
  findSources.set(el, source)
  return () => {
    if (findSources.get(el) === source) findSources.delete(el)
  }
}

export function registerCopySource(el: Element, source: CopySource) {
  copySources.set(el, source)
  return () => {
    if (copySources.get(el) === source) copySources.delete(el)
  }
}

/** Elements marked with this are left out of a search: line numbers, diff markers, the find bar. */
export const FIND_SKIP = 'data-find-skip'
/** A unit of text that a FindSource stands in for when it isn't drawn, such as one code cell of a diff. */
export const FIND_UNIT = 'data-find-unit'
/** The element a FindSource names as owner, so drawn matches can be told apart per owner. */
export const FIND_OWNER = 'data-find-owner'

export interface FindOptions {
  caseSensitive?: boolean
}

export type FindMatch =
  | { kind: 'dom'; range: Range; owner: Element | null; nth: number | null }
  | { kind: 'virtual'; el: Element; source: FindSource; owner: Element; nth: number }

/** More matches than this stop counting: past it, a number helps no one and highlighting gets slow. */
export const MAX_MATCHES = 10_000

export function queryRegExp(query: string, { caseSensitive = false }: FindOptions = {}) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
}

/** Start and end of each match in `text`, without overlaps, as a browser's find counts them. */
export function matchesIn(text: string, re: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (!re.source) return out
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++
      continue
    }
    out.push([m.index, m.index + m[0].length])
  }
  return out
}

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'BUTTON', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LABEL', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])
const NEVER = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'svg', 'IFRAME', 'CANVAS'])

function visible(el: Element) {
  const check = (el as Element & { checkVisibility?(o?: object): boolean }).checkVisibility
  // An element with display: contents has no box of its own, so checkVisibility calls it hidden; its children aren't.
  if (check) return check.call(el, { visibilityProperty: true }) || getComputedStyle(el).display === 'contents'
  return (el as HTMLElement).offsetParent !== null || getComputedStyle(el).position === 'fixed'
}

/**
 * Every match under `root` in page order, drawn or not. Text is searched one block at a time (a paragraph, a table
 * cell), so a match can cross the spans of highlighted code but not the edge of a cell.
 */
export function findMatches(root: Element, query: string, options: FindOptions = {}): FindMatch[] {
  const out: FindMatch[] = []
  if (!query) return out
  const re = queryRegExp(query, options)
  const counts = new Map<Element, number>()
  let nodes: Text[] = []
  let text = ''
  let unit: { owner: Element | null; isUnit: boolean } = { owner: null, isUnit: false }

  const flush = () => {
    if (text) {
      let at = 0
      let start = 0
      for (const [from, to] of matchesIn(text, re)) {
        if (out.length >= MAX_MATCHES) break
        const range = document.createRange()
        // Walk forward to the nodes holding `from` and `to`; matches come in order, so `at` never moves back.
        while (at < nodes.length - 1 && start + nodes[at].data.length <= from) start += nodes[at++].data.length
        range.setStart(nodes[at], from - start)
        let j = at
        let jStart = start
        while (j < nodes.length - 1 && jStart + nodes[j].data.length < to) jStart += nodes[j++].data.length
        range.setEnd(nodes[j], to - jStart)
        let nth: number | null = null
        if (unit.isUnit && unit.owner) {
          nth = counts.get(unit.owner) ?? 0
          counts.set(unit.owner, nth + 1)
        }
        out.push({ kind: 'dom', range, owner: unit.owner, nth })
      }
    }
    nodes = []
    text = ''
  }

  const visit = (el: Element, owner: Element | null, inUnit: boolean) => {
    for (let child = el.firstChild; child && out.length < MAX_MATCHES; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child as Text
        if (!t.data) continue
        if (!nodes.length) unit = { owner, isUnit: inUnit }
        nodes.push(t)
        text += t.data
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const c = child as Element
      if (NEVER.has(c.tagName) || c.hasAttribute(FIND_SKIP)) continue
      const source = findSources.get(c)
      if (source) {
        flush()
        source.units().forEach((u) => {
          for (const _ of matchesIn(u, re)) {
            if (out.length >= MAX_MATCHES) return
            const nth = counts.get(source.owner) ?? 0
            counts.set(source.owner, nth + 1)
            out.push({ kind: 'virtual', el: c, source, owner: source.owner, nth })
          }
        })
        continue
      }
      if (!visible(c)) continue
      const block = BLOCK.has(c.tagName)
      if (block) flush()
      visit(c, c.hasAttribute(FIND_OWNER) ? c : owner, inUnit || c.hasAttribute(FIND_UNIT))
      if (block) flush()
    }
  }

  visit(root, root.closest(`[${FIND_OWNER}]`), false)
  flush()
  return out
}

/** Whether any undrawn part sits under `root`, so a search there reaches past the screen. */
export function hasFindSources(root: Element) {
  for (const el of findSources.keys()) if (root.contains(el)) return true
  return false
}

/**
 * The text a copy of `range` should give when it runs over undrawn parts, or null when the browser's own copy is
 * right (nothing undrawn in it). Each part the selection touches is copied whole: its own text from where it is drawn
 * would be partial, and mixing the two would be harder to read than either.
 */
export function copyText(range: Range): string | null {
  const touched = [...copySources].filter(([el]) => range.intersectsNode(el))
  if (!touched.some(([, s]) => !s.drawn())) return null
  touched.sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  return touched.map(([, s]) => s.text()).join('\n')
}

let copyInstalled = false

/** Fills undrawn parts into what a copy puts on the clipboard. Once per window. */
export function installCopyFill() {
  if (copyInstalled || typeof document === 'undefined') return
  copyInstalled = true
  document.addEventListener('copy', (e) => {
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return
    const text = copyText(sel.getRangeAt(0))
    if (text === null) return
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
  })
}

/* Drawing everything: for the browser's own find, printing, or a look at the whole page at once. */

let drawAll = false
const drawAllListeners = new Set<() => void>()

export function getDrawAll() {
  return drawAll
}

export function setDrawAll(next: boolean) {
  if (next === drawAll) return
  drawAll = next
  drawAllListeners.forEach((l) => l())
}

export function subscribeDrawAll(listener: () => void) {
  drawAllListeners.add(listener)
  return () => void drawAllListeners.delete(listener)
}
