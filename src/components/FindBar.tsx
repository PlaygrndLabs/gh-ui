import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { IconButton, TextInput, Tooltip } from '@primer/react'
import { ChevronDownIcon, ChevronUpIcon, ScreenFullIcon, XIcon } from '@primer/octicons-react'
import { findMatches, getDrawAll, hasFindSources, installCopyFill, MAX_MATCHES, setDrawAll, subscribeDrawAll, type FindMatch } from '../lib/find'
import { native } from '../lib/platform'
import { contentArea } from '../lib/scroll'

const isMac = native ? native.platform === 'darwin' : /Mac|iPhone|iPad/.test(navigator.platform)
const HIGHLIGHT = 'gh-find'
const HIGHLIGHT_CURRENT = 'gh-find-current'

type Highlights = Map<string, unknown> & { set(name: string, h: unknown): void }
const highlights = (): Highlights | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Highlights }).highlights : null)
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight

function clearHighlights() {
  highlights()?.delete(HIGHLIGHT)
  highlights()?.delete(HIGHLIGHT_CURRENT)
}

/** Scrolls only when the match isn't already well inside the visible area, so stepping through a screenful doesn't jump. */
function scrollToMatch(m: FindMatch) {
  const el = m.kind === 'dom' ? m.range.startContainer.parentElement : m.el
  if (!el) return
  const rect = m.kind === 'dom' ? m.range.getBoundingClientRect() : el.getBoundingClientRect()
  const area = (contentArea() ?? document.documentElement).getBoundingClientRect()
  // Room for sticky headers at the top of the area.
  const inside = m.kind === 'dom' && rect.height > 0 && rect.top >= area.top + 120 && rect.bottom <= area.bottom - 40 && rect.left >= area.left && rect.right <= area.right
  if (!inside) el.scrollIntoView({ block: 'center', inline: 'nearest' })
}

/** The first match at or below the top of the visible area, as an editor starts from where you are. */
function firstOnScreen(matches: FindMatch[], root: Element) {
  const top = root.getBoundingClientRect().top
  const i = matches.findIndex((m) => (m.kind === 'dom' ? m.range.getBoundingClientRect() : m.el.getBoundingClientRect()).bottom >= top)
  return i < 0 ? 0 : i
}

/**
 * Find in page for the tab with focus, opened with Cmd/Ctrl+F. Unlike the browser's own find it sees the parts of a
 * page that aren't drawn yet (a large pull request's diffs) and draws the one a match is in when you go to it.
 */
