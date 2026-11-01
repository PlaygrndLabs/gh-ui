// gh-ui on Cloudflare: serves the built SPA from Workers Static Assets and
// handles the few things a browser can't do on its own.
//
//   GET  /api/config                     what this deployment supports
//   POST /api/gh-login/login/...         OAuth device-flow proxy (github.com has no CORS)
//   GET  /api/oauth/start|callback       OAuth web flow (needs GITHUB_CLIENT_SECRET)
//   *    /api/anthropic/v1/...           Anthropic proxy for ALLOWED_GITHUB_USERS
//   GET  /api/gh/job-logs                follows the Actions log redirect without leaking the token

export interface Env {
  ASSETS: Fetcher
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  ANTHROPIC_API_KEY?: string
  /** Comma-separated GitHub logins allowed to use the Anthropic proxy, or "*" for any signed-in user. A bare login means github.com; list GHES and GHE.com users as host/login. */
  ALLOWED_GITHUB_USERS?: string
  /** Extra GitHub Enterprise hosts (comma-separated) allowed for device flow and log proxying. */
  GHES_HOSTS?: string
}

const OAUTH_SCOPES = 'repo workflow read:org project notifications read:user user:email gist'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/config') return config(env)
      // Await inside the try so rejected handlers (failed upstream fetches) reach the catch.
      if (url.pathname.startsWith('/api/gh-login/')) return await deviceFlowProxy(request, url, env)
      if (url.pathname === '/api/oauth/start') return oauthStart(url, env)
      if (url.pathname === '/api/oauth/callback') return await oauthCallback(request, url, env)
      if (url.pathname.startsWith('/api/anthropic/')) return await anthropicProxy(request, url, env)
      if (url.pathname === '/api/gh/job-logs') return await jobLogs(request, url, env)
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404)
      return await env.ASSETS.fetch(request)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error'
      // The callback is a page navigation and the Anthropic proxy is called cross-origin by the SDK.
      if (url.pathname === '/api/oauth/callback') return handoff({ error: `Could not reach GitHub (${message}). Try again.` }, '/', 502)
      if (url.pathname.startsWith('/api/anthropic/')) return json({ type: 'error', error: { type: 'api_error', message } }, 502, CORS)
      return json({ error: message }, 500)
    }
  },
} satisfies ExportedHandler<Env>

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
}

function allowedHosts(env: Env) {
  return ['github.com', ...(env.GHES_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]
}

function isAllowedHost(host: string, env: Env) {
  return allowedHosts(env).includes(host) || /^[a-z0-9-]+\.ghe\.com$/.test(host)
}

function config(env: Env) {
  return json({
    oauthClientId: env.GITHUB_CLIENT_ID || null,
    webOAuth: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    anthropicProxy: !!(env.ANTHROPIC_API_KEY && env.ALLOWED_GITHUB_USERS),
    allowedHosts: allowedHosts(env),
  })
}

async function deviceFlowProxy(request: Request, url: URL, env: Env) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const path = url.pathname.slice('/api/gh-login'.length)
  if (path !== '/login/device/code' && path !== '/login/oauth/access_token') return json({ error: 'not found' }, 404)
  const host = (url.searchParams.get('host') ?? 'github.com').toLowerCase()
  if (!isAllowedHost(host, env)) return json({ error: `host ${host} is not allowed; add it to GHES_HOSTS` }, 403)
  const body = new URLSearchParams(await request.text())
  // The device flow never needs a client secret; refuse to forward one.
  body.delete('client_secret')
  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'gh-ui' },
    body,
  })
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } })
}

function randomToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)
}

/** A path on this origin. Resolving it catches what a prefix check misses: browsers read /\host as //host and drop tabs and newlines. */
function safeNext(next: string | null | undefined, origin: string) {
  if (!next?.startsWith('/')) return '/'
  try {
    const u = new URL(next, origin)
    return u.origin === origin ? u.pathname + u.search + u.hash : '/'
  } catch {
    return '/'
  }
}

