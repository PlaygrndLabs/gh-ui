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
  parents: string[]
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
  /** The other worktree it's checked out in, which stops it being checked out here. */
  worktree: string | null
}

/** Parses `git status --porcelain=v1 -b -z`. */
export function parseStatus(out: string): RepoState {
  const parts = out.split('\0').filter(Boolean)
  const state: RepoState = { branch: null, upstream: null, ahead: 0, behind: 0, entries: [] }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('## ')) {
      const head = p.slice(3)
      if (head.startsWith('HEAD (no branch)')) {
        state.branch = 'HEAD'
        continue
      }
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

const LOG_FORMAT = '--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1f%P'

export function parseCommitLog(out: string): LogEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, author, date, subject, parents] = l.split('\x1f')
      return { sha, author, date, subject, parents: parents ? parents.split(' ') : [] }
    })
}

const BRANCH_FORMAT = '--format=%(refname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(objectname:short)%1f%(committerdate:iso-strict)%1f%(HEAD)%1f%(worktreepath)'

/** Parses `git branch --all` in BRANCH_FORMAT into one entry per branch name, the current one first and then the newest. */
export function parseBranches(out: string, remote = 'origin'): BranchState[] {
  const remotePrefix = `refs/remotes/${remote}/`
  const local = new Map<string, BranchState>()
  const remoteOnly = new Map<string, BranchState>()
  for (const line of out.split('\n')) {
    const [ref, upstream, track, sha, date, head, worktree] = line.split('\x1f')
    // "(HEAD detached at abc123)": a commit is checked out rather than a branch.
    if (ref?.startsWith('(') && head === '*') local.set('HEAD', { name: 'HEAD', current: true, location: 'local', upstream: null, ahead: 0, behind: 0, gone: false, sha, date, worktree: null })
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
        // Git gives the path for the branch checked out here too.
        worktree: head === '*' ? null : worktree || null,
      })
    } else if (ref?.startsWith(remotePrefix)) {
      const name = ref.slice(remotePrefix.length)
      // origin/HEAD only points at the default branch.
      if (name !== 'HEAD') remoteOnly.set(name, { name, current: false, location: 'remote', upstream: null, ahead: 0, behind: 0, gone: false, sha, date, worktree: null })
    }
  }
  for (const [name, branch] of local) {
    if (remoteOnly.delete(name)) branch.location = 'both'
  }
  return [...local.values(), ...remoteOnly.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
}

/** A stash, newest first in a list. `ref` is its place now (stash@{n}), which moves as others come and go; `sha` doesn't. */
export interface StashEntry {
  ref: string
  sha: string
  /** The branch it was made on, or null for a detached HEAD. */
  branch: string | null
  message: string
}

/** Parses `git stash list` in STASH_FORMAT. git names the branch in the subject: "WIP on x: …" or, with a message, "On x: …". */
export function parseStashList(out: string): StashEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref = '', sha = '', message = ''] = line.split('\x1f')
      const name = /^(?:WIP on|On) (.+?): /.exec(message)?.[1] ?? null
      return { ref, sha, branch: name === '(no branch)' ? null : name, message }
    })
}

const STASH_FORMAT = '--format=%gd%x1f%H%x1f%gs'

export interface Worktree {
  path: string
  name: string
  sha: string
  /** Null when its HEAD is detached. */
  branch: string | null
  main: boolean
  /** Git can't find its folder, which can also mean it belongs to another machine or an unmounted disk. */
  missing: boolean
}

/** Parses `git worktree list --porcelain`, which lists the main worktree first. A bare main worktree has no files to open, so it's left out. */
export function parseWorktrees(out: string): Worktree[] {
  const blocks = out.split('\n\n').filter((block) => block.trim())
  return blocks.flatMap((block, i) => {
    const fields = new Map(block.split('\n').map((line): [string, string] => [line.split(' ', 1)[0], line.slice(line.indexOf(' ') + 1)]))
    const path = fields.get('worktree')
    if (!path || fields.has('bare')) return []
    return [{ path, name: path.split('/').pop() || path, sha: fields.get('HEAD') ?? '', branch: fields.get('branch')?.replace('refs/heads/', '') ?? null, main: i === 0, missing: fields.has('prunable') }]
  })
}

