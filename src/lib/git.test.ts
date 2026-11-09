import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { changePaths, createGitClient, isStaged, isUnmerged, parseBranches, parseCommitLog, parseStatus, parseWorktrees, type GitClient } from './git'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const { validateGitArgs, gitCommandEnv } = require('../../electron/git-policy.cjs') as { validateGitArgs(args: string[]): void; gitCommandEnv(sub: string): Record<string, string> }

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
    expect(parseCommitLog('abc\x1fLena\x1f2026-01-01T00:00:00Z\x1ffix: a | b\n')).toEqual([{ sha: 'abc', author: 'Lena', date: '2026-01-01T00:00:00Z', subject: 'fix: a | b' }])
  })
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

  it('counts commits merged in from another branch as not pushed, and keeps log order', async () => {
    await raw(work, 'switch', '-c', 'tracked', '--track', 'origin/main')
    await commitFile(work, 'tracked.txt', 'mine')
    await raw(work, 'merge', '--no-edit', 'origin/release')
    const tracked = (await client.branches()).find((b) => b.name === 'tracked')!
    const commits = await client.branchCommits(tracked)
    expect(commits.local.map((c) => c.subject)).toContain('release')
    expect(commits.local).toHaveLength(tracked.ahead)
    const merged = commits.local.find((c) => c.subject === 'release')!
    expect(commits.notOnRemote).not.toContain(merged.sha)
    expect(commits.history.filter((c) => c.mark === '↑')).toHaveLength(tracked.ahead)
    expect(commits.history.map((c) => c.sha)).toEqual(expect.arrayContaining(commits.local.map((c) => c.sha)))
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

  it('stashes changes and restores them', async () => {
    await writeFile(join(work, 'wip.txt'), 'wip\n')
    await client.stash()
    expect((await client.status()).entries).toEqual([])
    expect(await client.stashList()).toHaveLength(1)
    await client.stashPop()
    expect((await client.status()).entries).toMatchObject([{ path: 'wip.txt' }])
    await client.discard((await client.status()).entries[0])
    expect(await client.stashList()).toEqual([])
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