function oauthStart(url: URL, env: Env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'web OAuth is not configured' }, 404)
  const state = randomToken()
  const next = safeNext(url.searchParams.get('next'), url.origin)
  const authorize = new URL('https://github.com/login/oauth/authorize')
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  authorize.searchParams.set('redirect_uri', `${url.origin}/api/oauth/callback`)
  authorize.searchParams.set('scope', OAUTH_SCOPES)
  authorize.searchParams.set('state', state)
  const cookie = `gd_oauth=${encodeURIComponent(JSON.stringify({ state, next }))}; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  return new Response(null, { status: 302, headers: { location: authorize.toString(), 'set-cookie': cookie, 'cache-control': 'no-store' } })
}

async function oauthCallback(request: Request, url: URL, env: Env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'web OAuth is not configured' }, 404)
  const cookie = /(?:^|;\s*)gd_oauth=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
  let saved: { state?: string; next?: string } = {}
  try {
    saved = cookie ? JSON.parse(decodeURIComponent(cookie)) : {}
  } catch {
    saved = {}
  }
  const state = url.searchParams.get('state')
  if (!state || !saved.state || state !== saved.state) return handoff({ error: 'Sign-in expired or was tampered with. Start again.' }, '/', 400, false)
  const next = safeNext(saved.next, url.origin)
  // GitHub comes back with ?error= when the user cancels or the app is misconfigured.
  const denied = url.searchParams.get('error')
  if (denied) return handoff({ error: oauthErrorMessage(denied, url.searchParams.get('error_description'), url.origin, env.GITHUB_CLIENT_ID) }, next, 400)
  const code = url.searchParams.get('code')
  if (!code) return handoff({ error: 'GitHub did not return an authorization code. Start again.' }, next, 400)

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'gh-ui' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/api/oauth/callback` }),
  })
  // An outage or rate limit can answer with an HTML page instead of JSON. Errors come back as HTTP 200 with an error code.
  const data = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null
  if (!data?.access_token) {
    const message = data?.error ? oauthErrorMessage(data.error, data.error_description ?? null, url.origin, env.GITHUB_CLIENT_ID) : `GitHub did not return a token (HTTP ${res.status}).`
    return handoff({ error: message }, next, 502)
  }
  return handoff({ token: data.access_token, host: 'github.com' }, next)
}

/** GitHub's description of an OAuth error, plus what to change when the deployment is at fault. */
function oauthErrorMessage(error: string, description: string | null, origin: string, clientId: string) {
  switch (error) {
    // What GitHub answers (HTTP 404) for a client ID it doesn't know.
    case 'Not Found':
      return `GitHub answered “Not Found” for client ID ${clientId}. Check GITHUB_CLIENT_ID on this deployment.`
    case 'access_denied':
      return 'Authorization was cancelled on GitHub.'
    case 'bad_verification_code':
      return `${description ?? 'The code passed is incorrect or expired.'} Start again.`
    case 'incorrect_client_credentials':
      return `${description ?? 'The client_id and/or client_secret passed are incorrect.'} Check GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on this deployment.`
    case 'redirect_uri_mismatch':
      return `${description ?? 'The redirect_uri MUST match the registered callback URL for this application.'} Set the OAuth App's callback URL to ${origin}/api/oauth/callback.`
    default:
      return description ?? `GitHub returned ${error}.`
  }
}

/**
 * Ends the web flow on /login, which finishes sign-in or shows the error in its banner. The token
 * goes through sessionStorage on this origin, never through the URL; errors take the same path so
 * nobody can put text on the login page with a crafted link.
 */
function handoff(result: { token: string; host: string } | { error: string }, next: string, status = 200, consumeState = true) {
  const nonce = randomToken(16)
  const failed = 'error' in result
  const payload = JSON.stringify(result).replace(/</g, '\\u003c')
  const target = JSON.stringify(`/login?next=${encodeURIComponent(next)}`).replace(/</g, '\\u003c')
  const fallback = failed ? `<noscript><p>Sign-in failed: ${escapeHtml(result.error)}</p><p><a href="/login">Back to sign in</a></p></noscript>` : ''
  const html = `<!doctype html><meta charset="utf-8"><title>${failed ? 'Sign-in failed' : 'Signing in…'}</title><script nonce="${nonce}">sessionStorage.setItem('gh-ui:oauth-handoff', ${JSON.stringify(payload)});location.replace(${target});</script>${fallback}`
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'`,
    'referrer-policy': 'no-referrer',
  })
  // A matched state is single-use. A mismatch (a stale tab or a forged link) leaves the cookie for the sign-in in progress.
  if (consumeState) headers.set('set-cookie', 'gd_oauth=; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  return new Response(html, { status, headers })
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// ---------------------------------------------------------------------------
// Anthropic proxy

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta, authorization, x-api-key, x-gh-ui-github-token, x-gh-ui-github-host, x-stainless-arch, x-stainless-helper, x-stainless-helper-method, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version, x-stainless-timeout, anthropic-dangerous-direct-browser-access',
  'access-control-max-age': '86400',
}

