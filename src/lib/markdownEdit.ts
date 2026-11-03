// The comment editor's formatting: each function takes the text and selection and returns the new ones.

export interface TextEdit {
  text: string
  start: number
  end: number
}

export type LineStyle = 'heading' | 'quote' | 'bullet' | 'ordered' | 'task'

const LIST_RE = /^(\s*(?:>\s*)*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/
const URL_RE = /^https?:\/\/\S+$/i

/** Toggles markers around the selection, leaving its outer whitespace outside them so they stay valid Markdown. */
export function wrapSelection(text: string, selStart: number, selEnd: number, marker: string): TextEdit {
  const selected = text.slice(selStart, selEnd)
  const start = selStart + (selected.length - selected.trimStart().length)
  const end = Math.max(start, selEnd - (selected.length - selected.trimEnd().length))
  const inner = text.slice(start, end)
  if (text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
    return { text: text.slice(0, start - marker.length) + inner + text.slice(end + marker.length), start: start - marker.length, end: end - marker.length }
  }
  if (inner.length >= marker.length * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
    const bare = inner.slice(marker.length, -marker.length)
    return { text: text.slice(0, start) + bare + text.slice(end), start, end: start + bare.length }
  }
  return { text: text.slice(0, start) + marker + inner + marker + text.slice(end), start: start + marker.length, end: end + marker.length }
}

/** Toggles a line style on every selected line; list styles replace each other instead of nesting. */
export function styleLines(text: string, selStart: number, selEnd: number, style: LineStyle): TextEdit {
  const from = selStart === 0 ? 0 : text.lastIndexOf('\n', selStart - 1) + 1
  // A selection ending at the start of a line doesn't include that line.
  const last = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd
  const lineEnd = text.indexOf('\n', last)
  const to = lineEnd === -1 ? text.length : lineEnd
  const lines = text.slice(from, to).split('\n')
  const filled = lines.filter((l) => l.trim())
  const has = (line: string) => {
    if (style === 'heading') return /^### /.test(line)
    if (style === 'quote') return /^> /.test(line)
    const m = line.match(LIST_RE)
    if (!m || m[1].includes('>')) return false
    if (style === 'task') return !!m[4]
    return !m[4] && (style === 'ordered') === /\d/.test(m[2])
  }
  const remove = filled.length > 0 && filled.every(has)
  let n = 0
  const next = lines.map((line) => {
    if (!line.trim() && lines.length > 1) return line
    if (remove) return style === 'heading' ? line.slice(4) : style === 'quote' ? line.slice(2) : line.replace(LIST_RE, '$1')
    if (style === 'heading') return `### ${line}`
    if (style === 'quote') return `> ${line}`
    const body = line.replace(LIST_RE, '$1')
    return `${style === 'ordered' ? `${++n}.` : '-'} ${style === 'task' ? '[ ] ' : ''}${body}`
  })
  const replaced = next.join('\n')
  const result = text.slice(0, from) + replaced + text.slice(to)
  if (selStart === selEnd) {
    const cursor = Math.max(from, selStart + replaced.length - (to - from))
    return { text: result, start: cursor, end: cursor }
  }
  return { text: result, start: from, end: from + replaced.length }
}

/** Inline code, or a fenced block when the selection spans lines. */
export function codeSelection(text: string, selStart: number, selEnd: number): TextEdit {
  const selected = text.slice(selStart, selEnd)
  if (!selected.includes('\n')) return wrapSelection(text, selStart, selEnd, '`')
  const before = text.slice(0, selStart)
  const after = text.slice(selEnd)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  const open = `${lead}\`\`\`\n`
  const body = selected.replace(/\n$/, '')
  return { text: `${before}${open}${body}\n\`\`\`${trail}${after}`, start: selStart + open.length, end: selStart + open.length + body.length }
}

/** A link around the selection, selecting the part still to write: the URL, or the text when a URL was selected. */
export function linkSelection(text: string, selStart: number, selEnd: number): TextEdit {
  const selected = text.slice(selStart, selEnd)
  const before = text.slice(0, selStart)
  const after = text.slice(selEnd)
  if (URL_RE.test(selected)) return { text: `${before}[](${selected})${after}`, start: selStart + 1, end: selStart + 1 }
  const urlStart = selStart + selected.length + 3
  return { text: `${before}[${selected}](url)${after}`, start: urlStart, end: urlStart + 3 }
}

/** Starts an @mention or #reference at the cursor, on a word of its own. */
export function insertTrigger(text: string, selStart: number, selEnd: number, trigger: string): TextEdit {
  const before = text.slice(0, selStart)
  const insert = (before && !/\s$/.test(before) ? ' ' : '') + trigger
  const cursor = selStart + insert.length
  return { text: before + insert + text.slice(selEnd), start: cursor, end: cursor }
}

/** Pasting a URL over selected text links that text; null when the paste should go in as usual. */
export function pasteLink(text: string, selStart: number, selEnd: number, pasted: string): TextEdit | null {
  const selected = text.slice(selStart, selEnd)
  const url = pasted.trim()
  if (!selected.trim() || selected.includes('\n') || URL_RE.test(selected) || !URL_RE.test(url)) return null
  const link = `[${selected}](${url})`
  const cursor = selStart + link.length
  return { text: text.slice(0, selStart) + link + text.slice(selEnd), start: cursor, end: cursor }
}

const insideFence = (before: string) => {
  let fence: string | null = null
  for (const line of before.split('\n').slice(0, -1)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!m) continue
    if (!fence) fence = m[1]
    else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
  }
  return !!fence
}

/**
 * Enter inside a list: starts the next item, or ends the list on an empty one. Null when Enter should just
 * insert a newline (no list here, inside a code block, or the cursor is before the item's text).
 */
export function continueList(text: string, selStart: number, selEnd: number): TextEdit | null {
  if (selStart !== selEnd) return null
  const from = text.lastIndexOf('\n', selStart - 1) + 1
  const before = text.slice(0, selStart)
  if (insideFence(before)) return null
  const lineEnd = text.indexOf('\n', selStart)
  const to = lineEnd === -1 ? text.length : lineEnd
  const line = text.slice(from, to)
  const m = line.match(LIST_RE)
  if (!m || selStart - from < m[0].length) return null
  if (!line.slice(m[0].length).trim()) {
    return { text: text.slice(0, from) + m[1] + text.slice(to), start: from + m[1].length, end: from + m[1].length }
  }
  const ordered = m[2].match(/^(\d+)([.)])$/)
  const marker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : m[2]
  const insert = `\n${m[1]}${marker}${m[3]}${m[4] ? '[ ] ' : ''}`
  const cursor = selStart + insert.length
  return { text: before + insert + text.slice(selStart), start: cursor, end: cursor }
}