export interface GitRemote {
  name: string
  url: string
}

/** The remotes in `git remote -v`, each once. */
export function parseRemotes(out: string): GitRemote[] {
  const remotes: GitRemote[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\t(.+) \(fetch\)$/)
    if (m) remotes.push({ name: m[1], url: m[2] })
  }
  return remotes
}

/** The remote a folder syncs with: origin, or whichever it has when it has no origin. */
export const primaryRemote = (remotes: GitRemote[]): GitRemote | null => remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null

/** Runs git in one repository; withAuth marks the commands that talk to the remote. */
export type GitRunner = (args: string[], withAuth: boolean) => Promise<GitResult>

/** Puts the newest commits in a new order, newest first. Electron checks the order and runs the rebase. */
export type CommitReorderer = (order: string[]) => Promise<GitResult>

export type IdentityKey = 'user.name' | 'user.email'

export type GitClient = ReturnType<typeof createGitClient>

/**
 * A commit in a branch's history, marked when it's still to push (↑) or to pull (↓). `elsewhere` marks a commit to
 * push that the remote already has on another branch: main's commits, after merging main in.
 */
export type HistoryRow = LogEntry & { mark?: '↑' | '↓'; elsewhere?: boolean }

const unmarked = (c: LogEntry): HistoryRow => c

/** What a drag in History can rearrange: the newest commits only this clone has, as far back as history is a straight line. */
export function reorderableCommits(rows: HistoryRow[]) {
  const end = rows.findIndex((r) => r.mark !== '↑' || r.elsewhere || r.parents.length > 1)
  return (end < 0 ? rows : rows.slice(0, end)).map((r) => r.sha)
}

/** `order` with the commit at `from` moved into the gap before index `gap` (`order.length` is the gap after the last). */
export function moveCommit(order: string[], from: number, gap: number) {
  const next = order.filter((_, i) => i !== from)
  next.splice(gap > from ? gap - 1 : gap, 0, order[from])
  return next
}

/** What the repository has stopped in the middle of. */
export type RepoOperation = 'merge' | 'rebase' | 'revert' | 'cherry-pick'

const OPERATION_HEADS: Array<[string, RepoOperation]> = [['MERGE_HEAD', 'merge'], ['REBASE_HEAD', 'rebase'], ['REVERT_HEAD', 'revert'], ['CHERRY_PICK_HEAD', 'cherry-pick']]

/** What git diffs against for a commit with no parent. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** How many commits a side of a branch comparison lists; past that it says "N+". */
export const COMPARE_LIMIT = 500

/** Another program (an editor, a terminal) holds the index for a moment. Git changes nothing when it says this, so trying again is safe. */
const INDEX_LOCKED = /index\.lock|another git process/i
const LOCK_RETRY_MS = [100, 250, 500, 1000]

