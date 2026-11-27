/** Someone a commit credits with a Co-authored-by line. */
export interface CoAuthor {
  name: string
  email?: string
}

/** A Co-authored-by line's value, "Mona Lisa <mona@example.com>". */
export function parseCoAuthor(value: string): CoAuthor | null {
  const text = value.trim()
  const m = /^(.*?)\s*<([^<>]*)>$/.exec(text)
  const name = (m ? m[1] : text).trim()
  const email = m?.[2].trim()
  // A git too old for the trailers format leaves its placeholder in place of the names.
  if ((!name && !email) || name.startsWith('%(')) return null
  return { name: name || email!, ...(email ? { email } : {}) }
}

/** Each person once, however many lines name them. */
export function uniqueCoAuthors(list: Array<CoAuthor | null>): CoAuthor[] {
  const seen = new Set<string>()
  return list.filter((a): a is CoAuthor => {
    if (!a) return false
    const id = (a.email || a.name).toLowerCase()
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const CO_AUTHOR_LINE = /^\s*co-authored-by:\s*(.+)$/i

/**
 * A commit message as GitHub Desktop shows it: the summary, the description without its
 * Co-authored-by lines, and the people those lines name. Other trailers stay in the description.
 */
export function splitCommitMessage(message: string): { summary: string; body: string; coAuthors: CoAuthor[] } {
  const [summary = '', ...rest] = message.replace(/\r\n/g, '\n').split('\n')
  const named: Array<CoAuthor | null> = []
  const body = rest
    .filter((line) => {
      const m = CO_AUTHOR_LINE.exec(line)
      if (m) named.push(parseCoAuthor(m[1]))
      return !m
    })
    .join('\n')
    // A squash merge on GitHub rules a line of dashes above the co-authors; with them gone it rules off nothing.
    .replace(named.length ? /\n\s*-{3,}\s*$/ : /$^/, '')
    .trim()
  return { summary: summary.trim(), body, coAuthors: uniqueCoAuthors(named) }
}
