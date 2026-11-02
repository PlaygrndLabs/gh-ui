import { native, isDev } from './platform'
import { DEFAULT_HOST } from './hosts'
import { readPref } from './storage'

// OAuth device flow. github.com/login/* sends no CORS headers, so the desktop app
// calls it from the main process and the web build goes through /api/gh-login
// (Vite proxy in dev, Cloudflare Worker in production).

export const DEFAULT_SCOPES = ['repo', 'workflow', 'read:org', 'project', 'notifications', 'read:user', 'user:email', 'gist']

export interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface ServerConfig {
  oauthClientId: string | null
  webOAuth: boolean
  anthropicProxy: boolean
  allowedHosts: string[]
}

let serverConfigPromise: Promise<ServerConfig | null> | null = null

/** Settings advertised by the Cloudflare Worker. Null in the desktop app and in `vite dev`. */
export function fetchServerConfig(): Promise<ServerConfig | null> {
  if (native || isDev) return Promise.resolve(null)
  serverConfigPromise ??= fetch('/api/config')
    .then((r) => (r.ok ? (r.json() as Promise<ServerConfig>) : null))
    .catch(() => null)
  return serverConfigPromise
}

export async function resolveClientId(host = 'github.com'): Promise<string | null> {
  const fromPrefs = readPref<string>('oauthClientId', '').trim()
  if (fromPrefs) return fromPrefs
  const cfg = await fetchServerConfig()
  if (cfg?.oauthClientId) return cfg.oauthClientId
  // The built-in OAuth App exists only on github.com; other hosts need their own.
  return host === 'github.com' ? (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) || null : null
}

async function postLogin(host: string, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString()
  const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
  if (native) {
    const res = await native.http({ url: `https://${host}${path}`, method: 'POST', headers, body })
    return parseLoginResponse(res.status, res.body)
  }
  const query = host === DEFAULT_HOST ? '' : `?host=${encodeURIComponent(host)}`
  const res = await fetch(`/api/gh-login${path}${query}`, { method: 'POST', headers, body })
  return parseLoginResponse(res.status, await res.text())
}

function parseLoginResponse(status: number, text: string): Record<string, unknown> {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`GitHub login endpoint returned ${status}${text ? `: ${text.slice(0, 120)}` : ''}`)
  }
  if (status >= 400 && !data.error) throw new Error(`GitHub login endpoint returned ${status}`)
  return data
}

export async function requestDeviceCode(host: string, clientId: string, scopes = DEFAULT_SCOPES): Promise<DeviceCode> {
  const data = await postLogin(host, '/login/device/code', { client_id: clientId, scope: scopes.join(' ') })
  // An unknown client ID gets a bare 404 {"error":"Not Found"}.
  if (data.error === 'Not Found') throw new Error(`GitHub answered “Not Found” for client ID ${clientId}. Use the client ID of an OAuth App or GitHub App on ${host} (Settings → OAuth app).`)
  if (data.error) throw new Error(String(data.error_description ?? data.error))
  return data as unknown as DeviceCode
}

export async function pollDeviceToken(host: string, clientId: string, code: DeviceCode, signal: AbortSignal): Promise<string> {
  let interval = Math.max(code.interval, 5)
  const deadline = Date.now() + code.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal)
    // GitHub would only answer expired_token once the wait has run past the code's lifetime.
    if (Date.now() >= deadline) break
    const data = await postLogin(host, '/login/oauth/access_token', {
      client_id: clientId,
      device_code: code.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof data.access_token === 'string') return data.access_token
    switch (data.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        // Each slow_down adds 5 seconds; GitHub also sends the new interval.
        interval = Math.max(Number(data.interval) || 0, interval + 5)
        continue
      case 'expired_token':
        throw new Error('The device code expired. Start again.')
      case 'access_denied':
        throw new Error('Authorization was cancelled on GitHub.')
      default:
        throw new Error(String(data.error_description ?? data.error ?? 'Unexpected response from GitHub'))
    }
  }
  throw new Error('The device code expired. Start again.')
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** `gh auth token` — over IPC in the desktop app, via a dev-server middleware in `vite dev`. */
export async function ghCliToken(host: string): Promise<string> {
  if (native) {
    const res = await native.ghCliToken(host)
    if (!res.token) throw new Error(res.error || 'gh CLI is not signed in')
    return res.token
  }
  if (isDev) {
    const res = await fetch(`/__dev/gh-token?host=${encodeURIComponent(host)}`)
    const data = (await res.json()) as { token?: string; error?: string }
    if (!data.token) throw new Error(data.error || 'gh CLI is not signed in')
    return data.token
  }
  throw new Error('The GitHub CLI bridge is only available in the desktop app.')
}

export const canUseGhCli = !!native || isDev

export type WebOAuthResult = { token: string; host: string } | { error: string }

/** What /api/oauth/callback (Cloudflare web OAuth flow) handed over: a token, or why sign-in failed. */
export function takeWebOAuthResult(): WebOAuthResult | null {
  try {
    const raw = sessionStorage.getItem('gh-ui:oauth-handoff')
    if (!raw) return null
    sessionStorage.removeItem('gh-ui:oauth-handoff')
    const parsed = JSON.parse(raw) as { token?: string; host?: string; error?: string }
    if (parsed.token) return { token: parsed.token, host: parsed.host || DEFAULT_HOST }
    return parsed.error ? { error: parsed.error } : null
  } catch {
    return null
  }
}