const identityCache = new Map<string, { login: string; expires: number }>()

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Resolves the GitHub login behind a token, cached briefly per isolate. */
async function githubLogin(token: string, host: string, env: Env): Promise<string | null> {
  if (!isAllowedHost(host, env)) return null
  const key = `${host}:${await sha256(token)}`
  const hit = identityCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.login
  const api = host === 'github.com' ? 'https://api.github.com' : host.endsWith('.ghe.com') ? `https://api.${host}` : `https://${host}/api/v3`
  const res = await fetch(`${api}/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'gh-ui' } })
  if (!res.ok) return null
  const user = (await res.json()) as { login: string }
  identityCache.set(key, { login: user.login, expires: Date.now() + 5 * 60_000 })
  return user.login
}

async function anthropicProxy(request: Request, url: URL, env: Env) {
  if (request.method === 'OPTIONS') {
    // Echo the requested headers so new SDK headers can't break preflight. Only the headers
    // copied by name below are forwarded upstream, and the SDK's Bearer "proxy" key is ignored.
    const requested = request.headers.get('access-control-request-headers')
    return new Response(null, { status: 204, headers: { ...CORS, ...(requested ? { 'access-control-allow-headers': requested } : {}), vary: 'access-control-request-headers' } })
  }
  if (!env.ANTHROPIC_API_KEY) return json({ type: 'error', error: { type: 'not_configured', message: 'This gh-ui deployment has no ANTHROPIC_API_KEY.' } }, 503, CORS)
  // Logins are only unique per host, so a bare entry means github.com and other hosts are listed as host/login.
  const allowed = (env.ALLOWED_GITHUB_USERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => (s === '*' || s.includes('/') ? s : `github.com/${s}`))
  if (!allowed.length) return json({ type: 'error', error: { type: 'not_configured', message: 'Set ALLOWED_GITHUB_USERS to enable the proxy.' } }, 503, CORS)

  const token = request.headers.get('x-gh-ui-github-token')
  const host = (request.headers.get('x-gh-ui-github-host') ?? 'github.com').toLowerCase()
  const login = token ? await githubLogin(token, host, env) : null
  if (!login) return json({ type: 'error', error: { type: 'authentication_error', message: 'Sign in to GitHub to use the agent proxy.' } }, 401, CORS)
  if (!allowed.includes('*') && !allowed.includes(`${host}/${login.toLowerCase()}`)) {
    return json({ type: 'error', error: { type: 'permission_error', message: `${host}/${login} is not in ALLOWED_GITHUB_USERS.` } }, 403, CORS)
  }

  const path = url.pathname.slice('/api/anthropic'.length)
  if (!/^\/v1\/(messages(\/count_tokens)?|models(\/[\w.-]+)?)$/.test(path)) return json({ error: 'not found' }, 404, CORS)
  const headers = new Headers()
  for (const h of ['content-type', 'anthropic-version', 'anthropic-beta', 'accept']) {
    const v = request.headers.get(h)
    if (v) headers.set(h, v)
  }
  headers.set('x-api-key', env.ANTHROPIC_API_KEY)
  const upstream = await fetch(`https://api.anthropic.com${path}${url.search}`, { method: request.method, headers, body: request.method === 'GET' ? undefined : request.body })
  const out = new Headers(CORS)
  for (const h of ['content-type', 'request-id', 'retry-after', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-tokens-remaining']) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  out.set('cache-control', 'no-store')
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

// ---------------------------------------------------------------------------
// Actions job logs

async function jobLogs(request: Request, url: URL, env: Env) {
  const auth = request.headers.get('authorization')
  const owner = url.searchParams.get('owner')
  const repo = url.searchParams.get('repo')
  const job = url.searchParams.get('job')
  const api = url.searchParams.get('api') ?? 'https://api.github.com'
  if (!auth || !owner || !repo || !job || !/^\d+$/.test(job)) return json({ error: 'bad request' }, 400)
  let apiUrl: URL
  try {
    apiUrl = new URL(api)
  } catch {
    return json({ error: 'bad api base' }, 400)
  }
  const host = apiUrl.hostname === 'api.github.com' ? 'github.com' : apiUrl.hostname.replace(/^api\./, '')
  if (apiUrl.protocol !== 'https:' || !isAllowedHost(host, env)) return json({ error: 'api host not allowed' }, 403)
  const first = await fetch(`${apiUrl.origin}${apiUrl.pathname.replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${job}/logs`, {
    headers: { authorization: auth, accept: 'application/vnd.github+json', 'user-agent': 'gh-ui' },
    redirect: 'manual',
  })
  const location = first.status >= 300 && first.status < 400 ? first.headers.get('location') : null
  // The blob URL is pre-signed; fetch it without the GitHub token.
  const res = location ? await fetch(location) : first
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}
