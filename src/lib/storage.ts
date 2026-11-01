import { native } from './platform'

const PREFIX = 'gi-ui:'

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