export function FindBar() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matches, setMatches] = useState<FindMatch[]>([])
  const [current, setCurrent] = useState(-1)
  const [root, setRoot] = useState<Element | null>(null)
  const [frame, setFrame] = useState<{ top: number; right: number }>({ top: 8, right: 16 })
  const drawAll = useSyncExternalStore(subscribeDrawAll, getDrawAll)
  const input = useRef<HTMLInputElement>(null)
  // A match in a part that isn't drawn: once it is, the search after the page settles moves to the same match drawn.
  const pending = useRef<{ owner: Element; nth: number } | null>(null)
  const state = useRef({ open, matches, current })
  state.current = { open, matches, current }

  useEffect(installCopyFill, [])

  const place = useCallback((el: Element) => {
    const r = el.getBoundingClientRect()
    setFrame({ top: Math.max(r.top, 0) + 8, right: Math.max(window.innerWidth - r.right, 0) + 16 })
  }, [])

  const go = useCallback((list: FindMatch[], i: number) => {
    if (!list.length) return
    const at = ((i % list.length) + list.length) % list.length
    setCurrent(at)
    const m = list[at]
    scrollToMatch(m)
    if (m.kind === 'virtual') {
      pending.current = { owner: m.owner, nth: m.nth }
      m.source.reveal()
    } else pending.current = null
  }, [])

  /** Searches again: from the screen for a new query, or keeping the current match when the page changed under it. */
  const search = useCallback(
    (fresh: boolean) => {
      const area = contentArea() ?? document.body
      setRoot(area)
      const list = findMatches(area, query, { caseSensitive })
      setMatches(list)
      if (fresh) {
        pending.current = null
        if (list.length) go(list, firstOnScreen(list, area))
        else setCurrent(-1)
        return
      }
      const want = pending.current
      if (want) {
        const i = list.findIndex((m) => m.kind === 'dom' && m.owner === want.owner && m.nth === want.nth)
        if (i >= 0) {
          pending.current = null
          setCurrent(i)
          scrollToMatch(list[i])
          return
        }
      }
      setCurrent((c) => (list.length ? Math.min(Math.max(c, 0), list.length - 1) : -1))
    },
    [query, caseSensitive, go],
  )

  // A new query or option searches from the screen, a moment after typing stops.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => search(true), query.length > 2 ? 60 : 150)
    return () => clearTimeout(t)
  }, [open, query, caseSensitive]) // eslint-disable-line react-hooks/exhaustive-deps -- search changes with them

  // The page drawing more of itself (scrolling, a revealed match, data arriving) searches again in place.
  useEffect(() => {
    if (!open || !root || !query) return
    let t: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => search(false), 120)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] })
    return () => {
      clearTimeout(t)
      observer.disconnect()
    }
  }, [open, root, query, search])

  useLayoutEffect(() => {
    const h = highlights()
    if (!h || !HighlightCtor) return
    if (!open) return clearHighlights()
    const cur = matches[current]
    const others = matches.filter((m): m is Extract<FindMatch, { kind: 'dom' }> => m.kind === 'dom' && m !== cur).map((m) => m.range)
    h.set(HIGHLIGHT, new HighlightCtor(...others))
    if (cur?.kind === 'dom') h.set(HIGHLIGHT_CURRENT, new HighlightCtor(cur.range))
    else h.delete(HIGHLIGHT_CURRENT)
  }, [open, matches, current])

  const openFind = useCallback(() => {
    const area = contentArea() ?? document.body
    setRoot(area)
    place(area)
    const picked = document.getSelection()?.toString() ?? ''
    if (picked && picked.length < 200 && !picked.includes('\n')) setQuery(picked)
    // At once, so the first keys typed after Cmd+F land in the box.
    flushSync(() => setOpen(true))
    input.current?.focus()
    input.current?.select()
  }, [place])

  const close = useCallback(() => {
    const { matches, current } = state.current
    const cur = matches[current]
    setOpen(false)
    clearHighlights()
    pending.current = null
    // As a browser does: the match you stopped on stays selected, so Cmd+C copies it and typing starts from there.
    if (cur?.kind === 'dom') {
      const sel = document.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(cur.range)
    }
  }, [])

  const step = useCallback(
    (by: number) => {
      const { open, matches, current } = state.current
      if (!open) return openFind()
      go(matches, current + by)
    },
    [go, openFind],
  )

  // The desktop app's Edit menu owns the shortcuts; a browser's keys are caught here. A second Cmd+F while the box
  // has focus is left to the browser, for its own find.
  useEffect(() => {
    if (native) {
      return native.onMenu((action) => {
        if (action === 'find') openFind()
        else if (action === 'find-next') step(1)
        else if (action === 'find-previous') step(-1)
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'f' && !e.shiftKey) {
        if (state.current.open && document.activeElement === input.current) return
        e.preventDefault()
        openFind()
      } else if (key === 'g' && state.current.open) {
        e.preventDefault()
        step(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openFind, step])

  useEffect(() => {
    if (!open || !root) return
    const onResize = () => place(root)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, root, place])

  if (!open) return null
  const capped = matches.length >= MAX_MATCHES
  const count = !query ? '' : matches.length ? `${(current + 1).toLocaleString()} of ${matches.length.toLocaleString()}${capped ? '+' : ''}` : 'No results'
  const hidden = matches.some((m) => m.kind === 'virtual')
  const offerDrawAll = drawAll || (root ? hasFindSources(root) : false)

  return (
    <div className="find-bar" role="search" data-find-skip="" style={{ top: frame.top, right: frame.right }}>
      <div className="find-bar-row">
        <TextInput
          ref={input}
          size="small"
          aria-label="Find in page"
          placeholder="Find in page"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
          trailingVisual={<span className="find-bar-count" aria-live="polite">{count}</span>}
          className="find-bar-input"
        />
        <Tooltip text="Match case">
          <button type="button" className={`find-bar-toggle ${caseSensitive ? 'is-on' : ''}`} aria-pressed={caseSensitive} aria-label="Match case" onClick={() => setCaseSensitive((v) => !v)}>
            Aa
          </button>
        </Tooltip>
        <IconButton size="small" variant="invisible" icon={ChevronUpIcon} aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)} />
        <IconButton size="small" variant="invisible" icon={ChevronDownIcon} aria-label="Next match" disabled={!matches.length} onClick={() => step(1)} />
        {offerDrawAll && (
          <IconButton
            size="small"
            variant="invisible"
            icon={ScreenFullIcon}
            aria-pressed={drawAll}
            className={drawAll ? 'find-bar-toggle-on' : ''}
            aria-label={drawAll ? 'Stop drawing every file' : 'Draw every file'}
            description={
              drawAll
                ? 'Every file stays on the page. Turn off to draw only what’s near the screen again.'
                : 'Puts every file on the page, so the browser’s own find, select all and printing see them too. Large pull requests may scroll slowly.'
            }
            onClick={() => setDrawAll(!drawAll)}
          />
        )}
        <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Close find" onClick={close} />
      </div>
      {hidden && !drawAll && <div className="find-bar-note">Includes files that aren’t drawn yet. Going to a match draws its file.</div>}
    </div>
  )
}
