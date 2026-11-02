import { useCallback, useSyncExternalStore } from 'react'
import { native } from './platform'

const PREFIX = 'gh-ui:'

// Secrets (GitHub tokens, Anthropic key). The desktop app encrypts them with the OS
// keychain via Electron safeStorage; the web build can only use localStorage.
export const secrets = {
  async get(key: string): Promise<string | null> {
    if (native) return native.secrets.get(key)
    try {
      return localStorage.getItem(PREFIX + 'secret:' + key)
    } catch {
      return null
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (native) return native.secrets.set(key, value)
    localStorage.setItem(PREFIX + 'secret:' + key, value)
  },
  async delete(key: string): Promise<void> {
    if (native) return native.secrets.delete(key)
    localStorage.removeItem(PREFIX + 'secret:' + key)
  },
}

// Non-sensitive preferences.
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // storage full or blocked; preferences are best-effort
  }
}

const shared = new Map<string, unknown>()
const sharedListeners = new Map<string, Set<() => void>>()

/**
 * A preference that's also live state in several places at once, such as two desktop tabs on one pull request. All of
 * them read the one value and write only when something really changes it; a hidden tab catches up when it's shown.
 */
export function useSharedPref<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void] {
  const current = useCallback(() => {
    if (!shared.has(key)) shared.set(key, readPref(key, fallback))
    return shared.get(key) as T
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const subscribe = useCallback(
    (listener: () => void) => {
      const listeners = sharedListeners.get(key) ?? new Set()
      sharedListeners.set(key, listeners.add(listener))
      // Another browser window of the web build wrote it.
      const onStorage = (e: StorageEvent) => {
        if (e.key !== PREFIX + key) return
        shared.delete(key)
        listener()
      }
      window.addEventListener('storage', onStorage)
      return () => {
        listeners.delete(listener)
        window.removeEventListener('storage', onStorage)
      }
    },
    [key],
  )
  const set = useCallback(
    (next: T | ((value: T) => T)) => {
      const value = typeof next === 'function' ? (next as (value: T) => T)(current()) : next
      shared.set(key, value)
      writePref(key, value)
      sharedListeners.get(key)?.forEach((listener) => listener())
    },
    [key, current],
  )
  return [useSyncExternalStore(subscribe, current), set]
}
