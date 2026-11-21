/**
 * When each folder last heard from its remote. A branch someone pushed only reaches `refs/remotes` with a fetch, so the
 * app fetches by itself now and then, and this keeps those fetches from piling up: one at a time per folder, and none
 * when the last try was recent. A failed try (offline, signed out) counts as a try, so it isn't repeated on every click.
 */
export function createFetchTracker(now: () => number = Date.now) {
  const tried = new Map<string, number>()
  const succeeded = new Map<string, number>()
  const running = new Map<string, Promise<unknown>>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  /** Runs `fetch`, or joins the one under way in this folder. Rejects as `fetch` does. */
  const run = <T>(id: string, fetch: () => Promise<T>): Promise<T> => {
    const under = running.get(id)
    if (under) return under as Promise<T>
    const started = (async () => {
      try {
        const out = await fetch()
        succeeded.set(id, now())
        notify()
        return out
      } finally {
        tried.set(id, now())
        running.delete(id)
      }
    })()
    running.set(id, started)
    return started
  }

  return {
    run,
    /** For what fetches as part of something else, a pull. */
    mark(id: string) {
      tried.set(id, now())
      succeeded.set(id, now())
      notify()
    },
    /** Fetches unless one is running or the last try ended less than `maxAge` ago. Never rejects; says whether it fetched. */
    async fetchIfStale(id: string, maxAge: number, fetch: () => Promise<unknown>): Promise<boolean> {
      if (running.has(id)) return false
      const last = tried.get(id)
      if (last !== undefined && now() - last < maxAge) return false
      try {
        await run(id, fetch)
        return true
      } catch {
        return false
      }
    },
    /** When the last fetch here that worked finished, or null if none has this session. */
    lastSucceeded: (id: string) => succeeded.get(id) ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export type FetchTracker = ReturnType<typeof createFetchTracker>
