import { lineOn, parsePatch, type DiffSide } from './diff'

// GitHub review suggestions: ```suggestion blocks in review comments that replace the commented lines.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** Code of each ```suggestion block in a comment body, skipping other fenced code (which may quote one). */
export function parseSuggestions(body: string | null | undefined): string[][] {
  if (!body) return []
  const out: string[][] = []
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_RE)
    // A backtick fence's info string can't contain backticks, so "```js```" is inline code, not a fence.
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue
    const fence = open[1]
    const block: string[] = []
    for (i++; i < lines.length; i++) {
      const close = lines[i].match(FENCE_RE)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !close[2].trim()) break
      block.push(lines[i])
    }
    // An unclosed fence runs to the end of the comment, as in CommonMark.
    if (open[2].trim() === 'suggestion') out.push(block)
  }
  return out
}

/** A ```suggestion block, fenced with more backticks than any fence inside the code so it stays one block. */
export function suggestionBlock(lines: string[]): string {
  const longest = Math.max(2, ...lines.map((l) => l.match(/^ {0,3}(`{3,})/)?.[1].length ?? 0))
  const fence = '`'.repeat(longest + 1)
  return [`${fence}suggestion`, ...lines, fence].join('\n')
}

/** Code as suggestion lines: an empty string suggests deleting the lines. */
export function codeLines(code: string): string[] {
  const text = code.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  return text === '' ? [] : text.split('\n')
}

/** A comment body with a suggestion block appended (for callers that pass the replacement code separately). */
export function withSuggestion(body: string, suggestion: string | undefined): string {
  if (suggestion === undefined) return body
  const block = suggestionBlock(codeLines(suggestion))
  return body.trim() ? `${body.trimEnd()}\n\n${block}` : block
}

/**
 * The comment editor's "Add a suggestion": puts a suggestion block holding `lines` at the cursor (replacing
 * any selected text) on lines of its own, and returns where the cursor goes: the end of the suggested code.
 */
export function insertSuggestion(text: string, selStart: number, selEnd: number, lines: string[]): { text: string; cursor: number } {
  const before = text.slice(0, selStart)
  const after = text.slice(selEnd)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after.startsWith('\n') ? '' : '\n'
  const block = suggestionBlock(lines)
  const closing = block.slice(block.lastIndexOf('\n'))
  return { text: `${before}${lead}${block}${trail}${after}`, cursor: before.length + lead.length + block.length - closing.length }
}

/** The side a review comment sits on: its diff hunk ends with the commented line. */
export function hunkSide(diffHunk: string | null | undefined): DiffSide {
  const last = parsePatch(diffHunk)
    .filter((l) => l.type !== 'meta' && l.type !== 'hunk')
    .at(-1)
  return last?.type === 'del' ? 'LEFT' : 'RIGHT'
}

/** Code of lines start..end on one side of a diff hunk, or null when the hunk doesn't hold them all. */
export function hunkRange(diffHunk: string | null | undefined, side: DiffSide, start: number, end: number): string[] | null {
  const lines = parsePatch(diffHunk)
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const l = lines.find((x) => lineOn(x, side) === n)
    if (!l) return null
    out.push(l.content)
  }
  return out
}

export interface SuggestionEdit {
  path: string
  /** First and last line the suggestion replaces, numbered as in the file at the pull request's head. */
  startLine: number
  endLine: number
  /** The code the suggestion was written against. */
  expected: string[]
  replacement: string[]
}

/**
 * Bytes of a file as text that writes back unchanged: a byte order mark stays in the text (TextDecoder drops it by
 * default, and the commit would lose it). Null for bytes that aren't UTF-8, which a text commit would corrupt.
 */
export function decodeFileBytes(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

const sameCode = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l.replace(/\r$/, '') === b[i].replace(/\r$/, ''))

/**
 * Applies suggestions to one file's text, bottom-up so earlier line numbers stay valid. Refuses when two
 * suggestions overlap or a range no longer holds the code its suggestion was written against.
 */
export function applySuggestionEdits(source: string, edits: SuggestionEdit[]): { text: string } | { error: string } {
  // A byte order mark isn't part of line 1's code.
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = source.slice(bom.length)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = text.endsWith('\n')
  const lines = text.split(/\r?\n/)
  if (finalNewline) lines.pop()
  const sorted = [...edits].sort((a, b) => b.startLine - a.startLine)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].endLine >= sorted[i - 1].startLine) return { error: `Suggestions on ${sorted[i].path} overlap (lines ${sorted[i].startLine}–${sorted[i].endLine} and ${sorted[i - 1].startLine}–${sorted[i - 1].endLine}). Commit them one at a time.` }
  }
  for (const e of sorted) {
    const current = lines.slice(e.startLine - 1, e.endLine)
    if (e.endLine > lines.length || !sameCode(current, e.expected)) {
      return { error: `${e.path} changed at ${e.startLine === e.endLine ? `line ${e.endLine}` : `lines ${e.startLine}–${e.endLine}`} since the suggestion was made, so it can't be applied.` }
    }
    lines.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...e.replacement)
  }
  return { text: bom + lines.join(eol) + (finalNewline ? eol : '') }
}

