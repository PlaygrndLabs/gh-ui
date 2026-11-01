import type { Octokit } from '@octokit/rest'
import { decodeBase64, type PullRequest } from './github'
import { applySuggestionEdits, decodeFileBytes, type SuggestionEdit } from './suggestions'

export interface FileChange {
  path: string
  /** Full new file content. */
  content?: string
  /** Exact replacements; each old_str must match exactly once in the current file. */
  edits?: Array<{ old_str: string; new_str: string }>
  delete?: boolean
}

/** A file's text at a ref; files over the contents API's 1 MB limit come from the blob. */
export async function readFileText(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | { error: string }> {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
  if (Array.isArray(data) || data.type !== 'file') return { error: `${path} is not a file.` }
  return data.content ? decodeBase64(data.content) : decodeBase64((await octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha })).data.content)
}

/** A file's exact text for rewriting it: keeps a byte order mark, and refuses bytes that aren't UTF-8. */
async function readFileExact(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string> {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
  if (Array.isArray(data) || data.type !== 'file') throw new Error(`${path} is not a file.`)
  const b64 = data.content || (await octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha })).data.content
  const text = decodeFileBytes(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)))
  if (text === null) throw new Error(`${path} isn't UTF-8 text, so suggestions can't be committed to it here.`)
  return text
}

/**
 * Creates one commit on a branch changing one or more files and moves the branch to it (fast-forward only).
 * With expectedHeadSha it refuses when the branch has moved. Errors come back as { error } for the agent to read.
 */
export async function commitFiles(
  octokit: Octokit,
  { owner, repo, branch, message, expectedHeadSha, changes }: { owner: string; repo: string; branch: string; message: string; expectedHeadSha?: string; changes: FileChange[] },
): Promise<{ sha: string; url: string; branch: string } | { error: string }> {
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
  const headSha = ref.object.sha
  if (expectedHeadSha && !headSha.startsWith(expectedHeadSha) && !expectedHeadSha.startsWith(headSha)) {
    return { error: `Branch ${branch} is at ${headSha}, not ${expectedHeadSha}. Re-read the files and retry.` }
  }
  const { data: headCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha })
  type TreeEntry = { mode: string; sha: string }
  let listed: Map<string, TreeEntry> | null = null
  try {
    const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: headCommit.tree.sha, recursive: 'true' })
    if (!tree.truncated) listed = new Map(tree.tree.filter((e) => e.path && e.mode).map((e) => [e.path, { mode: e.mode, sha: e.sha }]))
  } catch {
    // look each path up below instead
  }
  // Large repos get a truncated listing; then walk the path one directory at a time.
  const lookup = async (path: string): Promise<TreeEntry | undefined> => {
    if (listed) return listed.get(path)
    let treeSha = headCommit.tree.sha
    const parts = path.split('/')
    for (const [i, name] of parts.entries()) {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha })
      const e = data.tree.find((x) => x.path === name)
      if (!e) return undefined
      if (i === parts.length - 1) return { mode: e.mode, sha: e.sha }
      if (e.type !== 'tree') return undefined
      treeSha = e.sha
    }
    return undefined
  }

  const entries: Array<{ path: string; mode: '100644' | '100755' | '120000'; type: 'blob'; content?: string; sha?: string | null }> = []
  for (const change of changes) {
    // Keep the existing mode (e.g. +x); only paths that don't exist yet default to 100644.
    const existing = await lookup(change.path)
    if (existing?.mode === '120000' && !change.delete) {
      // getContent follows the link, so editing here would replace the link with a copy of its target.
      const target = decodeBase64((await octokit.rest.git.getBlob({ owner, repo, file_sha: existing.sha })).data.content)
      return { error: `${change.path} is a symlink to ${target}. Change the file it points to instead.` }
    }
    const mode = existing?.mode ?? '100644'
    if (mode !== '100644' && mode !== '100755' && mode !== '120000') {
      return { error: `${change.path} is a ${mode === '160000' ? 'submodule' : 'directory'}, not a file; commit_files cannot change it.` }
    }
    if (change.delete) {
      entries.push({ path: change.path, mode, type: 'blob', sha: null })
      continue
    }
    let content = change.content
    if (content === undefined && change.edits) {
      const text = await readFileText(octokit, owner, repo, change.path, headSha)
      if (typeof text !== 'string') return text
      content = text
      for (const edit of change.edits) {
        const count = content.split(edit.old_str).length - 1
        if (count !== 1) return { error: `In ${change.path}, old_str ${count === 0 ? 'was not found' : `matched ${count} times`}: ${edit.old_str.slice(0, 120)}` }
        content = content.replace(edit.old_str, () => edit.new_str)
      }
    }
    if (content === undefined) return { error: `Change for ${change.path} needs content, edits or delete.` }
    entries.push({ path: change.path, mode, type: 'blob', content })
  }
  const { data: tree } = await octokit.rest.git.createTree({ owner, repo, base_tree: headCommit.tree.sha, tree: entries })
  const { data: commit } = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [headSha] })
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha })
  return { sha: commit.sha, url: commit.html_url, branch }
}

/**
 * Commits review suggestions to a pull request's head branch as one commit. Guarded by the head SHA the page
 * showed: fails when the branch has moved or a suggestion's lines no longer hold the code it was written against.
 */
export async function commitSuggestions(octokit: Octokit, pr: PullRequest, edits: SuggestionEdit[], message: string): Promise<{ sha: string }> {
  const head = pr.head.repo
  if (!head) throw new Error('The head repository of this pull request no longer exists.')
  const [owner, repo] = [head.owner.login, head.name]
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${pr.head.ref}` })
  if (ref.object.sha !== pr.head.sha) throw new Error(`${pr.head.ref} has new commits since this page loaded. Reload the pull request and try again.`)
  const byPath = new Map<string, SuggestionEdit[]>()
  for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
  const changes: FileChange[] = []
  for (const [path, fileEdits] of byPath) {
    const text = await readFileExact(octokit, owner, repo, path, pr.head.sha)
    const applied = applySuggestionEdits(text, fileEdits)
    if ('error' in applied) throw new Error(applied.error)
    changes.push({ path, content: applied.text })
  }
  const res = await commitFiles(octokit, { owner, repo, branch: pr.head.ref, message, expectedHeadSha: pr.head.sha, changes })
  if ('error' in res) throw new Error(res.error)
  return { sha: res.sha }
}
