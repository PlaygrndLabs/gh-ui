import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { changePaths, createGitClient, isStaged, isUnmerged, moveCommit, parseBranches, parseCommitLog, parseStashList, parseStatus, parseWorktrees, reorderableCommits, type GitClient, type HistoryRow } from './git'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
type RunGit = (args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>
const { validateGitArgs, gitCommandEnv, reorderCommits } = require('../../electron/git-policy.cjs') as { validateGitArgs(args: string[]): void; gitCommandEnv(sub: string): Record<string, string>; reorderCommits(git: RunGit, order: string[]): ReturnType<RunGit> }

describe('parseStashList', () => {
  it('reads each stash’s place, commit and branch', () => {
    const out = ['stash@{0}\x1fa1\x1fWIP on feat/x: 1234567 fix it', 'stash@{1}\x1fb2\x1fOn playbook-share: !!GitHub_Desktop<playbook-share>', 'stash@{2}\x1fc3\x1fWIP on (no branch): 1234567 x'].join('\n')
    expect(parseStashList(out)).toEqual([
      { ref: 'stash@{0}', sha: 'a1', branch: 'feat/x', message: 'WIP on feat/x: 1234567 fix it' },
      { ref: 'stash@{1}', sha: 'b2', branch: 'playbook-share', message: 'On playbook-share: !!GitHub_Desktop<playbook-share>' },
      { ref: 'stash@{2}', sha: 'c3', branch: null, message: 'WIP on (no branch): 1234567 x' },
    ])
  })
})

describe('parseStatus', () => {
  it('reads the branch, its upstream and the counts', () => {
    expect(parseStatus('## main...origin/main [ahead 2, behind 1]\0')).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(parseStatus('## No commits yet on main\0')).toMatchObject({ branch: 'main', upstream: null })
  })

  it('keeps the old path of a rename', () => {
    const { entries } = parseStatus('## main\0R  new.ts\0old.ts\0 M a.ts\0?? b.ts\0')
    expect(entries).toEqual([
      { path: 'new.ts', origPath: 'old.ts', index: 'R', worktree: ' ' },
      { path: 'a.ts', index: ' ', worktree: 'M' },
      { path: 'b.ts', index: '?', worktree: '?' },
    ])
    expect(changePaths(entries[0])).toEqual(['old.ts', 'new.ts'])
  })

  it('tells staged from unmerged', () => {
    expect(isStaged({ path: 'a', index: 'M', worktree: ' ' })).toBe(true)
    expect(isStaged({ path: 'a', index: '?', worktree: '?' })).toBe(false)
    expect(isUnmerged({ path: 'a', index: 'U', worktree: 'U' })).toBe(true)
    expect(isStaged({ path: 'a', index: 'A', worktree: 'A' })).toBe(false)
  })
})

describe('when another program holds the index', () => {
  const locked = { code: 128, stdout: '', stderr: "fatal: Unable to create '/r/.git/index.lock': File exists." }
  const ok = { code: 0, stdout: '', stderr: '' }

  it('tries again until it clears', async () => {
    const run = vi.fn().mockResolvedValueOnce(locked).mockResolvedValueOnce(locked).mockResolvedValue(ok)
    await createGitClient(run).stage({ path: 'a', index: ' ', worktree: 'M' })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('gives up with git’s message if it never does', async () => {
    const run = vi.fn().mockResolvedValue(locked)
    await expect(createGitClient(run).stage({ path: 'a', index: ' ', worktree: 'M' })).rejects.toThrow(/index\.lock/)
    expect(run).toHaveBeenCalledTimes(5)
  }, 5000)

  it('does not retry other failures', async () => {
    const run = vi.fn().mockResolvedValue({ code: 128, stdout: '', stderr: 'fatal: pathspec did not match' })
    await expect(createGitClient(run).stage({ path: 'a', index: ' ', worktree: 'M' })).rejects.toThrow(/pathspec/)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('parseCommitLog', () => {
  it('splits the fields, keeping separators out of the subject', () => {
    expect(parseCommitLog('abc\x1fLena\x1f2026-01-01T00:00:00Z\x1ffix: a | b\x1fp1 p2\n')).toEqual([{ sha: 'abc', author: 'Lena', date: '2026-01-01T00:00:00Z', subject: 'fix: a | b', parents: ['p1', 'p2'] }])
  })
})

describe('moveCommit', () => {
  const order = ['a', 'b', 'c', 'd']
  it('moves a commit up', () => expect(moveCommit(order, 2, 0)).toEqual(['c', 'a', 'b', 'd']))
  it('moves a commit down', () => expect(moveCommit(order, 0, 2)).toEqual(['b', 'a', 'c', 'd']))
  it('moves a commit to the end', () => expect(moveCommit(order, 1, 4)).toEqual(['a', 'c', 'd', 'b']))
})

describe('reorderableCommits', () => {
  const row = (sha: string, mark?: '↑' | '↓', parents = ['p']): HistoryRow => ({ sha, author: '', date: '', subject: '', parents, mark })
  it('stops at the first commit already pushed', () => expect(reorderableCommits([row('a', '↑'), row('b', '↑'), row('c'), row('d', '↑')])).toEqual(['a', 'b']))
  it('stops at what is still to pull', () => expect(reorderableCommits([row('a', '↑'), row('b', '↓')])).toEqual(['a']))
  it('stops at a merge', () => expect(reorderableCommits([row('a', '↑'), row('m', '↑', ['x', 'y']), row('c', '↑')])).toEqual(['a']))
  it('includes a first commit, which has no parent', () => expect(reorderableCommits([row('a', '↑'), row('b', '↑', [])])).toEqual(['a', 'b']))
  it('stops at a commit the remote has on another branch', () => expect(reorderableCommits([row('a', '↑'), { ...row('b', '↑'), elsewhere: true }, row('c', '↑')])).toEqual(['a']))
})

describe('parseBranches', () => {
  const line = (...fields: string[]) => fields.join('\x1f')

  it('merges local and remote branches of one name, current first and then the newest', () => {
    const out = [
      line('refs/heads/old', '', '', 'a1', '2026-01-01T00:00:00Z', ' '),
      line('refs/heads/main', 'origin/main', 'ahead 1, behind 2', 'b2', '2026-01-02T00:00:00Z', '*'),
      line('refs/heads/stale', 'origin/stale', 'gone', 'c3', '2026-01-03T00:00:00Z', ' '),
      line('refs/remotes/origin/HEAD', '', '', 'b2', '2026-01-02T00:00:00Z', ' '),
      line('refs/remotes/origin/main', '', '', 'b0', '2026-01-02T00:00:00Z', ' '),
      line('refs/remotes/origin/release', '', '', 'd4', '2026-01-04T00:00:00Z', ' '),
      line('refs/remotes/fork/other', '', '', 'e5', '2026-01-05T00:00:00Z', ' '),
      '(HEAD detached at b2)',
      '',
    ].join('\n')
    const branches = parseBranches(out)
    expect(branches.map((b) => [b.name, b.location])).toEqual([
      ['main', 'both'],
      ['release', 'remote'],
      ['stale', 'local'],
      ['old', 'local'],
    ])
    expect(branches[0]).toMatchObject({ current: true, upstream: 'origin/main', ahead: 1, behind: 2, gone: false })
    expect(branches[2]).toMatchObject({ gone: true, ahead: 0, behind: 0 })
  })
})

describe('parseWorktrees', () => {
  it('names the main worktree, reads a detached HEAD and leaves out a bare main worktree', () => {
    const linked = 'worktree /w/b\nHEAD dc32efd000\ndetached\nprunable gitdir file points to non-existent location\n\n'
    expect(parseWorktrees(`worktree /w/a\nHEAD abc\nbranch refs/heads/feat/x\n\n${linked}`)).toEqual([
      { path: '/w/a', name: 'a', sha: 'abc', branch: 'feat/x', main: true, missing: false },
      { path: '/w/b', name: 'b', sha: 'dc32efd000', branch: null, main: false, missing: true },
    ])
    expect(parseWorktrees(`worktree /w/a.git\nbare\n\n${linked}`).map((w) => [w.name, w.main])).toEqual([['b', false]])
  })
})

// The real thing: the commands the app sends get past the policy Electron enforces, and git's output parses.
describe('createGitClient against a real repository', () => {
  let root: string
  let work: string
  let client: GitClient
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const raw = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env })).stdout
  const commitFile = async (cwd: string, name: string, message: string) => {
    await writeFile(join(cwd, name), `${message}\n`)
    await raw(cwd, 'add', name)
    await raw(cwd, 'commit', '-m', message)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gh-ui-git-'))
    const origin = join(root, 'origin.git')
    work = join(root, 'work')
    const other = join(root, 'other')
    await mkdir(origin)
    await raw(origin, 'init', '--bare', '-b', 'main')
    await raw(root, 'clone', origin, work)
    await raw(work, 'switch', '-c', 'main').catch(() => '')
    await commitFile(work, 'a.txt', 'first')
    await raw(work, 'push', '-u', 'origin', 'main')
    // Someone else pushes a new branch and a newer main.
    await raw(root, 'clone', origin, other)
    await commitFile(other, 'b.txt', 'theirs')
    await raw(other, 'push', 'origin', 'main')
    await raw(other, 'switch', '-c', 'release')
    await commitFile(other, 'c.txt', 'release')
    await raw(other, 'push', 'origin', 'release')
    await raw(work, 'fetch', 'origin')
    await raw(work, 'switch', '-c', 'spike')
    client = createGitClient(async (args) => {
      validateGitArgs(args)
      try {
        const { stdout, stderr } = await exec('git', args, { cwd: work, env: { ...env, ...gitCommandEnv(args[0]) } })
        return { code: 0, stdout, stderr }
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string }
        return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
      }
    })
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  it('reports where every branch lives and how far it has moved', async () => {
    const branches = await client.branches()
    const by = Object.fromEntries(branches.map((b) => [b.name, b]))
    expect(branches[0].name).toBe('spike')
    expect(by.spike).toMatchObject({ current: true, location: 'local', upstream: null })
    expect(by.main).toMatchObject({ current: false, location: 'both', upstream: 'origin/main', behind: 1, ahead: 0 })
    expect(by.release).toMatchObject({ current: false, location: 'remote', upstream: null })
    expect(by.HEAD).toBeUndefined()
  })

  it('lists worktrees and says which branches they hold, including one whose folder has gone', async () => {
    const elsewhere = join(root, 'elsewhere')
    await raw(work, 'worktree', 'add', '-b', 'held', elsewhere)
    await raw(work, 'worktree', 'add', '-b', 'stranded', join(root, 'stranded'))
    await rm(join(root, 'stranded'), { recursive: true, force: true })
    try {
      const trees = await client.worktrees()
      expect(trees.map((w) => [w.name, w.branch, w.main, w.missing])).toEqual([
        ['work', 'spike', true, false],
        ['elsewhere', 'held', false, false],
        ['stranded', 'stranded', false, true],
      ])
      const by = Object.fromEntries((await client.branches()).map((b) => [b.name, b]))
      expect(by.held.worktree).toMatch(/elsewhere$/)
      expect(by.stranded.worktree).toMatch(/stranded$/)
      expect(by.spike.worktree).toBeNull()
      await expect(client.switchTo('held')).rejects.toThrow(/worktree/)
    } finally {
      await raw(work, 'worktree', 'remove', join(root, 'elsewhere'))
      await raw(work, 'worktree', 'prune')
      await raw(work, 'branch', '-D', 'held', 'stranded')
    }
  })

  it('adds a run of commits up to its net change', async () => {
    const tree = join(root, 'range')
    await raw(work, 'worktree', 'add', '-b', 'range', tree)
    const head = async () => (await raw(tree, 'rev-parse', 'HEAD')).trim()
    const paths = (r: { files: Array<{ newPath: string }> }) => r.files.map((f) => f.newPath)
    try {
      await commitFile(tree, 'x.txt', 'one')
      const one = await head()
      await commitFile(tree, 'x.txt', 'two')
      const two = await head()
      await commitFile(tree, 'y.txt', 'why')
      const three = await head()

      const net = await client.combinedDiff([two, one])
      expect(net).toMatchObject({ related: true, others: 0 })
      expect(net.files.map((f) => [f.newPath, f.status])).toEqual([['x.txt', 'added']])
      expect(net.files[0].patch).toContain('+two')
      expect(net.files[0].patch).not.toContain('one')
      expect(paths(await client.combinedDiff([three, two]))).toEqual(['x.txt', 'y.txt'])

      // From the very first commit there's nothing before it to compare with.
      const [first] = (await raw(tree, 'rev-list', '--max-parents=0', 'HEAD')).trim().split('\n')
      expect(paths(await client.combinedDiff([three, first]))).toEqual(['a.txt', 'x.txt', 'y.txt'])

      // Two lines of history have no combined change.
      const release = (await raw(work, 'rev-parse', 'origin/release')).trim()
      expect(await client.combinedDiff([three, release])).toEqual({ related: false, others: 0, files: [] })

      // The commit a merge brought in is part of the span even though it wasn't picked.
      await raw(tree, 'switch', '-c', 'range-side', one)
      await commitFile(tree, 'side.txt', 'side')
      await raw(tree, 'switch', 'range')
      await raw(tree, 'merge', '--no-edit', 'range-side')
      const merged = await client.combinedDiff([await head(), three])
      expect(merged.others).toBe(1)
      expect(paths(merged)).toEqual(['side.txt', 'y.txt'])
    } finally {
      await raw(work, 'worktree', 'remove', '--force', tree)
      await raw(work, 'branch', '-D', 'range', 'range-side').catch(() => '')
    }
  })

  it('compares a branch with another: the commits only each side has, and what each side changed since they split', async () => {
    const tree = join(root, 'compare')
    await raw(work, 'worktree', 'add', '-b', 'cmp', tree)
    const paths = (files: Array<{ newPath: string }>) => files.map((f) => f.newPath)
    const subjects = (commits: Array<{ subject: string }>) => commits.map((c) => c.subject)
    try {
      await commitFile(tree, 'm.txt', 'mine')
      const by = Object.fromEntries((await client.branches()).map((b) => [b.name, b]))
      expect(await client.compareRef(by.cmp)).toBe('cmp')
      expect(await client.compareRef(by.main)).toBe('main')
      // The remote's main has the commit this clone's main hasn't pulled.
      expect(await client.compareRef(by.main, true)).toBe('origin/main')
      expect(await client.compareRef(by.release)).toBe('origin/release')

      const { ahead, behind } = await client.compareCommits('cmp', 'origin/main')
      expect(subjects(ahead)).toEqual(['mine'])
      expect(subjects(behind)).toEqual(['theirs'])
      expect((await client.compareCommits('cmp', 'main')).behind).toEqual([])

      expect(paths(await client.compareDiff('origin/main', 'cmp'))).toEqual(['m.txt'])
      expect(paths(await client.compareDiff('cmp', 'origin/main'))).toEqual(['b.txt'])
    } finally {
      await raw(work, 'worktree', 'remove', '--force', tree)
      await raw(work, 'branch', '-D', 'cmp').catch(() => '')
    }
  })

  describe('reordering commits', () => {
    let tree: string
    let n = 0
    let inTree: GitClient
    const run = (cwd: () => string): RunGit => async (args, extra) => {
      try {
        const { stdout, stderr } = await exec('git', args, { cwd: cwd(), env: { ...env, ...extra } })
        return { code: 0, stdout, stderr }
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string }
        return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
      }
    }
    const subjects = async () => (await raw(tree, 'log', '--format=%s', 'origin/main..HEAD')).trim().split('\n')
    const shaOf = async (ref: string) => (await raw(tree, 'rev-parse', ref)).trim()
    /** Commits from newest to oldest, by ref. */
    const shas = async (...refs: string[]) => Promise.all(refs.map(shaOf))
    const rebasing = () => raw(tree, 'rev-parse', '--git-path', 'rebase-merge').then((dir) => stat(join(tree, dir.trim())).then(() => true, () => false))

    // Each test gets a branch tracking origin/main, so the commits it makes are the unpushed ones.
    beforeEach(async () => {
      tree = join(root, `reorder-${++n}`)
      await raw(work, 'worktree', 'add', '--track', '-b', `reorder-${n}`, tree, 'origin/main')
      inTree = createGitClient(async (args) => {
        validateGitArgs(args)
        return run(() => tree)(args, gitCommandEnv(args[0]))
      }, (order) => reorderCommits(run(() => tree), order))
    })
    afterEach(async () => {
      await raw(work, 'worktree', 'remove', '--force', tree)
    })

    it('rewrites the order and keeps every commit’s content', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await commitFile(tree, 'two.txt', 'two')
      await commitFile(tree, 'three.txt', 'three')
      const [three, two, one, base] = await shas('HEAD', 'HEAD~1', 'HEAD~2', 'HEAD~3')
      expect(await inTree.reorderCommits([two, three, one])).toEqual({ conflicts: false })
      expect(await subjects()).toEqual(['two', 'three', 'one'])
      // The commit below the lowest one moved doesn't need rewriting, and nothing pushed changes.
      expect(await shaOf('HEAD~2')).toBe(one)
      expect(await shaOf('HEAD~3')).toBe(base)
      expect((await raw(tree, 'show', '--name-only', '--format=', 'HEAD')).trim()).toBe('two.txt')
      expect((await raw(tree, 'status', '--porcelain')).trim()).toBe('')
      expect(await inTree.operation()).toBeNull()
    })

    it('marks exactly the unpushed commits as movable', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await commitFile(tree, 'two.txt', 'two')
      const branch = (await inTree.branches()).find((b) => b.name === `reorder-${n}`)!
      const { history } = await inTree.branchCommits(branch)
      expect(reorderableCommits(history)).toEqual(await shas('HEAD', 'HEAD~1'))
    })

    it('does nothing when the order is the same', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await commitFile(tree, 'two.txt', 'two')
      const [two, one] = await shas('HEAD', 'HEAD~1')
      await inTree.reorderCommits([two, one])
      expect(await shas('HEAD', 'HEAD~1')).toEqual([two, one])
    })

    it('refuses a commit that is already pushed', async () => {
      await commitFile(tree, 'one.txt', 'one')
      const [one, pushed] = await shas('HEAD', 'HEAD~1')
      await expect(inTree.reorderCommits([pushed, one])).rejects.toThrow(/changed/)
      expect(await shaOf('HEAD')).toBe(one)
    })

    it('refuses commits that are not the newest ones', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await commitFile(tree, 'two.txt', 'two')
      await commitFile(tree, 'three.txt', 'three')
      const [three, two, one] = await shas('HEAD', 'HEAD~1', 'HEAD~2')
      await expect(inTree.reorderCommits([one, two])).rejects.toThrow(/changed/)
      expect(await shaOf('HEAD')).toBe(three)
    })

    it('refuses to flatten a merge', async () => {
      const side = `side-${n}`
      await raw(tree, 'switch', '-c', side)
      await commitFile(tree, 'side.txt', 'side')
      await raw(tree, 'switch', `reorder-${n}`)
      await commitFile(tree, 'main-side.txt', 'ours')
      await raw(tree, 'merge', '--no-edit', side)
      await commitFile(tree, 'top.txt', 'top')
      const [top, merge] = await shas('HEAD', 'HEAD~1')
      await expect(inTree.reorderCommits([merge, top])).rejects.toThrow(/changed/)
      expect(await shaOf('HEAD')).toBe(top)
      await raw(work, 'branch', '-D', side)
    })

    it('stops at a conflict in the rebase state, and continues once it is resolved', async () => {
      await commitFile(tree, 'same.txt', 'one')
      await commitFile(tree, 'same.txt', 'two')
      await commitFile(tree, 'other.txt', 'other')
      const [other, two, one] = await shas('HEAD', 'HEAD~1', 'HEAD~2')
      expect(await inTree.reorderCommits([other, one, two])).toEqual({ conflicts: true })
      expect(await inTree.operation()).toBe('rebase')
      expect((await inTree.status()).entries.some(isUnmerged)).toBe(true)

      await writeFile(join(tree, 'same.txt'), 'two\n')
      await raw(tree, 'add', 'same.txt')
      expect(await inTree.continueRebase()).toEqual({ conflicts: true })
      await writeFile(join(tree, 'same.txt'), 'one\n')
      await raw(tree, 'add', 'same.txt')
      expect(await inTree.continueRebase()).toEqual({ conflicts: false })
      expect(await inTree.operation()).toBeNull()
      expect(await subjects()).toEqual(['other', 'one', 'two'])
    })

    it('goes back to how it was when a conflict is aborted', async () => {
      await commitFile(tree, 'same.txt', 'one')
      await commitFile(tree, 'same.txt', 'two')
      const [two, one] = await shas('HEAD', 'HEAD~1')
      expect(await inTree.reorderCommits([one, two])).toEqual({ conflicts: true })
      await inTree.abortOperation('rebase')
      expect(await inTree.operation()).toBeNull()
      expect(await shas('HEAD', 'HEAD~1')).toEqual([two, one])
    })

    it('leaves no rebase behind when git stops for anything but a conflict', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await commitFile(tree, 'two.txt', 'two')
      const [two, one] = await shas('HEAD', 'HEAD~1')
      await rm(join(tree, 'two.txt'))
      await raw(tree, 'rm', '-q', '--cached', 'two.txt')
      await raw(tree, 'commit', '-q', '-m', 'three')
      await writeFile(join(tree, 'two.txt'), 'in the way\n')
      const three = await shaOf('HEAD')
      await expect(inTree.reorderCommits([two, three, one])).rejects.toThrow(/overwritten|untracked/i)
      expect(await rebasing()).toBe(false)
      expect(await shaOf('HEAD')).toBe(three)
    })

    it('lets git refuse uncommitted changes without touching the branch', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await commitFile(tree, 'two.txt', 'two')
      const [two, one] = await shas('HEAD', 'HEAD~1')
      await writeFile(join(tree, 'one.txt'), 'edited\n')
      await expect(inTree.reorderCommits([one, two])).rejects.toThrow(/unstaged|uncommitted/i)
      expect(await rebasing()).toBe(false)
      expect(await shaOf('HEAD')).toBe(two)
      expect((await raw(tree, 'status', '--porcelain')).trim()).toBe('M one.txt')
    })

    it('won’t touch a rebase that is already under way', async () => {
      await commitFile(tree, 'same.txt', 'one')
      await commitFile(tree, 'same.txt', 'two')
      const [two, one] = await shas('HEAD', 'HEAD~1')
      await inTree.reorderCommits([one, two])
      await expect(inTree.reorderCommits([one, two])).rejects.toThrow(/in progress/)
      expect(await inTree.operation()).toBe('rebase')
      await inTree.abortOperation('rebase')
    })

    it('keeps a commit that becomes empty', async () => {
      await commitFile(tree, 'one.txt', 'one')
      await raw(tree, 'commit', '--allow-empty', '-q', '-m', 'nothing')
      await commitFile(tree, 'two.txt', 'two')
      const [two, nothing, one] = await shas('HEAD', 'HEAD~1', 'HEAD~2')
      expect(await inTree.reorderCommits([nothing, two, one])).toEqual({ conflicts: false })
      expect(await subjects()).toEqual(['nothing', 'two', 'one'])
    })

    it('reorders down to the very first commit, with no remote', async () => {
      const fresh = join(root, 'reorder-root')
      await mkdir(fresh)
      await raw(fresh, 'init', '-q', '-b', 'main')
      await commitFile(fresh, 'one.txt', 'one')
      await commitFile(fresh, 'two.txt', 'two')
      const [two, one] = (await raw(fresh, 'log', '--format=%H')).trim().split('\n')
      const res = await reorderCommits(run(() => fresh), [one, two])
      expect(res.code).toBe(0)
      expect((await raw(fresh, 'log', '--format=%s')).trim().split('\n')).toEqual(['one', 'two'])
    })
  })

  describe('what a commit\'s menu does', () => {
    let tree: string
    let inTree: GitClient
    const head = async () => (await raw(tree, 'rev-parse', 'HEAD')).trim()
    const subject = async () => (await raw(tree, 'log', '-1', '--format=%s')).trim()

    beforeAll(async () => {
      tree = join(root, 'menu')
      await raw(work, 'worktree', 'add', '-b', 'menu', tree)
      inTree = createGitClient(async (args) => {
        validateGitArgs(args)
        try {
          const { stdout, stderr } = await exec('git', args, { cwd: tree, env: { ...env, ...gitCommandEnv(args[0]) } })
          return { code: 0, stdout, stderr }
        } catch (e) {
          const err = e as { code?: number; stdout?: string; stderr?: string }
          return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
        }
      })
    })
    afterAll(async () => {
      await raw(work, 'worktree', 'remove', '--force', tree)
    })

    it('amends the last commit with what is staged', async () => {
      await commitFile(tree, 'amend.txt', 'before')
      await writeFile(join(tree, 'extra.txt'), 'extra\n')
      await raw(tree, 'add', 'extra.txt')
      await inTree.amendCommit('after', 'body')
      expect(await subject()).toBe('after')
      expect((await raw(tree, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort()).toEqual(['amend.txt', 'extra.txt'])
    })

    it('reverts a commit', async () => {
      await commitFile(tree, 'gone.txt', 'gone')
      const sha = await head()
      expect(await inTree.revertCommit(sha)).toEqual({ conflicts: false })
      expect(await subject()).toBe('Revert "gone"')
    })

    it('stops on a conflicting revert and can back out of it', async () => {
      await commitFile(tree, 'c.txt', 'one')
      const sha = await head()
      await commitFile(tree, 'c.txt', 'two')
      const before = await head()
      expect(await inTree.revertCommit(sha)).toEqual({ conflicts: true })
      expect(await inTree.operation()).toBe('revert')
      await inTree.abortOperation('revert')
      expect(await inTree.operation()).toBeNull()
      expect(await head()).toBe(before)
    })

    it('stops on a conflicting cherry-pick and finishes it once resolved', async () => {
      const base = await head()
      await raw(tree, 'switch', '-c', 'menu-pick')
      await commitFile(tree, 'p.txt', 'theirs')
      const picked = await head()
      await raw(tree, 'switch', 'menu')
      await commitFile(tree, 'p.txt', 'ours')
      expect(await inTree.cherryPick(picked)).toEqual({ conflicts: true })
      expect(await inTree.operation()).toBe('cherry-pick')
      await writeFile(join(tree, 'p.txt'), 'both\n')
      await raw(tree, 'add', 'p.txt')
      await inTree.finishMerge()
      expect(await inTree.operation()).toBeNull()
      expect(await subject()).toBe('theirs')
      expect(base).not.toBe(await head())
    })

    it('resets to a commit and keeps what came after as changes', async () => {
      await commitFile(tree, 'r.txt', 'kept')
      await inTree.resetTo((await raw(tree, 'rev-parse', 'HEAD~1')).trim())
      expect((await inTree.status()).entries.map((e) => e.path)).toContain('r.txt')
      await raw(tree, 'add', 'r.txt')
      await raw(tree, 'commit', '-m', 'r again')
    })

    it('creates a tag and a branch at a commit', async () => {
      const sha = (await raw(tree, 'rev-parse', 'HEAD~1')).trim()
      await inTree.createTag('menu-tag', sha)
      expect(await inTree.tagsAt(sha)).toEqual(['menu-tag'])
      expect(await inTree.tagsAt(await head())).toEqual([])
      await inTree.createBranchAt('menu-from', sha)
      expect(await head()).toBe(sha)
      await raw(tree, 'switch', 'menu')
      await raw(tree, 'tag', '-d', 'menu-tag')
    })

    it('checks out a commit and reports it as detached', async () => {
      const sha = (await raw(tree, 'rev-parse', 'HEAD~1')).trim()
      await inTree.checkoutCommit(sha)
      expect((await inTree.status()).branch).toBe('HEAD')
      const detached = (await inTree.branches()).find((b) => b.current)
      expect(detached).toMatchObject({ name: 'HEAD', location: 'local', sha: sha.slice(0, detached!.sha.length) })
      expect((await inTree.branchCommits(detached!)).history[0].sha).toBe(sha)
      await raw(tree, 'switch', 'menu')
    })
  })

  it('renames and deletes a branch, even one with commits nothing else has', async () => {
    await raw(work, 'branch', 'old-name')
    await client.renameBranch('old-name', 'new-name')
    expect(await client.branchNames()).toContain('new-name')
    await raw(work, 'switch', 'new-name')
    await commitFile(work, 'unmerged.txt', 'unmerged')
    await raw(work, 'switch', 'spike')
    await client.deleteBranch('new-name')
    expect(await client.branchNames()).not.toContain('new-name')
  })

  it('knows the default branch from the remote', async () => {
    expect(await client.defaultBranch()).toBe('main')
  })

  it('merges, stops at conflicts, and backs out or finishes', async () => {
    await raw(work, 'switch', '-c', 'side-a')
    await commitFile(work, 'clash.txt', 'a')
    await raw(work, 'switch', '-c', 'side-b', 'HEAD~1')
    await commitFile(work, 'clash.txt', 'b')
    expect(await client.operation()).toBeNull()
    expect(await client.merge('side-a')).toEqual({ conflicts: true })
    expect(await client.operation()).toBe('merge')
    await client.abortOperation('merge')
    expect(await client.operation()).toBeNull()
    await client.merge('side-a')
    await writeFile(join(work, 'clash.txt'), 'both\n')
    await raw(work, 'add', 'clash.txt')
    await client.finishMerge()
    expect((await client.log(undefined, 1))[0].subject).toBe("Merge branch 'side-a' into side-b")
    await expect(client.merge('no-such-branch')).rejects.toThrow()
    await raw(work, 'switch', 'spike')
    await raw(work, 'branch', '-D', 'side-a', 'side-b')
  })

  it('rebases, and backs out of a conflict', async () => {
    await raw(work, 'switch', '-c', 'base-a')
    await commitFile(work, 'rebased.txt', 'a')
    await raw(work, 'switch', '-c', 'base-b', 'HEAD~1')
    await commitFile(work, 'rebased.txt', 'b')
    expect(await client.rebase('base-a')).toEqual({ conflicts: true })
    expect(await client.operation()).toBe('rebase')
    await client.abortOperation('rebase')
    expect(await client.operation()).toBeNull()
    await raw(work, 'switch', 'spike')
    await raw(work, 'branch', '-D', 'base-a', 'base-b')
  })

  it('counts commits merged in from another branch as not pushed, as git does, and marks them apart', async () => {
    await raw(work, 'switch', '-c', 'tracked', '--track', 'origin/main')
    await commitFile(work, 'tracked.txt', 'mine')
    await raw(work, 'merge', '--no-edit', 'origin/release')
    const tracked = (await client.branches()).find((b) => b.name === 'tracked')!
    const commits = await client.branchCommits(tracked)
    // The push moves the branch past release's commit too, so it's one of the three, as in GitHub Desktop.
    expect(tracked.ahead).toBe(3)
    expect(commits.local.map((c) => c.subject)).toEqual([expect.stringMatching(/^Merge/), 'mine', 'release'])
    const merged = commits.history.find((c) => c.subject === 'release')!
    expect(merged).toMatchObject({ mark: '↑', elsewhere: true })
    expect(commits.notOnRemote).not.toContain(merged.sha)
    expect(commits.history.filter((c) => c.mark === '↑').map((c) => c.sha)).toEqual(commits.local.map((c) => c.sha))
    expect(commits.history.filter((c) => c.mark === '↑' && !c.elsewhere).map((c) => c.subject)).toEqual([expect.stringMatching(/^Merge/), 'mine'])
    // Only this clone's own commits can be dragged, and a merge ends the run anyway.
    expect(reorderableCommits(commits.history)).toEqual([])
    // A merge without conflicts shows what it brought in, not an empty combined diff.
    expect((await client.show(commits.local[0].sha)).files.map((f) => f.newPath)).toEqual(['c.txt'])
    await raw(work, 'switch', 'spike')
    await raw(work, 'branch', '-D', 'tracked')
  })

  it('reads the log of a branch that is not checked out', async () => {
    expect((await client.log('origin/release')).map((c) => c.subject)).toEqual(['release', 'theirs', 'first'])
    expect((await client.log()).map((c) => c.subject)).toEqual(['first'])
  })

  it('stages, commits, shows and undoes a commit', async () => {
    await writeFile(join(work, 'new.txt'), 'hello\n')
    let status = await client.status()
    const entry = status.entries.find((e) => e.path === 'new.txt')!
    expect(entry).toMatchObject({ index: '?', worktree: '?' })
    expect((await client.fileDiff(entry))?.newPath).toBe('new.txt')

    await client.stage(entry)
    expect(await client.stagedDiff()).toContain('+hello')
    await client.commit('add new', 'with a body')
    status = await client.status()
    expect(status.entries).toEqual([])

    const [top] = await client.log()
    const shown = await client.show(top.sha)
    expect(shown.message).toBe('add new\n\nwith a body')
    expect(shown.files.map((f) => f.newPath)).toEqual(['new.txt'])

    await client.undoCommit()
    status = await client.status()
    expect(status.entries).toMatchObject([{ path: 'new.txt', index: 'A' }])
    await client.unstage(...status.entries)
    await client.discard((await client.status()).entries[0])
    expect((await client.status()).entries).toEqual([])
  })

  it('sorts a branch’s commits by where they are', async () => {
    await client.switchTo('main')
    await writeFile(join(work, 'mine.txt'), 'mine\n')
    await client.stage({ path: 'mine.txt', index: '?', worktree: '?' })
    await client.commit('only here')
    const branches = await client.branches()
    const main = branches.find((b) => b.name === 'main')!
    expect(main).toMatchObject({ ahead: 1, behind: 1 })
    const commits = await client.branchCommits(main)
    expect(commits.local.map((c) => c.subject)).toEqual(['only here'])
    expect(commits.remote.map((c) => c.subject)).toEqual(['first'])
    expect(commits.incoming.map((c) => c.subject)).toEqual(['theirs'])
    const release = await client.branchCommits(branches.find((b) => b.name === 'release')!)
    expect(release).toMatchObject({ local: [], incoming: [] })
    expect(release.remote.map((c) => c.subject)).toEqual(['release', 'theirs', 'first'])
    await client.undoCommit()
    await client.unstage(...(await client.status()).entries)
    await client.discard({ path: 'mine.txt', index: '?', worktree: '?' })
    await client.switchTo('spike')
  })

  it('stashes changes, shows them, and restores or drops one by its commit', async () => {
    await writeFile(join(work, 'wip.txt'), 'wip\n')
    await client.stash()
    expect((await client.status()).entries).toEqual([])
    await writeFile(join(work, 'other.txt'), 'other\n')
    await client.stash()
    const [newest, older] = await client.stashes()
    expect(newest).toMatchObject({ ref: 'stash@{0}', branch: 'spike' })
    expect(older).toMatchObject({ ref: 'stash@{1}', branch: 'spike' })
    expect((await client.stashFiles(older.sha)).map((f) => f.newPath)).toEqual(['wip.txt'])

    // The older one, though it's no longer on top.
    await client.restoreStash(older.sha)
    expect((await client.status()).entries).toMatchObject([{ path: 'wip.txt' }])
    expect((await client.stashes()).map((s) => s.sha)).toEqual([newest.sha])
    await client.discard((await client.status()).entries[0])

    await client.dropStash(newest.sha)
    expect(await client.stashes()).toEqual([])
    await expect(client.dropStash(newest.sha)).rejects.toThrow('no longer there')
  })

  it('switches and creates branches, and says when there is no remote', async () => {
    await client.createBranch('feature/x')
    expect((await client.status()).branch).toBe('feature/x')
    await client.switchTo('spike')
    expect(await client.branchNames()).toContain('feature/x')
    expect(await client.remoteUrl()).toContain('origin.git')
  })

  it('stages and unstages several files in one command', async () => {
    await writeFile(join(work, 'one.txt'), '1\n')
    await writeFile(join(work, 'two.txt'), '2\n')
    await client.stage(...(await client.status()).entries)
    expect((await client.status()).entries.map((e) => e.index)).toEqual(['A', 'A'])
    await client.unstage(...(await client.status()).entries)
    const { entries } = await client.status()
    expect(entries.map((e) => e.index)).toEqual(['?', '?'])
    for (const e of entries) await client.discard(e)
  })

  it('takes a path with glob characters for that one file', async () => {
    await mkdir(join(work, 'app/[id]'), { recursive: true })
    await mkdir(join(work, 'app/i'), { recursive: true })
    await writeFile(join(work, 'app/[id]/page.tsx'), 'route\n')
    await writeFile(join(work, 'app/i/page.tsx'), 'keep me\n')
    await client.discard({ path: 'app/[id]/page.tsx', index: '?', worktree: '?' })
    expect((await client.status()).entries.map((e) => e.path)).toEqual(['app/i/page.tsx'])
    await client.discard({ path: 'app/i/page.tsx', index: '?', worktree: '?' })
  })

  it('discards by what git says now, not what the row said', async () => {
    await writeFile(join(work, 'late.txt'), 'late\n')
    const stale = (await client.status()).entries[0]
    await client.stage(stale)
    await client.discard(stale)
    expect((await client.status()).entries).toEqual([])
  })

  it('unstages before the first commit', async () => {
    const fresh = join(root, 'fresh')
    await mkdir(fresh)
    await raw(fresh, 'init', '-b', 'main')
    await writeFile(join(fresh, 'a.txt'), 'a\n')
    await raw(fresh, 'add', 'a.txt')
    const inFresh = createGitClient(async (args) => {
      const { stdout, stderr } = await exec('git', args, { cwd: fresh, env })
      return { code: 0, stdout, stderr }
    })
    await inFresh.unstage({ path: 'a.txt', index: 'A', worktree: ' ' })
    expect((await inFresh.status()).entries).toMatchObject([{ path: 'a.txt', index: '?' }])
  })

  it('throws git’s own message when a command fails', async () => {
    await expect(client.switchTo('no-such-branch')).rejects.toThrow(/no-such-branch/)
  })
})
