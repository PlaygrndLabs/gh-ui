// Everything that changes one folder goes through its queue, so two git commands can't fight over the index and a commit
// always comes after the checkboxes ticked before it. No React in here: the tests drive it with plain functions.
//
// A checkbox shows what was asked for straight away. That lives beside git's status rather than inside the cached copy,
// so a status check that lands halfway can't put a box back; it's dropped once a status read after the write has arrived.

import type { StatusEntry } from './git'

export interface StageIntent {
  entry: StatusEntry
  staged: boolean
  /** Which request this is, so a write that finishes can tell whether the box has been clicked again since. */
  gen: number
  state: 'queued' | 'sending' | 'applied'
}

export type StageIntents = ReadonlyMap<string, StageIntent>

export interface RepoOpsDeps {
  stage(...entries: StatusEntry[]): Promise<unknown>
  unstage(...entries: StatusEntry[]): Promise<unknown>
  /** Reads git's status again, resolving once the page has it. */
  reconcile(): Promise<unknown>
}

export type RepoOps = ReturnType<typeof createRepoOps>

/** Keeps a command well inside the operating system's limit on arguments, however many boxes "stage all" ticks. */
const CHUNK = 200

export function createRepoOps({ stage, unstage, reconcile }: RepoOpsDeps) {
  let tail: Promise<unknown> = Promise.resolve()
  let intents: StageIntents = new Map()
  let error: string | null = null
  let gen = 0
  let flushQueued = false
  let settling = false
  let settleAgain = false
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())

  /** Runs after everything already asked of this folder. A job that fails doesn't stop the ones behind it. */
  const run = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job)
    tail = result.catch(() => undefined)
    return result
  }

  /** Writes one group, and if that fails file by file, so one vanished file doesn't take the others with it. */
  const write = async (items: StageIntent[], apply: (...entries: StatusEntry[]) => Promise<unknown>, failed: Map<string, unknown>) => {
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK)
      try {
        await apply(...chunk.map((item) => item.entry))
      } catch (e) {
        if (chunk.length === 1) failed.set(chunk[0].entry.path, e)
        else
          for (const item of chunk) {
            try {
              await apply(item.entry)
            } catch (one) {
              failed.set(item.entry.path, one)
            }
          }
      }
    }
  }

  const flush = async () => {
    // From here on a click needs a flush of its own, behind whatever was asked for after this one started.
    flushQueued = false
    const batch = [...intents.values()].filter((item) => item.state === 'queued')
    if (!batch.length) return
    intents = new Map([...intents].map(([path, item]) => [path, item.state === 'queued' ? { ...item, state: 'sending' as const } : item]))
    emit()

    const failed = new Map<string, unknown>()
    await write(batch.filter((item) => item.staged), stage, failed)
    await write(batch.filter((item) => !item.staged), unstage, failed)

    const next = new Map(intents)
    for (const { entry, gen: sent } of batch) {
      const current = next.get(entry.path)
      // Clicked again while this was running: that newer request is what counts.
      if (current?.gen !== sent) continue
      if (failed.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, { ...current, state: 'applied' })
    }
    intents = next
    const first = failed.values().next()
    error = first.done ? null : first.value instanceof Error ? first.value.message : String(first.value)
    emit()
  }

  /** One read at a time: a second one would cancel the first and let its boxes go before git's answer arrived. */
  const settle = async () => {
    if ([...intents.values()].some((item) => item.state !== 'applied')) return
    if (settling) {
      settleAgain = true
      return
    }
    settling = true
    do {
      settleAgain = false
      const upTo = gen
      // Whether or not the read worked, git's next answer is the truth from here on.
      await reconcile().catch(() => undefined)
      const next = new Map(intents)
      for (const [path, item] of next) if (item.state === 'applied' && item.gen <= upTo) next.delete(path)
      intents = next
      emit()
    } while (settleAgain)
    settling = false
  }

  return {
    run,
    /** Ticks or unticks boxes now, and has git catch up. Clicks that land while it's busy go in its next command together. */
    setStaged(entries: StatusEntry[], staged: boolean) {
      if (!entries.length) return
      gen++
      const next = new Map(intents)
      for (const entry of entries) next.set(entry.path, { entry, staged, gen, state: 'queued' })
      intents = next
      emit()
      if (flushQueued) return
      flushQueued = true
      void run(flush).then(settle)
    },
    intents: () => intents,
    error: () => error,
    clearError() {
      error = null
      emit()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
