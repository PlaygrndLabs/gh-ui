import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { Button, IconButton, Tooltip } from '@primer/react'
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from '@primer/octicons-react'
import { hunkIndexOf, lineOn, parsePatch, rangeContains, selectLines, type DiffLine, type DiffSide, type LineRange, type LineSelection } from '../lib/diff'
import { highlightLine, languageFor } from '../lib/highlight'
import { DiffStat, CopyButton } from './Bits'
import { getDrawAll, registerCopySource, registerFindSource, subscribeDrawAll } from '../lib/find'

export type { DiffSide }

/** Stable anchor used by review comments: RIGHT+new line for additions/context, LEFT+old line for deletions. */
export function lineAnchor(line: DiffLine): { side: DiffSide; line: number } | null {
  if (line.type === 'del' && line.oldNo !== null) return { side: 'LEFT', line: line.oldNo }
  if ((line.type === 'add' || line.type === 'context') && line.newNo !== null) return { side: 'RIGHT', line: line.newNo }
  return null
}

export function anchorKey(side: DiffSide, line: number) {
  return `${side}:${line}`
}

interface DiffViewProps {
  path: string
  lines: DiffLine[]
  split?: boolean
  wrap?: boolean
  /** Inline content (threads, drafts) rendered under a line. */
  renderAfterLine?(line: DiffLine): ReactNode
  /** Opens a comment form on a line or a range of lines (from a drag on "+", or "+" inside the selection). */
  onAddComment?(range: LineRange): void
  /** Lines shown with github.com's selection highlight. */
  selection?: LineSelection | null
  /** Clicking a line number selects it; shift-clicking another extends the selection. */
  onSelectLines?(selection: LineSelection): void
  /** The selection is the range a comment form is open on (github.com adds a blue bar). */
  commenting?: boolean
}

const MARKER: Record<string, string> = { add: '+', del: '-', context: ' ' }

interface Drag {
  side: DiffSide
  anchor: number
  end: number
}