export function createGitClient(run: GitRunner, reorder?: CommitReorderer) {
  const git = async (args: string[], withAuth = false) => {
    let res = await run(args, withAuth)
    for (const wait of LOCK_RETRY_MS) {
      if (res.code === 0 || !INDEX_LOCKED.test(res.stderr)) break
      await new Promise((resolve) => setTimeout(resolve, wait))
      res = await run(args, withAuth)
    }
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || `git ${args[0]} failed`).trim())
    return res.stdout
  }
  const status = async () => parseStatus(await git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']))
  const log = async (revisions: string[], limit = 200): Promise<LogEntry[]> => {
    const res = await run(['log', '-n', String(limit), LOG_FORMAT, ...revisions, '--'], false)
    return res.code === 0 ? parseCommitLog(res.stdout) : []
  }
  /** Where a stash is in the list right now: other stashes made since push it down. */
  const stashRef = async (sha: string) => {
    const found = parseStashList(await git(['stash', 'list', STASH_FORMAT])).find((s) => s.sha === sha)
    if (!found) throw new Error('That stash is no longer there.')
    return found.ref
  }
  const remotes = async () => parseRemotes(await git(['remote', '-v']))
  const remoteName = async () => primaryRemote(await remotes().catch(() => []))?.name ?? 'origin'
  const branchNames = async () => (await git(['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean)
  /** What the remote's HEAD names, or null when this clone doesn't know. */
  const defaultBranch = async () => {
    const remote = await remoteName()
    const res = await run(['rev-parse', '--abbrev-ref', `${remote}/HEAD`], false)
    const name = res.stdout.trim().slice(remote.length + 1)
    return res.code === 0 && name && name !== 'HEAD' ? name : null
  }
  /** Conflicts stop git with an error, but they're a state to finish from, not a failure. */
  const conflictsIn = async (res: GitResult, command: string) => {
    if (res.code === 0) return { conflicts: false }
    if ((await status()).entries.some(isUnmerged)) return { conflicts: true }
    throw new Error((res.stderr || res.stdout || `git ${command} failed`).trim())
  }
  const stopsOnConflicts = async (args: string[]) => conflictsIn(await run(args, false), args[0])
  return {
    status,
    /** Empty when there's no origin. */
    remoteUrl: async () => (await git(['remote', 'get-url', 'origin']).catch(() => '')).trim(),
    branchNames,
    /** Throws when git can't tell, so nothing can mistake a failure for a folder with no remote. */
    remotes,
    addRemote: (name: string, url: string) => git(['remote', 'add', name, url]),
    setRemoteUrl: (name: string, url: string) => git(['remote', 'set-url', name, url]),
    removeRemote: (name: string) => git(['remote', 'remove', name]),
    /** This repository's own value, empty when it uses your global one. */
    identity: async (key: IdentityKey) => (await run(['config', '--local', '--get', key], false)).stdout.trim(),
    setIdentity: (key: IdentityKey, value: string) => (value ? git(['config', '--local', key, value]) : run(['config', '--local', '--unset', key], false)),
    branches: async () => parseBranches(await git(['branch', '--all', BRANCH_FORMAT]), await remoteName()),
    worktrees: async () => parseWorktrees(await git(['worktree', 'list', '--porcelain'])),
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
    log: (ref?: string, limit = 200) => log(ref ? [ref] : [], limit),
    /**
     * A branch's commits by where they are, and in `history` as a timeline. Not pushed means its upstream doesn't have it
     * yet, as GitHub Desktop counts: after merging main in, main's commits go up with the push too. Those the remote
     * already has on another branch are marked `elsewhere`, and `notOnRemote` lists only the ones no branch there has.
     */
    async branchCommits(branch: BranchState, limit = 100) {
      const remote = await remoteName()
      const ref = branch.location === 'remote' ? `${remote}/${branch.name}` : branch.name
      // A long-lived branch that just took in main can be far ahead: every commit there is to push gets listed.
      const ahead = Math.min(branch.ahead, 1000)
      const all = await log([ref], limit + ahead)
      if (branch.location === 'remote') return { local: [] as LogEntry[], incoming: [] as LogEntry[], remote: all, notOnRemote: [] as string[], history: all.map(unmarked) }
      const notOnAnyRemote = await log([ref, '--not', `--remotes=${remote}`], limit + ahead)
      // Without an upstream to push to, what's new is what no branch on the remote has.
      const local = branch.upstream && !branch.gone ? await log([ref, '--not', branch.upstream], limit + ahead) : notOnAnyRemote
      const toPush = new Set(local.map((c) => c.sha))
      const onlyHere = new Set(notOnAnyRemote.map((c) => c.sha))
      const incoming = branch.upstream && branch.behind ? await log([`${ref}..${branch.upstream}`], limit) : []
      // In log order, with what's not pulled after the run of newest commits to push.
      const firstPushed = all.findIndex((c) => !toPush.has(c.sha))
      const split = firstPushed < 0 ? all.length : firstPushed
      const row = (c: LogEntry): HistoryRow => (toPush.has(c.sha) ? { ...c, mark: '↑', ...(onlyHere.has(c.sha) ? {} : { elsewhere: true }) } : c)
      const history = [...all.slice(0, split).map(row), ...incoming.map((c): HistoryRow => ({ ...c, mark: '↓' })), ...all.slice(split).map(row)]
      return { local, incoming, remote: all.filter((c) => !toPush.has(c.sha)), notOnRemote: notOnAnyRemote.map((c) => c.sha), history }
    },
    /** A merge's changes are what it brought onto its first parent, as GitHub shows them, not only its conflict fixes. */
    async show(sha: string) {
      const res = await run(['show', '--format=%B%x1e', '--patch', '--diff-merges=first-parent', '--no-color', sha], false)
      const [message, patch = ''] = res.stdout.split('\x1e')
      return { message: message.trim(), files: parseUnifiedDiff(patch) }
    },
    /**
     * What a run of commits adds up to, newest first: from just before the oldest to the newest, so a change that was
     * later undone doesn't show. `others` counts commits the span holds that weren't asked for, which a merge brings in.
     */
    async combinedDiff(shas: string[]) {
      const newest = shas[0]
      const oldest = shas[shas.length - 1]
      // Commits on two lines of history have no single before and after.
      if ((await log([oldest, '--not', newest], 1)).length) return { related: false, others: 0, files: [] as FileDiff[] }
      const parent = await run(['rev-parse', '-q', '--verify', `${oldest}^`], false)
      const base = parent.code === 0 ? parent.stdout.trim() : null
      const span = await log(base ? [newest, '--not', base] : [newest], shas.length + 1000)
      const asked = new Set(shas)
      return { related: true, others: span.filter((c) => !asked.has(c.sha)).length, files: parseUnifiedDiff(await git(['diff', base ?? EMPTY_TREE, newest])) }
    },
    /**
     * The revision for a branch in a comparison. `preferRemote` takes the remote's copy of a branch that's in both
     * places, as the one to compare against: a local main nobody has pulled into for weeks would say nothing changed.
     */
    async compareRef(branch: BranchState, preferRemote = false) {
      if (branch.location === 'local' || (branch.location === 'both' && !preferRemote)) return branch.name
      return `${await remoteName()}/${branch.name}`
    },
    /** The commits only `ref` has (ahead) and only `base` has (behind), newest first, up to `limit` each. */
    async compareCommits(ref: string, base: string, limit = COMPARE_LIMIT) {
      const [ahead, behind] = await Promise.all([log([ref, '--not', base], limit), log([base, '--not', ref], limit)])
      return { ahead, behind }
    },
    /** What `ref` changed since it split from `base`, as a pull request from `ref` into `base` shows it. */
    compareDiff: async (base: string, ref: string) => parseUnifiedDiff(await git(['diff', `${base}...${ref}`])),
    addOrigin: (url: string) => git(['remote', 'add', 'origin', url]),
    publishBranch: async () => git(['push', '-u', await remoteName(), 'HEAD'], true),
    pull: () => git(['pull', '--ff-only'], true),
    push: () => git(['push'], true),
    fetch: async () => git(['fetch', '--prune', await remoteName()], true),
    switchTo: (branch: string) => git(['switch', branch]),
    renameBranch: (from: string, to: string) => git(['branch', '-m', '--', from, to]),
    /** Forced, as GitHub Desktop's is: the app asks first, and a branch that was never merged is what people delete. */
    deleteBranch: (branch: string) => git(['branch', '-D', '--', branch]),
    defaultBranch,
    /** The branch others merge into: the remote's default, or a local main or master when there's no remote to ask. */
    mainBranch: async () => {
      const known = await defaultBranch()
      if (known) return known
      const names = await branchNames()
      return names.find((n) => n === 'main' || n === 'master') ?? null
    },
    merge: (ref: string, options: { squash?: boolean } = {}) => stopsOnConflicts(['merge', options.squash ? '--squash' : '--no-edit', ref]),
    rebase: (ref: string) => stopsOnConflicts(['rebase', ref]),
    continueRebase: () => stopsOnConflicts(['rebase', '--continue']),
    reorderCommits: async (order: string[]) => conflictsIn(await reorder!(order), 'rebase'),
    abortOperation: (operation: RepoOperation) => git([operation, '--abort']),
    /** Commits a merge whose conflicts are resolved, with the message git prepared. */
    finishMerge: () => git(['commit', '--no-edit']),
    async operation(): Promise<RepoOperation | null> {
      for (const [ref, operation] of OPERATION_HEADS) if ((await run(['rev-parse', '-q', '--verify', ref], false)).code === 0) return operation
      return null
    },
    createBranch: (branch: string) => git(['switch', '-c', branch]),
    createBranchAt: (branch: string, sha: string) => git(['switch', '-c', branch, sha]),
    /** Puts HEAD on a commit instead of a branch. */
    checkoutCommit: (sha: string) => git(['switch', '--detach', sha]),
    /** Rewrites the last commit, with whatever is staged. */
    amendCommit: (summary: string, description = '') => git(['commit', '--amend', '-m', summary, ...(description.trim() ? ['-m', description] : [])]),
    revertCommit: (sha: string) => stopsOnConflicts(['revert', '--no-edit', sha]),
    cherryPick: (sha: string) => stopsOnConflicts(['cherry-pick', sha]),
    /** Moves the branch back to a commit. What came after it stays in the folder as uncommitted changes. */
    resetTo: (sha: string) => git(['reset', '-q', sha]),
    createTag: (name: string, sha: string) => git(['tag', name, sha]),
    tagsAt: async (sha: string) => (await git(['tag', '--points-at', sha])).split('\n').filter(Boolean),
    /** Saves every change, new files too, and leaves the working tree clean. */
    stash: () => git(['stash', 'push', '-u']),
    stashes: async () => parseStashList(await git(['stash', 'list', STASH_FORMAT])),
    /** What a stash holds, new files included, as diffs against the commit it was made on. */
    stashFiles: async (sha: string) => parseUnifiedDiff(await git(['stash', 'show', '-p', '--include-untracked', '--no-color', sha])),
    /** Puts a stash's changes back and drops it; if they conflict, git keeps the stash. */
    restoreStash: async (sha: string) => git(['stash', 'pop', await stashRef(sha)]),
    dropStash: async (sha: string) => git(['stash', 'drop', await stashRef(sha)]),
    stage: (...entries: StatusEntry[]) => git(['add', '--', ...entries.flatMap(changePaths)]),
    // With paths, reset leaves MERGE_HEAD / CHERRY_PICK_HEAD alone, and unlike restore it works before the first commit.
    unstage: (...entries: StatusEntry[]) => git(['reset', '-q', '--', ...entries.flatMap(changePaths)]),
    commit: (summary: string, description = '') => git(['commit', '-m', summary, ...(description.trim() ? ['-m', description] : [])]),
    /** Takes back the last commit and leaves its changes staged. */
    undoCommit: () => git(['reset', '--soft', 'HEAD~1']),
    /** Asks git about the file first: the row that was clicked can be out of date by the time the dialog is answered. */
    async discard({ path }: StatusEntry) {
      const e = (await status()).entries.find((entry) => entry.path === path)
      if (!e) return
      await (e.index === '?' ? git(['clean', '-f', '--', e.path]) : git(['restore', '--staged', '--worktree', '--source=HEAD', '--', ...changePaths(e)]))
    },
  }
}

/** The client for a repository the desktop app has registered. */
export function localGit(repoId: string, auth?: GitAuth): GitClient {
  return createGitClient((args, withAuth) => native!.git(repoId, args, withAuth ? auth : undefined), (order) => native!.repos.reorderCommits(repoId, order))
}
