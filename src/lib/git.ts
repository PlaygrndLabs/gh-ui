// Local git as plain functions: parsers for git's output and one client over a runner, so nothing here needs a page,
// and the tests run the same commands against a real repository. Electron checks every command (electron/git-policy.cjs).

import { parseUnifiedDiff, type FileDiff } from './diff'
import { native, type GitAuth, type GitResult } from './platform'

export interface StatusEntry {
  path: string
  origPath?: string
  index: string
  worktree: string
}

export interface RepoState {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  entries: StatusEntry[]
}

export interface LogEntry {
  sha: string
  author: string
  date: string
  subject: string
}

/** Where a branch exists: both means a local branch and origin's branch of the same name. */
export type BranchLocation = 'both' | 'local' | 'remote'

export interface BranchState {
  name: string
  current: boolean
  location: BranchLocation
  upstream: string | null
  ahead: number
  behind: number
  /** Its upstream was deleted on the remote. */
  gone: boolean
  sha: string
  date: string
}

/** Parses `git status --porcelain=v1 -b -z`. */
export function parseStatus(out: string): RepoState {
  const parts = out.split('\0').filter(Boolean)
  const state: RepoState = { branch: null, upstream: null, ahead: 0, behind: 0, entries: [] }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('## ')) {
      const head = p.slice(3)
      const m = head.match(/^(?:No commits yet on )?([^.\s]+(?:\.[^.\s]+)*?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
      state.branch = m?.[1] ?? head
      state.upstream = m?.[2] ?? null
      const counts = m?.[3] ?? ''
      state.ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0)
      state.behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }
    const x = p[0]
    const y = p[1]
    const path = p.slice(3)
    const entry: StatusEntry = { path, index: x, worktree: y }
    // ORIG_PATH follows any rename/copy, including work-tree ones (` R` for intent-to-add files).
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') entry.origPath = parts[++i]
    state.entries.push(entry)
  }
  return state
}

/** Merge-conflict entries (UU, AA, DD, AU, UA, DU, UD): neither staged nor unstaged. */
export const isUnmerged = (e: StatusEntry) => e.index === 'U' || e.worktree === 'U' || (e.index === 'A' && e.worktree === 'A') || (e.index === 'D' && e.worktree === 'D')

export const isStaged = (e: StatusEntry) => !isUnmerged(e) && e.index !== ' ' && e.index !== '?'

/** Paths to restore or stage together: a rename's old path goes with the new one; a copy's source does not. */
export const changePaths = (e: StatusEntry) => ((e.index === 'R' || e.worktree === 'R') && e.origPath ? [e.origPath, e.path] : [e.path])

const LOG_FORMAT = '--pretty=format:%H%x1f%an%x1f%aI%x1f%s'

export function parseCommitLog(out: string): LogEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, author, date, subject] = l.split('\x1f')
      return { sha, author, date, subject }
    })
}

const BRANCH_FORMAT = '--format=%(refname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(objectname:short)%1f%(committerdate:iso-strict)%1f%(HEAD)'

/** Parses `git branch --all` in BRANCH_FORMAT into one entry per branch name, the current one first and then the newest. */
export function parseBranches(out: string, remote = 'origin'): BranchState[] {
  const remotePrefix = `refs/remotes/${remote}/`
  const local = new Map<string, BranchState>()
  const remoteOnly = new Map<string, BranchState>()
  for (const line of out.split('\n')) {
    const [ref, upstream, track, sha, date, head] = line.split('\x1f')
    if (ref?.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length)
      local.set(name, {
        name,
        current: head === '*',
        location: 'local',
        upstream: upstream || null,
        ahead: Number(track?.match(/ahead (\d+)/)?.[1] ?? 0),
        behind: Number(track?.match(/behind (\d+)/)?.[1] ?? 0),
        gone: track === 'gone',
        sha,
        date,
      })
    } else if (ref?.startsWith(remotePrefix)) {
      const name = ref.slice(remotePrefix.length)
      // origin/HEAD only points at the default branch.
      if (name !== 'HEAD') remoteOnly.set(name, { name, current: false, location: 'remote', upstream: null, ahead: 0, behind: 0, gone: false, sha, date })
    }
  }
  for (const [name, branch] of local) {
    if (remoteOnly.delete(name)) branch.location = 'both'
  }
  return [...local.values(), ...remoteOnly.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
}