export function DiffView({ path, lines, split, wrap = true, renderAfterLine, onAddComment, selection, onSelectLines, commenting }: DiffViewProps) {
  const lang = useMemo(() => languageFor(path), [path])
  const html = useMemo(
    () => lines.map((l) => (l.type === 'hunk' || l.type === 'meta' ? escape(l.content) : highlightLine(l.content, lang))),
    [lines, lang],
  )
  // Pressing "+" and dragging over other lines of the same side and hunk selects them; releasing opens the form.
  const [drag, setDrag] = useState<Drag | null>(null)
  const shown: LineRange | null | undefined = drag ? { side: drag.side, start: Math.min(drag.anchor, drag.end), end: Math.max(drag.anchor, drag.end) } : selection

  useEffect(() => {
    if (!drag) return
    const up = () => {
      setDrag(null)
      const range = { side: drag.side, start: Math.min(drag.anchor, drag.end), end: Math.max(drag.anchor, drag.end) }
      // "+" on a line of a shift-click selection comments on the whole selection, as on github.com.
      if (range.start === range.end && selection && selection.start !== selection.end && rangeContains(selection, drag.side, drag.anchor)) onAddComment?.(selection)
      else onAddComment?.(range)
    }
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [drag, selection, onAddComment])

  const onMouseOver = (e: MouseEvent<HTMLTableElement>) => {
    if (!drag) return
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-sel-side]')
    const n = Number(cell?.dataset.selLine)
    if (!cell || cell.dataset.selSide !== drag.side || !n || n === drag.end) return
    if (hunkIndexOf(lines, drag.side, n) === hunkIndexOf(lines, drag.side, drag.anchor)) setDrag({ ...drag, end: n })
  }

  const addButton = (side: DiffSide, n: number | null) => {
    if (!onAddComment || n === null) return null
    return (
      <button
        type="button"
        className="diff-add-comment"
        aria-label={`Comment on line ${side === 'LEFT' ? 'L' : 'R'}${n}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          setDrag({ side, anchor: n, end: n })
        }}
        onClick={(e) => {
          e.stopPropagation()
          // Mouse presses finish on mouseup above; this handles Enter/Space.
          if (e.detail === 0) onAddComment({ side, start: n, end: n })
        }}
      >
        <PlusIcon size={14} />
      </button>
    )
  }

  const numProps = (side: DiffSide, n: number | null) =>
    onSelectLines && n !== null
      ? {
          // Keep shift-click from selecting the page's text.
          onMouseDown: (e: MouseEvent) => e.shiftKey && e.preventDefault(),
          onClick: (e: MouseEvent) => onSelectLines(selectLines(lines, selection ?? null, side, n, e.shiftKey)),
        }
      : {}

  /** github.com's selection classes for the cells of one side of a line. */
  const sel = (line: DiffLine | null, side: DiffSide) => {
    if (!line || !shown || shown.side !== side) return ''
    const n = lineOn(line, side)
    if (!rangeContains(shown, side, n)) return ''
    return `selected-line${n === shown.start ? ' selected-line-top' : ''}${n === shown.end ? ' selected-line-bottom' : ''}`
  }

  const after = (line: DiffLine, colSpan: number) => {
    const node = renderAfterLine?.(line)
    if (!node) return null
    return (
      <tr className="diff-thread-row">
        <td colSpan={colSpan}>{node}</td>
      </tr>
    )
  }

  const tableCls = `diff-table ${wrap ? '' : 'nowrap'} ${commenting ? 'is-commenting' : ''} ${drag ? 'is-dragging' : ''}`

  if (split) {
    const rows = buildSplitRows(lines)
    const indexOf = new Map(lines.map((l, i) => [l, i]))
    return (
      <div className="diff-scroll">
        <table className={`${tableCls} diff-split`} onMouseOver={onMouseOver}>
          <colgroup>
            <col style={{ width: 50 }} />
            <col />
            <col style={{ width: 50 }} />
            <col />
          </colgroup>
          <tbody>
            {rows.map((row, i) => {
              if (row.hunk) {
                return (
                  <tr key={i} className="diff-line hunk">
                    <td className="diff-num" data-find-skip="" />
                    <td className="diff-code" colSpan={3} data-find-unit="">
                      {row.hunk.content}
                    </td>
                  </tr>
                )
              }
              const left = row.left
              const right = row.right
              const leftNo = left ? lineOn(left, 'LEFT') : null
              const rightNo = right ? lineOn(right, 'RIGHT') : null
              const leftSel = sel(left, 'LEFT')
              const rightSel = sel(right, 'RIGHT')
              return (
                <Fragment key={i}>
                  <tr className="diff-line">
                    <td data-find-skip="" className={`diff-num diff-num-cell ${cls(left)} ${leftSel && `${leftSel} selected-line-left`}`} data-sel-side={leftNo !== null ? 'LEFT' : undefined} data-sel-line={leftNo ?? undefined} {...numProps('LEFT', leftNo)}>
                      {left?.oldNo ?? ''}
                      {addButton('LEFT', leftNo)}
                    </td>
                    <td
                      className={`diff-code ${cls(left)} ${leftSel && `${leftSel} selected-line-right`}`}
                      data-find-unit=""
                      data-sel-side={leftNo !== null ? 'LEFT' : undefined}
                      data-sel-line={leftNo ?? undefined}
                      dangerouslySetInnerHTML={{ __html: left ? `${MARKER[left.type] ?? ''}${html[indexOf.get(left)!]}` : '' }}
                    />
                    <td data-find-skip="" className={`diff-num diff-num-cell ${cls(right)} ${rightSel && `${rightSel} selected-line-left`}`} data-sel-side={rightNo !== null ? 'RIGHT' : undefined} data-sel-line={rightNo ?? undefined} {...numProps('RIGHT', rightNo)}>
                      {right?.newNo ?? ''}
                      {addButton('RIGHT', rightNo)}
                    </td>
                    <td
                      className={`diff-code ${cls(right)} ${rightSel && `${rightSel} selected-line-right`}`}
                      data-find-unit=""
                      data-sel-side={rightNo !== null ? 'RIGHT' : undefined}
                      data-sel-line={rightNo ?? undefined}
                      dangerouslySetInnerHTML={{ __html: right ? `${MARKER[right.type] ?? ''}${html[indexOf.get(right)!]}` : '' }}
                    />
                  </tr>
                  {left && after(left, 4)}
                  {right && right !== left && after(right, 4)}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="diff-scroll">
      <table className={tableCls} onMouseOver={onMouseOver}>
        <tbody>
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              return (
                <tr key={i} className="diff-line hunk">
                  <td className="diff-num" colSpan={2} data-find-skip="" />
                  <td className="diff-code" colSpan={2} data-find-unit="">
                    {line.content}
                  </td>
                </tr>
              )
            }
            const anchor = lineAnchor(line)
            const rowSel = shown ? sel(line, shown.side) : ''
            return (
              <Fragment key={i}>
                <tr
                  className={`diff-line ${line.type}`}
                  data-old={line.oldNo ?? undefined}
                  data-new={line.newNo ?? undefined}
                  data-sel-side={anchor?.side}
                  data-sel-line={anchor?.line}
                >
                  <td data-find-skip="" className={`diff-num ${rowSel}`} {...numProps(anchor?.side ?? 'RIGHT', anchor?.line ?? null)}>
                    {line.oldNo ?? ''}
                  </td>
                  <td data-find-skip="" className={`diff-num diff-num-cell ${rowSel}`} {...numProps(anchor?.side ?? 'RIGHT', anchor?.line ?? null)}>
                    {line.newNo ?? ''}
                    {anchor && addButton(anchor.side, anchor.line)}
                  </td>
                  <td data-find-skip="" className={`diff-marker ${rowSel}`}>{MARKER[line.type] ?? ''}</td>
                  <td data-find-unit="" className={`diff-code ${rowSel}`} dangerouslySetInnerHTML={{ __html: html[i] }} />
                </tr>
                {after(line, 4)}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function cls(line: DiffLine | null) {
  if (!line) return 'empty-cell'
  return line.type === 'add' ? 'side-add' : line.type === 'del' ? 'side-del' : ''
}

interface SplitRow {
  hunk?: DiffLine
  left: DiffLine | null
  right: DiffLine | null
}

function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.type === 'del') dels.push(l)
    else if (l.type === 'add') adds.push(l)
    else {
      flush()
      if (l.type === 'hunk') rows.push({ hunk: l, left: null, right: null })
      else rows.push({ left: l, right: l })
    }
  }
  flush()
  return rows
}

/** The text of each code cell DiffView draws for these lines, in order: what a search sees once the diff is drawn. */
export function findUnits(lines: DiffLine[], split = false): string[] {
  if (!split) return lines.map((l) => l.content)
  const out: string[] = []
  for (const row of buildSplitRows(lines)) {
    if (row.hunk) out.push(row.hunk.content)
    else {
      if (row.left) out.push(`${MARKER[row.left.type] ?? ''}${row.left.content}`)
      if (row.right) out.push(`${MARKER[row.right.type] ?? ''}${row.right.content}`)
    }
  }
  return out
}

/** A file's change as `git diff` would print it: what copying it gives when it isn't drawn. */
export function patchText(file: FileDiffInput): string {
  const from = file.previousPath || file.path
  const out = [`diff --git a/${from} b/${file.path}`]
  if (from !== file.path) out.push(`rename from ${from}`, `rename to ${file.path}`)
  if (file.patch) {
    out.push(file.status === 'added' ? '--- /dev/null' : `--- a/${from}`, file.status === 'removed' ? '+++ /dev/null' : `+++ b/${file.path}`)
    out.push(file.patch.replace(/\n$/, ''))
  } else {
    const note = missingPatchNote(file)
    if (note === 'Binary file not shown.') out.push(`Binary files a/${from} and b/${file.path} differ`)
    else if (note === null) out.push('(GitHub didn’t send this file’s diff: it’s too large.)')
  }
  return out.join('\n')
}

function escape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface FileDiffInput {
  path: string
  previousPath?: string | null
  status: string
  additions: number
  deletions: number
  patch?: string | null
  /** Blob SHA, when known: tells an empty file apart from one whose diff was left out. */
  sha?: string | null
}

// How far ahead of the screen a diff starts drawing, so scrolling at a normal speed never reaches an empty one.
const DRAW_AHEAD = '1500px'
// How far from the screen a drawn diff goes back to a stand-in. Well past DRAW_AHEAD, so a diff near the edge doesn't flicker.
const UNDRAW_BEYOND = '6000px'
const ROW_HEIGHT = 20

/** One observer per margin for every diff. scrollMargin because diffs scroll inside their panes, and rootMargin only reaches the window's edge. */
function screenWatcher(margin: string) {
  const callbacks = new WeakMap<Element, (inside: boolean) => void>()
  let observer: IntersectionObserver | null = null
  return (el: Element, onChange: (inside: boolean) => void) => {
    if (typeof IntersectionObserver === 'undefined') {
      onChange(true)
      return () => {}
    }
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      },
      { rootMargin: margin, scrollMargin: margin },
    )
    callbacks.set(el, onChange)
    observer.observe(el)
    return () => {
      callbacks.delete(el)
      observer?.unobserve(el)
    }
  }
}
const watchNear = screenWatcher(DRAW_AHEAD)
const watchFar = screenWatcher(UNDRAW_BEYOND)

/** Whether a drawn diff can go back to a stand-in without losing something: focus, a form, a text selection. */
function canUndraw(box: Element) {
  if (box.contains(document.activeElement) || box.querySelector('textarea, input, [contenteditable="true"]')) return false
  const sel = document.getSelection()
  return !(sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(box))
}

function countLines(patch: string | null | undefined) {
  if (!patch) return 0
  let lines = patch.endsWith('\n') ? 0 : 1
  for (let at = patch.indexOf('\n'); at !== -1; at = patch.indexOf('\n', at + 1)) lines++
  return lines
}

const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
const BINARY_EXT = /\.(png|jpe?g|gif|ico|icns|webp|bmp|tiff?|avif|heic|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|whl|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|webm|wav|ogg|flac|exe|dll|so|dylib|bin|class|wasm|pyc|o|a|lib|node|db|sqlite)$/i

/** github.com's note for a file the API sent without a patch, or null when its diff was simply too large to send. */
function missingPatchNote(file: FileDiffInput): string | null {
  if (file.additions + file.deletions > 0) return null
  if (file.status === 'renamed') return 'File renamed without changes.'
  if (file.status === 'removed') return 'This file was deleted.'
  if (file.sha === EMPTY_BLOB_SHA) return 'Empty file.'
  if (BINARY_EXT.test(file.path)) return 'Binary file not shown.'
  if (file.status === 'changed') return 'File mode changed.'
  // No lines changed and no patch: a binary file the extension list does not know, never a "large" diff.
  return 'Binary file not shown.'
}

interface FileDiffBoxProps extends Omit<DiffViewProps, 'path' | 'lines'> {
  file: FileDiffInput
  actions?: ReactNode
  collapsed?: boolean
  onToggle?(): void
  id?: string
  /** Draws straight away. For what's on screen from the start; the rest wait until they're close to it. */
  eager?: boolean
}

const LARGE_DIFF_LINES = 1200

export function FileDiffBox({ file, actions, collapsed, onToggle, id, eager = false, ...rest }: FileDiffBoxProps) {
  const lineCount = useMemo(() => countLines(file.patch), [file.patch])
  const box = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const drawAll = useSyncExternalStore(subscribeDrawAll, getDrawAll)
  // Drawn near the screen and back to a stand-in of the same height far from it, unless that would lose something (canUndraw).
  const [drawn, setDrawn] = useState(eager)
  const [standInHeight, setStandInHeight] = useState<number | null>(null)
  const lines = useMemo(() => (drawn ? parsePatch(file.patch) : []), [drawn, file.patch])
  const [forceLoad, setForceLoad] = useState(false)
  const tooLarge = lineCount > LARGE_DIFF_LINES && !forceLoad
  const split = !!rest.split
  const keep = drawAll || !!rest.selection || !!rest.commenting

  useEffect(() => {
    if (drawAll) setDrawn(true)
  }, [drawAll])
  // The stand-in's height was measured for one layout; another one draws differently.
  useEffect(() => setStandInHeight(null), [split, file.patch])

  const keepRef = useRef(keep)
  keepRef.current = keep
  useEffect(() => {
    const el = box.current
    if (!el) return
    const stopNear = watchNear(el, (inside) => inside && setDrawn(true))
    const stopFar = watchFar(el, (inside) => {
      if (inside || keepRef.current || !body.current || !canUndraw(el)) return
      setStandInHeight(body.current.offsetHeight)
      setDrawn(false)
    })
    return () => {
      stopNear()
      stopFar()
    }
  }, [])

  // What find and copy use for this file while its diff isn't on the page (src/lib/find.ts).
  const latest = useRef({ collapsed, onToggle, tooLarge, drawn, file })
  latest.current = { collapsed, onToggle, tooLarge, drawn, file }
  const units = useMemo(() => {
    let cached: string[] | null = null
    return () => (cached ??= findUnits(parsePatch(file.patch), split))
  }, [file.patch, split])
  const standIn = useCallback(
    (el: HTMLDivElement | null) => {
      // React sets a child's ref before its parent's, so the box is found through the DOM rather than its ref.
      const owner = el?.closest('[data-find-owner]')
      if (!el || !owner) return
      return registerFindSource(el, {
        owner,
        units,
        reveal: () => {
          if (latest.current.collapsed) latest.current.onToggle?.()
          if (latest.current.tooLarge) setForceLoad(true)
          setDrawn(true)
        },
      })
    },
    [units],
  )
  useEffect(() => {
    if (!box.current) return
    return registerCopySource(box.current, {
      drawn: () => !latest.current.file.patch || (latest.current.drawn && !latest.current.collapsed && !latest.current.tooLarge),
      text: () => patchText(latest.current.file),
    })
  }, [])

  const hasPatch = !!file.patch
  return (
    <div className={`Box file-diff ${collapsed ? 'collapsed' : ''}`} id={id} ref={box} data-find-owner="">
      <div className="file-diff-header">
        <IconButton size="small" variant="invisible" icon={collapsed ? ChevronRightIcon : ChevronDownIcon} aria-label={collapsed ? 'Expand file' : 'Collapse file'} onClick={onToggle} />
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <span className="file-diff-name">
          {file.previousPath && file.previousPath !== file.path ? (
            <>
              {file.previousPath} → {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <CopyButton text={file.path} label="Copy file path" />
        <span className="ml-auto flex-center gap-2">{actions}</span>
      </div>
      {collapsed ? (
        hasPatch && <div ref={standIn} hidden />
      ) : !hasPatch && missingPatchNote(file) === null ? (
        // The API leaves out the patch of a diff that is too big (lockfiles, or every file past its limits in a huge PR).
        <div className="diff-hidden-note">
          <p className="diff-hidden-note-text">Large diffs are not rendered by default.</p>
        </div>
      ) : !hasPatch ? (
        <div className="diff-empty-note">{missingPatchNote(file)}</div>
      ) : tooLarge ? (
        <div className="diff-hidden-note" ref={standIn}>
          <Tooltip text={`${lineCount.toLocaleString()} lines`}>
            <Button variant="invisible" onClick={() => setForceLoad(true)}>
              <span className="diff-load-label">Load diff</span>
            </Button>
          </Tooltip>
          <p className="diff-hidden-note-text">Large diffs are not rendered by default.</p>
        </div>
      ) : drawn ? (
        <div ref={body}>
          <DiffView path={file.path} lines={lines} {...rest} />
        </div>
      ) : (
        <div ref={standIn} style={{ height: standInHeight ?? lineCount * ROW_HEIGHT }} />
      )}
    </div>
  )
}