/** A review comment, in the fields that decide whether its suggestion can be committed. */
export interface SuggestionSource {
  body: string
  path: string
  side: DiffSide
  startSide?: DiffSide | null
  /** Current last/first line at the head commit; null `line` means the comment is outdated. */
  line: number | null
  startLine?: number | null
  /** Lines in the comment's diff hunk. */
  originalLine: number | null
  originalStartLine?: number | null
  diffHunk: string
}

export type SuggestionState = { ok: true; edit: SuggestionEdit } | { ok: false; reason: string }

/**
 * Whether a comment's suggestion can be committed, with github.com's reason when it can't. Returns null for a
 * comment without a suggestion. `currentLine` reads the head's code from the diff when it is loaded; the
 * commit itself checks the file again, so an unknown line doesn't block the button.
 */
export function suggestionState(
  c: SuggestionSource,
  opts: { prOpen: boolean; outdated: boolean; resolved?: boolean; pending?: boolean; currentLine?(n: number): string | undefined },
): SuggestionState | null {
  const blocks = parseSuggestions(c.body)
  if (!blocks.length) return null
  if (opts.pending) return { ok: false, reason: 'Suggestions cannot be applied from pending reviews.' }
  if (!opts.prOpen) return { ok: false, reason: 'Suggestions cannot be applied while the pull request is closed.' }
  if (opts.resolved) return { ok: false, reason: 'This suggestion has been applied or marked resolved.' }
  const outdated: SuggestionState = { ok: false, reason: 'Outdated suggestions cannot be applied.' }
  if (opts.outdated || c.line === null || c.originalLine === null) return outdated
  if (c.side === 'LEFT' || c.startSide === 'LEFT') return { ok: false, reason: 'Applying suggestions on deleted lines is not supported.' }
  if (blocks.length > 1) return { ok: false, reason: 'Only one suggestion per comment can be applied.' }
  const span = c.originalStartLine ? c.originalLine - c.originalStartLine : 0
  const startLine = c.startLine ?? c.line
  const expected = hunkRange(c.diffHunk, 'RIGHT', c.originalLine - span, c.originalLine)
  // A range that grew or shrank since the comment was written no longer matches its suggestion.
  if (!expected || c.line - startLine !== span) return outdated
  if (opts.currentLine) {
    for (let n = startLine; n <= c.line; n++) {
      const now = opts.currentLine(n)
      if (now !== undefined && now.replace(/\r$/, '') !== expected[n - startLine].replace(/\r$/, '')) return outdated
    }
  }
  if (sameCode(blocks[0], expected)) return { ok: false, reason: 'This suggestion is invalid because no changes were made to the code.' }
  return { ok: true, edit: { path: c.path, startLine, endLine: c.line, expected, replacement: blocks[0] } }
}

/** Two suggestions touching the same line can't share a batch (github.com: one suggestion per line). */
export function editsOverlap(a: SuggestionEdit, b: SuggestionEdit) {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine
}

/** github.com's commit message for applied suggestions, crediting each suggester other than the committer as a co-author. */
export function suggestionCommitMessage(opts: {
  title: string
  description?: string
  authors: Array<{ login: string; id: number }>
  viewerLogin: string
  host: string
}): string {
  const domain = opts.host === 'github.com' ? 'users.noreply.github.com' : `users.noreply.${opts.host}`
  const seen = new Set<string>()
  const trailers = opts.authors
    .filter((a) => a.login.toLowerCase() !== opts.viewerLogin.toLowerCase() && !seen.has(a.login) && seen.add(a.login))
    .map((a) => `Co-authored-by: ${a.login} <${a.id}+${a.login}@${domain}>`)
  return [opts.title.trim(), opts.description?.trim(), trailers.join('\n')].filter(Boolean).join('\n\n')
}

/** Default commit title: names the suggester for one suggestion; `authors` has one login per suggestion. */
export function defaultSuggestionTitle(authors: string[]) {
  return authors.length === 1 ? `Apply suggestion from @${authors[0]}` : 'Apply suggestions from code review'
}
