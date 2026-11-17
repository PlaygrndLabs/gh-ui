// Where a diff's file can be read in full, before and after the change, so images and Markdown can be shown as
// themselves rather than as "Binary file not shown." or a wall of text. GitHub's contents API for a repository on
// GitHub; the local folder's git for one on this Mac.

import type { Octokit } from '@octokit/rest'
import { native } from './platform'
import { base64ToBytes } from './sealedBox'

export type FileVersion = 'before' | 'after'
export type PreviewKind = 'image' | 'markdown'

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  svg: 'image/svg+xml',
}

const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

/** The media type to draw a file as, when it's an image the app can show. */
export function imageType(path: string): string | null {
  return IMAGE_TYPES[extension(path)] ?? null
}

/** What a file can be previewed as, or null when only its diff makes sense. */
export function previewKind(path: string): PreviewKind | null {
  if (imageType(path)) return 'image'
  if (/\.(md|markdown|mdown|mkd)$/i.test(path)) return 'markdown'
  return null
}

/** Reads one version of a changed file. */
export interface FileSource {
  /** Tells one source's files apart from another's in the query cache. */
  id: string
  /** The file's bytes in that version, or null when it isn't there. Throws when it can't be read. */
  read(version: FileVersion, path: string): Promise<Uint8Array | null>
  /** The folder's working tree, which can change under the app: reread it now and then. */
  live?: boolean
  /** owner/repo, for #123 and @mentions in a Markdown preview. */
  context?: string
}

/** A revision now, or one that takes a request to find (a merge base), asked for only when a preview needs it. */
export type Rev = string | (() => Promise<string | null>)

function once(rev: Rev | null | undefined): () => Promise<string | null> {
  if (rev == null || typeof rev === 'string') return async () => rev ?? null
  let pending: Promise<string | null> | null = null
  return () => {
    pending ??= rev().catch((err) => {
      pending = null
      throw err
    })
    return pending
  }
}

const TOO_LARGE = 25 * 1024 * 1024

/** A file on GitHub, read at a commit through the contents API (and the blobs API past its 1 MB limit). */
export function githubSource(octokit: Octokit, owner: string, repo: string, revs: { before: Rev | null; after: Rev | null }): FileSource {
  const at = { before: once(revs.before), after: once(revs.after) }
  return {
    id: `gh:${owner}/${repo}:${typeof revs.before === 'string' ? revs.before : ''}:${typeof revs.after === 'string' ? revs.after : ''}`,
    context: `${owner}/${repo}`,
    async read(version, path) {
      const ref = await at[version]()
      if (!ref) return null
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
        if (Array.isArray(data) || data.type !== 'file') return null
        if (data.size > TOO_LARGE) throw new Error('Too large to preview.')
        if (data.encoding === 'base64' && (data.content || data.size === 0)) return base64ToBytes(data.content.replace(/\s/g, ''))
        const blob = await octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha })
        return base64ToBytes(blob.data.content.replace(/\s/g, ''))
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null
        throw err
      }
    },
  }
}

/** The folder's own copy of a file, as it is now rather than at a commit. */
export const WORKING_TREE = 'worktree' as const

/**
 * A file in a local repository. `after` can list revisions to try in turn: a stash keeps its new files in a third
 * parent rather than in the stash commit.
 */
export function localSource(repoId: string, revs: { before: Rev | null; after: Rev | typeof WORKING_TREE | string[] | null }): FileSource {
  const worktree = revs.after === WORKING_TREE
  const afters = Array.isArray(revs.after) ? revs.after : [revs.after === WORKING_TREE ? null : revs.after]
  const before = once(revs.before)
  const after = afters.map((r) => once(r))
  const read = async (rev: string | null, path: string, folder: boolean) => {
    if (!native) return null
    if (!rev && !folder) return null
    return native.readFile(repoId, folder ? null : rev, path)
  }
  return {
    id: `local:${repoId}:${typeof revs.before === 'string' ? revs.before : ''}:${worktree ? WORKING_TREE : afters.map((r) => (typeof r === 'string' ? r : '')).join(',')}`,
    live: worktree,
    async read(version, path) {
      if (version === 'before') return read(await before(), path, false)
      if (worktree) return read(null, path, true)
      for (const rev of after) {
        const bytes = await read(await rev(), path, false)
        if (bytes) return bytes
      }
      return null
    },
  }
}

export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
