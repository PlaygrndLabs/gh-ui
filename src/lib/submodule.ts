// A submodule is another repository kept inside this one at one commit. Git lists it among the changed files, but what
// changed is that commit, or files inside it that only the submodule itself can commit.

import type { FileDiff } from './diff'
import { parseRemote } from './links'

export interface SubmoduleChange {
  /** The commit the parent had recorded, or null when the submodule is new here. */
  from: string | null
  /** The commit it is at now, or null when it has been removed. */
  to: string | null
  /** Tracked files inside it have changes not yet committed there. */
  modified: boolean
  /** It holds new files not yet committed there. */
  untracked: boolean
}

const SUBPROJECT = /^[+-]Subproject commit ([0-9a-f]{40,64})(-dirty)?$/

/**
 * The two commits in a submodule's diff, or null when the diff is of an ordinary file. Git writes a submodule as a
 * one-line file, "Subproject commit <sha>", with "-dirty" on the end when files inside it have uncommitted changes.
 */
export function parseSubmoduleDiff(file: Pick<FileDiff, 'patch'>): { from: string | null; to: string | null; dirty: boolean } | null {
  // Two lines with a commit id each: anything longer is a file, and a large one isn't worth splitting to find that out.
  if (file.patch.length > 400) return null
  const changed = file.patch.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'))
  if (!changed.length || changed.length > 2) return null
  let from: string | null = null
  let to: string | null = null
  let dirty = false
  for (const line of changed) {
    const m = SUBPROJECT.exec(line)
    if (!m) return null
    if (line[0] === '-') from = m[1]
    else {
      to = m[1]
      dirty = !!m[2]
    }
  }
  return { from, to, dirty }
}

/**
 * Parses `git status --porcelain=v2 -z -- <path>` for the one entry it names. Only this format says that an entry is a
 * submodule, and which of its three kinds of change it has: `S<C><M><U>` for a new commit, modified files and new files.
 * Null for an ordinary file, or when git lists nothing for the path.
 */
export function parseSubmoduleStatus(out: string): { commitChanged: boolean; modified: boolean; untracked: boolean } | null {
  const record = out.split('\0').find((r) => /^[12u] /.test(r))
  const sub = record?.split(' ')[2]
  if (!sub || sub[0] !== 'S') return null
  return { commitChanged: sub[1] === 'C', modified: sub[2] === 'M', untracked: sub[3] === 'U' }
}

/** What a submodule's entry in Changes stands for, from its diff and its status. Null for an ordinary file. */
export function submoduleChange(diff: Pick<FileDiff, 'patch'> | null, status: ReturnType<typeof parseSubmoduleStatus>): SubmoduleChange | null {
  const commits = diff ? parseSubmoduleDiff(diff) : null
  // An ordinary file's status never says "submodule", and a submodule's diff is never anything but its commit line.
  if (!status && !commits) return null
  if (diff && !commits) return null
  return {
    from: commits?.from ?? null,
    to: commits?.to ?? null,
    // The diff alone can't tell modified files from new ones, so "-dirty" counts as modified when status has no say.
    modified: status ? status.modified : !!commits?.dirty,
    untracked: status?.untracked ?? false,
  }
}

/** Whether the parent has a new commit of the submodule to record, as opposed to changes only the submodule can commit. */
export const submoduleCommitChanged = (change: SubmoduleChange) => change.from !== change.to

/** Reads `.gitmodules`: each submodule's folder and the address it was added from. */
export function parseGitmodules(text: string): Map<string, string> {
  const urls = new Map<string, string>()
  let path: string | null = null
  let url: string | null = null
  const flush = () => {
    if (path && url) urls.set(path, url)
    path = url = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      flush()
      continue
    }
    const m = /^(path|url)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    // Git allows a value in double quotes, for one with leading spaces or a "#" in it.
    const value = m[2].replace(/^"(.*)"$/, '$1')
    if (m[1] === 'path') path = value.replace(/\/+$/, '')
    else url = value
  }
  flush()
  return urls
}

/**
 * The address a submodule's URL stands for. One that starts with ./ or ../ is relative to the parent's own remote, which
 * is how a project keeps its submodules on whichever server it is cloned from.
 */
export function resolveSubmoduleUrl(url: string, parentRemote: string | null): string {
  if (!/^\.\.?\//.test(url) || !parentRemote) return url
  // user@host:path has no slash to stand on, so the path is worked out apart from the host.
  const scp = /^([\w.-]+@[\w.-]+):(.*)$/.exec(parentRemote)
  const [prefix, base] = scp ? [`${scp[1]}:`, scp[2]] : [/^[a-z][\w+.-]*:\/\/[^/]+/i.exec(parentRemote)?.[0] ?? '', parentRemote.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '')]
  const parts = base.replace(/\/+$/, '').split('/').filter(Boolean)
  for (const step of url.split('/')) {
    if (step === '..') parts.pop()
    else if (step && step !== '.') parts.push(step)
  }
  return scp ? `${prefix}${parts.join('/')}` : `${prefix}/${parts.join('/')}`
}

/** How to name a submodule's repository and where its page is, when its address is one on a server. */
export function submoduleRepository(url: string): { label: string; href: string } | null {
  const remote = parseRemote(url)
  if (!remote) return null
  return { label: `${remote.owner}/${remote.repo} (${remote.host})`, href: `https://${remote.host}/${remote.owner}/${remote.repo}` }
}
