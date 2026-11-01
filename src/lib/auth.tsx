import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiBaseFor, normalizeHost, tokenKind, type TokenKind } from './hosts'
import { readPref, secrets, writePref } from './storage'

export type AuthMethod = 'pat' | 'oauth-device' | 'oauth-web' | 'gh-cli'

export const AUTH_METHOD_LABEL: Record<AuthMethod, string> = {
  pat: 'Personal access token',
  'oauth-device': 'OAuth device flow',
  'oauth-web': 'OAuth (web)',
  'gh-cli': 'GitHub CLI session',
}

export interface Account {
  id: string
  method: AuthMethod
  kind: TokenKind
  token: string
  host: string
  apiBase: string
  login: string
  name: string | null
  avatarUrl: string
  /** Classic PAT / OAuth scopes from X-OAuth-Scopes. Null for fine-grained tokens. */
  scopes: string[] | null
  addedAt: number
}

interface AuthState {
  ready: boolean
  accounts: Account[]
  active: Account | null
  /** Accounts whose saved token GitHub now answers with 401: it expired or was revoked. */
  rejected: ReadonlySet<string>
  signIn(token: string, method: AuthMethod, host?: string): Promise<Account>
  signOut(id: string): Promise<void>
  switchTo(id: string): void
}

const AuthContext = createContext<AuthState | null>(null)
const ACCOUNTS_KEY = 'accounts'

/** Why a token can never sign in, told from its prefix before asking GitHub. */
export function tokenSignInProblem(token: string): string | null {
  if (token.startsWith('ghs_')) {
    return 'GitHub App installation tokens (ghs_…) have no user identity, so they can’t sign in. Use a personal access token, or sign in with the device flow using the GitHub App’s client ID, which gives you a user token (ghu_…).'
  }
  if (token.startsWith('ghr_')) return 'That is a GitHub App refresh token (ghr_…). Sign in with the user access token (ghu_…) that came with it.'
  return null
}

export async function verifyToken(token: string, host: string) {
  const problem = tokenSignInProblem(token)
  if (problem) throw new Error(problem)
  const apiBase = apiBaseFor(host)
  let res: Response
  try {
    res = await fetch(`${apiBase}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
  } catch {
    throw new Error(`Could not reach ${apiBase}. Check the host name and your connection.`)
  }
  if (res.status === 401) throw new Error('Bad credentials: the token is invalid, expired or revoked.')
  if (!res.ok) {
    // e.g. 403 "Resource not accessible by integration" for an installation token without the ghs_ prefix, or a rate limit.
    const message = ((await res.json().catch(() => null)) as { message?: string } | null)?.message
    throw new Error(`GitHub returned ${res.status} for /user${message ? `: ${message}` : ''}.`)
  }
  const user = (await res.json()) as { login: string; name: string | null; avatar_url: string }
  // GitHub App user tokens (ghu_) carry the app's fine-grained permissions, not OAuth scopes.
  const scopeHeader = tokenKind(token) === 'app-user' ? null : res.headers.get('x-oauth-scopes')
  return {
    apiBase,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    scopes: scopeHeader === null ? null : scopeHeader.split(',').map((s) => s.trim()).filter(Boolean),
  }
}

// GitHub answers 401 once a saved token expires (GitHub App user tokens last 8 hours) or is revoked.
// Octokit clients report that here (see octokitFor) so the app can offer to sign in again.
type RejectionListener = (accountId: string, token: string) => void
const rejectionListeners = new Set<RejectionListener>()

export function reportRejectedToken(accountId: string, token: string) {
  for (const listener of rejectionListeners) listener(accountId, token)
}

export function onTokenRejected(listener: RejectionListener) {
  rejectionListeners.add(listener)
  return () => void rejectionListeners.delete(listener)
}

/** Accounts still holding the token GitHub rejected; signing in again replaces the token and clears it. */
export function rejectedAccountIds(accounts: Account[], rejectedTokens: Record<string, string>): ReadonlySet<string> {
  return new Set(accounts.filter((a) => rejectedTokens[a.id] === a.token).map((a) => a.id))
}

/** The login page, set up to sign in again as `account` and come back to `next`. */
export function reauthPath(account: Pick<Account, 'login' | 'host'>, next: string) {
  return `/login?${new URLSearchParams({ reauth: account.login, host: account.host, next })}`
}

async function loadAccounts(): Promise<Account[]> {
  try {
    const raw = await secrets.get(ACCOUNTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as Account[]) : []
  } catch {
    return [] // unreadable or corrupted store (e.g. keychain unavailable); start fresh
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => readPref<string | null>('activeAccount', null))
  const [rejectedTokens, setRejectedTokens] = useState<Record<string, string>>({})

  useEffect(() => onTokenRejected((id, token) => setRejectedTokens((m) => (m[id] === token ? m : { ...m, [id]: token }))), [])

  useEffect(() => {
    let cancelled = false
    loadAccounts()
      .then((list) => !cancelled && setAccounts(list))
      .finally(() => !cancelled && setReady(true))
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(async (next: Account[]) => {
    setAccounts(next)
    await secrets.set(ACCOUNTS_KEY, JSON.stringify(next))
  }, [])

  const signIn = useCallback(
    async (token: string, method: AuthMethod, hostInput = 'github.com') => {
      const host = normalizeHost(hostInput)
      const clean = token.trim()
      const info = await verifyToken(clean, host)
      const account: Account = {
        id: `${host}:${info.login}`,
        method,
        kind: tokenKind(clean),
        token: clean,
        host,
        apiBase: info.apiBase,
        login: info.login,
        name: info.name,
        avatarUrl: info.avatarUrl,
        scopes: info.scopes,
        addedAt: Date.now(),
      }
      // Merge into the stored list, not the `accounts` this callback closed over: a caller
      // that runs before the initial load (the web OAuth handoff on mount) would see [] and
      // overwrite every other saved account.
      const current = await loadAccounts()
      await persist([...current.filter((a) => a.id !== account.id), account])
      setActiveId(account.id)
      writePref('activeAccount', account.id)
      return account
    },
    [persist],
  )

  const signOut = useCallback(
    async (id: string) => {
      const next = (await loadAccounts()).filter((a) => a.id !== id)
      await persist(next)
      if (activeId === id) {
        const fallback = next[0]?.id ?? null
        setActiveId(fallback)
        writePref('activeAccount', fallback)
      }
    },
    [activeId, persist],
  )

  const switchTo = useCallback((id: string) => {
    setActiveId(id)
    writePref('activeAccount', id)
  }, [])

  const active = accounts.find((a) => a.id === activeId) ?? accounts[0] ?? null
  const rejected = useMemo(() => rejectedAccountIds(accounts, rejectedTokens), [accounts, rejectedTokens])

  const value = useMemo<AuthState>(
    () => ({ ready, accounts, active, rejected, signIn, signOut, switchTo }),
    [ready, accounts, active, rejected, signIn, signOut, switchTo],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/** The signed-in account. Only call from routes rendered behind the auth gate. */
export function useAccount(): Account {
  const { active } = useAuth()
  if (!active) throw new Error('No active account')
  return active
}
