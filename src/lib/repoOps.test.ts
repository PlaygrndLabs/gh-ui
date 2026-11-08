import { describe, expect, it, vi } from 'vitest'
import type { StatusEntry } from './git'
import { createRepoOps } from './repoOps'

const file = (path: string): StatusEntry => ({ path, index: ' ', worktree: 'M' })
const paths = (entries: StatusEntry[]) => entries.map((e) => e.path)
const tick = () => new Promise((r) => setTimeout(r, 0))

/** A git whose commands finish only when the test says so, with a log of what was run. */
function fakeGit() {
  const calls: string[] = []
  const pending: Array<{ resolve(): void; reject(e: Error): void }> = []
  const command = (name: string) => (...entries: StatusEntry[]) =>
    new Promise<void>((resolve, reject) => {
      calls.push(`${name} ${paths(entries).join(' ')}`)
      pending.push({ resolve, reject })
    })
  const finish = async () => {
    pending.shift()!.resolve()
    await tick()
  }
  const fail = async (message: string) => {
    pending.shift()!.reject(new Error(message))
    await tick()
  }
  return { calls, pending, finish, fail, stage: command('stage'), unstage: command('unstage') }
}

function setup() {
  const git = fakeGit()
  const reconcile = vi.fn(async () => {})
  const ops = createRepoOps({ stage: git.stage, unstage: git.unstage, reconcile })
  return { git, reconcile, ops, shown: (path: string) => ops.intents().get(path)?.staged }
}

describe('createRepoOps', () => {
  it('shows a click before git has done anything', () => {
    const { ops, shown, git } = setup()
    ops.setStaged([file('a')], true)
    expect(shown('a')).toBe(true)
    expect(git.calls).toEqual([])
  })

  it('tells listeners, and hands them a new snapshot each time', () => {
    const { ops } = setup()
    const before = ops.intents()
    const listener = vi.fn()
    ops.subscribe(listener)
    ops.setStaged([file('a')], true)
    expect(listener).toHaveBeenCalled()
    expect(ops.intents()).not.toBe(before)
  })

  it('checking then unchecking ends unchecked, in that order', async () => {
    const { ops, git, shown } = setup()
    ops.setStaged([file('a')], true)
    await tick()
    expect(git.calls).toEqual(['stage a'])
    ops.setStaged([file('a')], false)
    expect(shown('a')).toBe(false)
    await git.finish()
    expect(shown('a')).toBe(false)
    expect(git.calls).toEqual(['stage a', 'unstage a'])
    await git.finish()
    await tick()
    expect(shown('a')).toBeUndefined()
  })

  it('sends only the last of several clicks made while waiting', async () => {
    const { ops, git } = setup()
    ops.setStaged([file('a')], true)
    ops.setStaged([file('a')], false)
    ops.setStaged([file('a')], true)
    await tick()
    expect(git.calls).toEqual(['stage a'])
  })

  it('never runs two commands at once, and puts clicks made meanwhile in one command', async () => {
    const { ops, git } = setup()
    ops.setStaged([file('a')], true)
    await tick()
    for (const name of ['b', 'c', 'd']) ops.setStaged([file(name)], true)
    await tick()
    expect(git.pending).toHaveLength(1)
    await git.finish()
    expect(git.calls).toEqual(['stage a', 'stage b c d'])
  })

  it('keeps the box as clicked until a status read after the write has arrived', async () => {
    const git = fakeGit()
    let readDone = () => {}
    const reconcile = vi.fn(() => new Promise<void>((r) => (readDone = r)))
    const ops = createRepoOps({ stage: git.stage, unstage: git.unstage, reconcile })
    ops.setStaged([file('a')], true)
    await tick()
    expect(reconcile).not.toHaveBeenCalled()
    await git.finish()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(ops.intents().get('a')?.staged).toBe(true)
    readDone()
    await tick()
    expect(ops.intents().size).toBe(0)
  })

  it('reads status once for a burst, not once per click', async () => {
    const { ops, git, reconcile } = setup()
    ops.setStaged([file('a')], true)
    await tick()
    ops.setStaged([file('b')], true)
    await git.finish()
    await git.finish()
    await tick()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('does not let a read that finishes early release a click made during it', async () => {
    const git = fakeGit()
    const reads: Array<() => void> = []
    const reconcile = vi.fn(() => new Promise<void>((r) => reads.push(r)))
    const ops = createRepoOps({ stage: git.stage, unstage: git.unstage, reconcile })
    ops.setStaged([file('a')], true)
    await tick()
    await git.finish()
    ops.setStaged([file('b')], true)
    await tick()
    await git.finish()
    reads[0]()
    await tick()
    expect(ops.intents().has('a')).toBe(false)
    expect(ops.intents().has('b')).toBe(true)
    reads[1]()
    await tick()
    expect(ops.intents().size).toBe(0)
  })

  it('puts a box back and says why when git refuses', async () => {
    const { ops, git, shown } = setup()
    ops.setStaged([file('a')], true)
    await tick()
    await git.fail('nope')
    expect(shown('a')).toBeUndefined()
    expect(ops.error()).toBe('nope')
    ops.clearError()
    expect(ops.error()).toBeNull()
  })

  it('retries a failed batch file by file, so one bad file only fails itself', async () => {
    const reconcile = vi.fn(async () => {})
    const stage = vi.fn(async (...entries: StatusEntry[]) => {
      if (paths(entries).includes('gone')) throw new Error('gone is gone')
    })
    const ops = createRepoOps({ stage, unstage: async () => {}, reconcile })
    ops.setStaged([file('a'), file('gone'), file('b')], true)
    await new Promise((r) => setTimeout(r, 5))
    expect(stage.mock.calls.map((c) => paths(c))).toEqual([['a', 'gone', 'b'], ['a'], ['gone'], ['b']])
    expect(ops.error()).toBe('gone is gone')
  })

  it('splits huge selections into several commands', async () => {
    const stage = vi.fn(async () => {})
    const ops = createRepoOps({ stage, unstage: async () => {}, reconcile: async () => {} })
    ops.setStaged(Array.from({ length: 450 }, (_, i) => file(`f${i}`)), true)
    await new Promise((r) => setTimeout(r, 5))
    expect(stage.mock.calls.map((c) => (c as unknown[]).length)).toEqual([200, 200, 50])
  })

  it('runs a commit after the clicks made before it, even if one fails', async () => {
    const { ops, git } = setup()
    const order: string[] = []
    ops.setStaged([file('a')], true)
    const commit = ops.run(async () => order.push('commit'))
    await tick()
    expect(order).toEqual([])
    await git.fail('locked')
    await commit
    expect(order).toEqual(['commit'])
  })

  it('keeps going after a job fails', async () => {
    const { ops } = setup()
    await expect(ops.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(ops.run(async () => 'ok')).resolves.toBe('ok')
  })
})