/** Runs git in one repository; withAuth marks the commands that talk to the remote. */
export type GitRunner = (args: string[], withAuth: boolean) => Promise<GitResult>

export type GitClient = ReturnType<typeof createGitClient>

export function createGitClient(run: GitRunner) {
  const git = async (args: string[], withAuth = false) => {
    const res = await run(args, withAuth)
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || `git ${args[0]} failed`).trim())
    return res.stdout
  }
  return {
    status: async () => parseStatus(await git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])),
    /** Empty when there's no origin. */
    remoteUrl: async () => (await git(['remote', 'get-url', 'origin']).catch(() => '')).trim(),
    branchNames: async () => (await git(['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean),
    branches: async () => parseBranches(await git(['branch', '--all', BRANCH_FORMAT])),
    async fileDiff(entry: StatusEntry): Promise<FileDiff | null> {
      if (entry.index === '?' && entry.worktree === '?') {
        // --no-index exits 1 when the files differ, which here they always do.
        const res = await run(['diff', '--no-index', '--', '/dev/null', entry.path], false)
        return parseUnifiedDiff(res.stdout)[0] ?? null
      }
      const out = await git(['diff', 'HEAD', '--', entry.path]).catch(() => git(['diff', '--cached', '--', entry.path]))
      return parseUnifiedDiff(out)[0] ?? null
    },
    stagedDiff: () => git(['diff', '--cached']),
    /** The newest commits of `ref`, or of the checked-out branch. Empty before the first commit. */
    async log(ref?: string, limit = 200): Promise<LogEntry[]> {
      const res = await run(['log', '-n', String(limit), LOG_FORMAT, ...(ref ? [ref, '--'] : [])], false)
      return res.code === 0 ? parseCommitLog(res.stdout) : []
    },
    async show(sha: string) {
      const res = await run(['show', '--format=%B%x1e', '--patch', '--no-color', sha], false)
      const [message, patch = ''] = res.stdout.split('\x1e')
      return { message: message.trim(), files: parseUnifiedDiff(patch) }
    },
    publishBranch: () => git(['push', '-u', 'origin', 'HEAD'], true),
    pull: () => git(['pull', '--ff-only'], true),
    push: () => git(['push'], true),
    fetch: () => git(['fetch', '--prune', 'origin'], true),
    switchTo: (branch: string) => git(['switch', branch]),
    createBranch: (branch: string) => git(['switch', '-c', branch]),
    // A path-less `git reset` would also drop MERGE_HEAD / CHERRY_PICK_HEAD.
    unstageAll: () => git(['reset', '-q', '--', '.']),
    stageAll: () => git(['add', '-A']),
    stage: (e: StatusEntry) => git(['add', '--', ...changePaths(e)]),
    unstage: (e: StatusEntry) => git(['restore', '--staged', '--', ...changePaths(e)]),
    commit: (summary: string, description = '') => git(['commit', '-m', summary, ...(description.trim() ? ['-m', description] : [])]),
    /** Takes back the last commit and leaves its changes staged. */
    undoCommit: () => git(['reset', '--soft', 'HEAD~1']),
    discard: (e: StatusEntry) => (e.index === '?' ? git(['clean', '-f', '--', e.path]) : git(['restore', '--staged', '--worktree', '--source=HEAD', '--', ...changePaths(e)])),
  }
}

/** The client for a repository the desktop app has registered. */
export function localGit(repoId: string, auth?: GitAuth): GitClient {
  return createGitClient((args, withAuth) => native!.git(repoId, args, withAuth ? auth : undefined))
}
