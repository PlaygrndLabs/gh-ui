import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { changePaths, createGitClient, isStaged, isUnmerged, parseBranches, parseCommitLog, parseStatus, type GitClient } from './git'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const { validateGitArgs } = require('../../electron/git-policy.cjs') as { validateGitArgs(args: string[]): void }

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
        const { stdout, stderr } = await exec('git', args, { cwd: work, env })
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
    await client.unstageAll()
    await client.discard((await client.status()).entries[0])
    expect((await client.status()).entries).toEqual([])
  })

  it('switches and creates branches, and says when there is no remote', async () => {
    await client.createBranch('feature/x')
    expect((await client.status()).branch).toBe('feature/x')
    await client.switchTo('spike')
    expect(await client.branchNames()).toContain('feature/x')
    expect(await client.remoteUrl()).toContain('origin.git')
  })

  it('throws git’s own message when a command fails', async () => {
    await expect(client.switchTo('no-such-branch')).rejects.toThrow(/no-such-branch/)
  })
})
