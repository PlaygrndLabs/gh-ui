export type DiffLineType = 'context' | 'add' | 'del' | 'hunk' | 'meta'

export interface DiffLine {
  type: DiffLineType
  /** Line text without the leading +/-/space marker. */
  content: string
  oldNo: number | null
  newNo: number | null
  /** 1-based offset from the first @@ line, as used by the legacy `position` review field. */
  position: number
}

export interface FileDiff {
  oldPath: string
  newPath: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  binary: boolean
  additions: number
  deletions: number
  patch: string
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parses the `patch` field GitHub returns per file (hunks only, no file headers). */
export function parsePatch(patch: string | undefined | null): DiffLine[] {
  if (!patch) return []
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let position = 0
  let seenHunk = false
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    const m = raw.match(HUNK_RE)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      if (seenHunk) position++
      seenHunk = true
      out.push({ type: 'hunk', content: raw, oldNo: null, newNo: null, position })
      continue
    }
    if (!seenHunk) continue
    position++
    const marker = raw[0]
    const content = raw.slice(1)
    if (marker === '+') out.push({ type: 'add', content, oldNo: null, newNo: newNo++, position })
    else if (marker === '-') out.push({ type: 'del', content, oldNo: oldNo++, newNo: null, position })
    else if (marker === '\\') out.push({ type: 'meta', content: raw, oldNo: null, newNo: null, position })
    else out.push({ type: 'context', content, oldNo: oldNo++, newNo: newNo++, position })
  }
  return out
}

/** Splits full `git diff` output into per-file patches (used for local repositories). */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  const chunks = text.split(/^diff --git /m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const header = lines[0]
    const hm = header.match(/^"?a\/(.+?)"? "?b\/(.+?)"?$/)
    let oldPath = hm?.[1] ?? ''
    let newPath = hm?.[2] ?? ''
    let status: FileDiff['status'] = 'modified'
    let binary = false
    let i = 1
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i]
      if (l.startsWith('new file mode')) status = 'added'
      else if (l.startsWith('deleted file mode')) status = 'removed'
      else if (l.startsWith('rename from ')) {
        oldPath = l.slice('rename from '.length)
        status = 'renamed'
      } else if (l.startsWith('rename to ')) newPath = l.slice('rename to '.length)
      else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) binary = true
      else if (l.startsWith('--- ') && l !== '--- /dev/null') oldPath = l.slice(4).replace(/^a\//, '')
      else if (l.startsWith('+++ ') && l !== '+++ /dev/null') newPath = l.slice(4).replace(/^b\//, '')
    }
    const patch = lines.slice(i).join('\n')
    let additions = 0
    let deletions = 0
    for (const l of lines.slice(i)) {
      if (l.startsWith('+')) additions++
      else if (l.startsWith('-')) deletions++
    }
    files.push({ oldPath, newPath, status, binary, additions, deletions, patch })
  }
  return files
}

/** Builds the trailing slice of a diff hunk GitHub shows above review comments. */
export function hunkTail(diffHunk: string, maxLines = 4): DiffLine[] {
  const lines = parsePatch(diffHunk).filter((l) => l.type !== 'hunk')
  return lines.slice(-maxLines)
}

export type DiffSide = 'LEFT' | 'RIGHT'

/** Lines start..end on one side of a diff, as review comments address them. */
export interface LineRange {
  side: DiffSide
  start: number
  end: number
}

/** A line selection in a diff: `anchor` is the line clicked first, which a shift-click extends from. */
export interface LineSelection extends LineRange {
  anchor: number
}

/** A line's number on one side of the diff, or null when it has none there (an added line has no LEFT number). */
export function lineOn(line: DiffLine, side: DiffSide): number | null {
  if (side === 'LEFT') return line.type === 'del' || line.type === 'context' ? line.oldNo : null
  return line.type === 'add' || line.type === 'context' ? line.newNo : null
}

/** Which hunk (counting @@ headers) holds line `n` of a side, or -1 when the diff does not show it. */
export function hunkIndexOf(lines: DiffLine[], side: DiffSide, n: number): number {
  let hunk = -1
  for (const l of lines) {
    if (l.type === 'hunk') hunk++
    else if (lineOn(l, side) === n) return Math.max(hunk, 0)
  }
  return -1
}

/**
 * github.com's line selection: a click selects one line; a shift-click (or a drag) extends from the first
 * line, as long as it stays on the same side and in the same hunk, since a comment can't span hunks.
 */
export function selectLines(lines: DiffLine[], prev: LineSelection | null, side: DiffSide, n: number, extend: boolean): LineSelection {
  if (extend && prev && prev.side === side && hunkIndexOf(lines, side, prev.anchor) === hunkIndexOf(lines, side, n)) {
    return { side, anchor: prev.anchor, start: Math.min(prev.anchor, n), end: Math.max(prev.anchor, n) }
  }
  return { side, anchor: n, start: n, end: n }
}

export function rangeContains(range: LineRange | null | undefined, side: DiffSide, n: number | null): boolean {
  return !!range && n !== null && range.side === side && n >= range.start && n <= range.end
}

/** "+12" for a line of the new file, "-12" for one of the old file, as github.com labels comment ranges. */
export function sideLabel(side: DiffSide, n: number) {
  return `${side === 'LEFT' ? '-' : '+'}${n}`
}

/**
 * The lines of a review comment's diff hunk from its first to its last line, the snippet github.com shows
 * above a multi-line thread. Line numbers are the hunk's own (the comment's original_* lines).
 */
export function hunkSlice(diffHunk: string, startSide: DiffSide, start: number, side: DiffSide, end: number): DiffLine[] | null {
  const lines = parsePatch(diffHunk).filter((l) => l.type !== 'hunk')
  const from = lines.findIndex((l) => lineOn(l, startSide) === start)
  const to = lines.findIndex((l) => lineOn(l, side) === end)
  return from === -1 || to === -1 || to < from ? null : lines.slice(from, to + 1)
}
