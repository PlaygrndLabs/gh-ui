import { describe, expect, it, vi } from 'vitest'
import { createFetchTracker } from './fetchTracker'

function setup() {
  let time = 1_000
  const tracker = createFetchTracker(() => time)
  return { tracker, advance: (ms: number) => (time += ms), now: () => time }
}

describe('createFetchTracker', () => {
  it('fetches the first time, then not again until the last try is older than asked', async () => {
    const { tracker, advance } = setup()
    const fetch = vi.fn(async () => {})
    expect(await tracker.fetchIfStale('a', 60_000, fetch)).toBe(true)
    advance(30_000)
    expect(await tracker.fetchIfStale('a', 60_000, fetch)).toBe(false)
    advance(31_000)
    expect(await tracker.fetchIfStale('a', 60_000, fetch)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps folders apart', async () => {
    const { tracker } = setup()
    const fetch = vi.fn(async () => {})
    await tracker.fetchIfStale('a', 60_000, fetch)
    expect(await tracker.fetchIfStale('b', 60_000, fetch)).toBe(true)
  })

  it('runs one fetch at a time per folder', async () => {
    const { tracker } = setup()
    let finish = () => {}
    const fetch = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const first = tracker.run('a', fetch)
    const second = tracker.run('a', fetch)
    expect(await tracker.fetchIfStale('a', 0, fetch)).toBe(false)
    finish()
    await Promise.all([first, second])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('counts a failed try, so going offline does not fetch on every click, and swallows the error', async () => {
    const { tracker, advance } = setup()
    const fetch = vi.fn(async () => {
      throw new Error('Could not resolve host')
    })
    expect(await tracker.fetchIfStale('a', 60_000, fetch)).toBe(false)
    advance(1_000)
    expect(await tracker.fetchIfStale('a', 60_000, fetch)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(tracker.lastSucceeded('a')).toBeNull()
  })

  it('passes on what a fetch asked for directly throws', async () => {
    const { tracker } = setup()
    await expect(tracker.run('a', async () => Promise.reject(new Error('denied')))).rejects.toThrow('denied')
  })

  it('remembers when the last fetch worked and tells subscribers', async () => {
    const { tracker, now } = setup()
    const listener = vi.fn()
    tracker.subscribe(listener)
    await tracker.run('a', async () => {})
    expect(tracker.lastSucceeded('a')).toBe(now())
    tracker.mark('b')
    expect(tracker.lastSucceeded('b')).toBe(now())
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
