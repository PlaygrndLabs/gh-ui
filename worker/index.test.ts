import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from './index'

const ORIGIN = 'https://gh-ui.example'

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>

/** Replaces globalThis.fetch (the Worker's only way out) and records every upstream call. */
function mockFetch(handler: FetchHandler = () => new Response('unexpected upstream call', { status: 599 })) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

function makeEnv(vars: Partial<Omit<Env, 'ASSETS'>> = {}) {
  const assets = vi.fn(async () => new Response('<!doctype html><title>gh-ui</title>', { headers: { 'content-type': 'text/html' } }))
  return { env: { ASSETS: { fetch: assets } as unknown as Fetcher, ...vars } as Env, assets }
}

const OAUTH = { GITHUB_CLIENT_ID: 'Ov23liTestClient', GITHUB_CLIENT_SECRET: 'test-secret' }

function call(path: string, env: Env, init?: RequestInit) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env)
}

/** Runs the callback page's inline script the way a browser would and returns what it handed to the SPA. */
function runHandoff(html: string) {
  const script = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html)
  if (!script) throw new Error('no handoff script')
  const stored = new Map<string, string>()
  const location = { replaced: '' }
  new Function('sessionStorage', 'location', script[2])(
    { setItem: (k: string, v: string) => stored.set(k, v) },
    { replace: (to: string) => (location.replaced = to) },
  )
  const raw = stored.get('gh-ui:oauth-handoff')
  return { nonce: script[1], payload: raw ? (JSON.parse(raw) as { token?: string; host?: string; error?: string }) : null, target: location.replaced }
}

async function startFlow(env: Env, next = '/') {
  const res = await call(`/api/oauth/start?next=${encodeURIComponent(next)}`, env)
  const cookie = res.headers.get('set-cookie') ?? ''
  const state = new URL(res.headers.get('location')!).searchParams.get('state')!
  return { res, cookie, state, cookiePair: cookie.split(';')[0] }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/config', () => {
  it('reports nothing optional when no vars are set', async () => {
    mockFetch()
    const res = await call('/api/config', makeEnv().env)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ oauthClientId: null, webOAuth: false, anthropicProxy: false, allowedHosts: ['github.com'] })
  })

  it('treats the empty strings from wrangler.jsonc as unset', async () => {
    mockFetch()
    const res = await call('/api/config', makeEnv({ GITHUB_CLIENT_ID: '', ALLOWED_GITHUB_USERS: '', GHES_HOSTS: '' }).env)
    expect(await res.json()).toMatchObject({ oauthClientId: null, webOAuth: false, anthropicProxy: false })
  })

  it('offers the device flow with only a client ID, and web OAuth only with the secret too', async () => {
    mockFetch()
    expect(await (await call('/api/config', makeEnv({ GITHUB_CLIENT_ID: 'Ov23liX' }).env)).json()).toMatchObject({ oauthClientId: 'Ov23liX', webOAuth: false })
    expect(await (await call('/api/config', makeEnv({ GITHUB_CLIENT_SECRET: 's' }).env)).json()).toMatchObject({ oauthClientId: null, webOAuth: false })
    expect(await (await call('/api/config', makeEnv(OAUTH).env)).json()).toMatchObject({ oauthClientId: 'Ov23liTestClient', webOAuth: true })
  })

  it('enables the Anthropic proxy only with a key and an allow list, and lists GHES hosts', async () => {
    mockFetch()
    expect(await (await call('/api/config', makeEnv({ ANTHROPIC_API_KEY: 'k' }).env)).json()).toMatchObject({ anthropicProxy: false })
    const res = await call('/api/config', makeEnv({ ANTHROPIC_API_KEY: 'k', ALLOWED_GITHUB_USERS: 'octo', GHES_HOSTS: ' Git.Corp.Example , ' }).env)
    expect(await res.json()).toMatchObject({ anthropicProxy: true, allowedHosts: ['github.com', 'git.corp.example'] })
  })
})

describe('GET /api/oauth/start', () => {
  it('is off until both the client ID and secret are set', async () => {
    mockFetch()
    expect((await call('/api/oauth/start', makeEnv().env)).status).toBe(404)
    expect((await call('/api/oauth/start', makeEnv({ GITHUB_CLIENT_ID: 'Ov23liX' }).env)).status).toBe(404)
  })

  it("redirects to GitHub's authorize page with this origin's callback, the scopes and a random state", async () => {
    const fetchMock = mockFetch()
    const { env } = makeEnv(OAUTH)
    const { res, cookie, state } = await startFlow(env, '/octo/repo/pulls?q=is%3Aopen')
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(to.searchParams.get('client_id')).toBe('Ov23liTestClient')
    expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/oauth/callback`)
    expect(to.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['repo', 'workflow', 'read:org', 'notifications']))
    expect(to.searchParams.has('client_secret')).toBe(false)
    expect(state).toMatch(/^[\w-]{32}$/)
    expect((await startFlow(env)).state).not.toBe(state)

    expect(cookie).toMatch(/^gd_oauth=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/api/oauth')
    expect(cookie).toContain('Max-Age=600')
    const saved = JSON.parse(decodeURIComponent(cookie.split(';')[0].slice('gd_oauth='.length)))
    expect(saved).toEqual({ state, next: '/octo/repo/pulls?q=is%3Aopen' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['//evil.example/x', '/\\evil.example/x', '/\t/evil.example', '/\n/evil.example', 'https://evil.example/', 'javascript:alert(1)', ''])(
    'keeps next=%j on this origin',
    async (next) => {
      mockFetch()
      const { cookie } = await startFlow(makeEnv(OAUTH).env, next)
      const saved = JSON.parse(decodeURIComponent(cookie.split(';')[0].slice('gd_oauth='.length)))
      expect(new URL(saved.next, ORIGIN).origin).toBe(ORIGIN)
    },
  )
})

describe('GET /api/oauth/callback', () => {
  const tokenOk = () => Response.json({ access_token: 'gho_freshtoken', token_type: 'bearer', scope: 'repo,workflow' })

  it.each([
    ['no state', (state: string) => `/api/oauth/callback?code=abc`, true],
    ['a different state', (state: string) => `/api/oauth/callback?code=abc&state=${state}x`, true],
    ['no cookie', (state: string) => `/api/oauth/callback?code=abc&state=${state}`, false],
  ])('rejects %s without calling GitHub', async (_label, path, withCookie) => {
    const { env } = makeEnv(OAUTH)
    const { cookiePair, state } = await startFlow(env)
    const fetchMock = mockFetch(tokenOk)
    const res = await call(path(state), env, { headers: withCookie ? { cookie: cookiePair } : {} })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    const { payload, target } = runHandoff(await res.text())
    expect(payload).toEqual({ error: 'Sign-in expired or was tampered with. Start again.' })
    expect(target).toBe('/login?next=%2F')
    // The sign-in still in progress keeps its state.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('exchanges the code with the client secret and hands the token to the SPA through sessionStorage', async () => {
    const { env } = makeEnv(OAUTH)
    const { cookiePair, state } = await startFlow(env, '/octo/repo')
    const fetchMock = mockFetch(tokenOk)
    const res = await call(`/api/oauth/callback?code=the-code&state=${state}`, env, { headers: { cookie: `theme=dark; ${cookiePair}` } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://github.com/login/oauth/access_token')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: 'Ov23liTestClient', client_secret: 'test-secret', code: 'the-code', redirect_uri: `${ORIGIN}/api/oauth/callback` })

    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toMatch(/^gd_oauth=; .*Max-Age=0/)
    const html = await res.text()
    const { nonce, payload, target } = runHandoff(html)
    expect(res.headers.get('content-security-policy')).toBe(`default-src 'none'; script-src 'nonce-${nonce}'`)
    expect(payload).toEqual({ token: 'gho_freshtoken', host: 'github.com' })
    expect(target).toBe('/login?next=%2Focto%2Frepo')
  })

  it.each([
    ['bad_verification_code', 'The code passed is incorrect or expired.', /^The code passed is incorrect or expired\. Start again\.$/],
    ['incorrect_client_credentials', 'The client_id and/or client_secret passed are incorrect.', /incorrect\. Check GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/],
    ['redirect_uri_mismatch', 'The redirect_uri MUST match the registered callback URL for this application.', /callback URL to https:\/\/gh-ui\.example\/api\/oauth\/callback\.$/],
    ['unverified_user_email', 'The user must have a verified primary email.', /^The user must have a verified primary email\.$/],
    ['Not Found', undefined, /^GitHub answered “Not Found” for client ID Ov23liTestClient\. Check GITHUB_CLIENT_ID/],
  ])('turns GitHub’s %s into a readable message', async (error, description, expected) => {
    const { env } = makeEnv(OAUTH)
    const { cookiePair, state } = await startFlow(env, '/notifications')
    // GitHub reports token-exchange errors with HTTP 200.
    mockFetch(() => Response.json({ error, error_description: description, error_uri: 'https://docs.github.com/apps/...' }))
    const res = await call(`/api/oauth/callback?code=stale&state=${state}`, env, { headers: { cookie: cookiePair } })
    expect(res.status).toBe(502)
    const html = await res.text()
    expect(html).toContain('<title>Sign-in failed</title>')
    const { payload, target } = runHandoff(html)
    expect(payload?.error).toMatch(expected)
    expect(payload).not.toHaveProperty('token')
    expect(target).toBe('/login?next=%2Fnotifications')
  })

  it('explains a cancelled authorization instead of calling it tampering', async () => {
    const { env } = makeEnv(OAUTH)
    const { cookiePair, state } = await startFlow(env)
    const fetchMock = mockFetch(tokenOk)
    const res = await call(`/api/oauth/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=${state}`, env, { headers: { cookie: cookiePair } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(runHandoff(await res.text()).payload).toEqual({ error: 'Authorization was cancelled on GitHub.' })
  })

  it('does not show error text from a link whose state does not match', async () => {
    const { env } = makeEnv(OAUTH)
    const { cookiePair } = await startFlow(env)
    mockFetch()
    const res = await call('/api/oauth/callback?error=x&error_description=Call+this+number&state=forged', env, { headers: { cookie: cookiePair } })
    expect(runHandoff(await res.text()).payload?.error).toBe('Sign-in expired or was tampered with. Start again.')
  })

  it('copes with an HTML outage page and with GitHub being unreachable', async () => {
    const { env } = makeEnv(OAUTH)
    let { cookiePair, state } = await startFlow(env)
    mockFetch(() => new Response('<html>Unicorn!</html>', { status: 503, headers: { 'content-type': 'text/html' } }))
    let res = await call(`/api/oauth/callback?code=c&state=${state}`, env, { headers: { cookie: cookiePair } })
    expect(runHandoff(await res.text()).payload).toEqual({ error: 'GitHub did not return a token (HTTP 503).' })

    ;({ cookiePair, state } = await startFlow(env))
    mockFetch(() => Promise.reject(new TypeError('fetch failed')))
    res = await call(`/api/oauth/callback?code=c&state=${state}`, env, { headers: { cookie: cookiePair } })
    expect(res.status).toBe(502)
    expect(runHandoff(await res.text()).payload).toEqual({ error: 'Could not reach GitHub (fetch failed). Try again.' })
  })

  it('escapes the no-script fallback', async () => {
    const { env } = makeEnv(OAUTH)
    const { cookiePair, state } = await startFlow(env)
    mockFetch(() => Response.json({ error: 'weird', error_description: '</script><img src=x onerror=alert(1)>' }))
    const html = await (await call(`/api/oauth/callback?code=c&state=${state}`, env, { headers: { cookie: cookiePair } })).text()
    expect(html).not.toContain('<img')
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(runHandoff(html).payload?.error).toBe('</script><img src=x onerror=alert(1)>')
  })

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/path'])('never sends the SPA to another origin through a saved next=%j', async (next) => {
    const { env } = makeEnv(OAUTH)
    // A hand-made cookie, as if the start step had been bypassed.
    const cookie = `gd_oauth=${encodeURIComponent(JSON.stringify({ state: 'S', next }))}`
    mockFetch(tokenOk)
    const res = await call('/api/oauth/callback?code=c&state=S', env, { headers: { cookie } })
    const { target } = runHandoff(await res.text())
    expect(target).toBe('/login?next=%2F')
  })
})

describe('POST /api/gh-login/* (device-flow proxy)', () => {
  const deviceCode = () => Response.json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 })

  it('forwards the device-code request to github.com without a client secret', async () => {
    const fetchMock = mockFetch(deviceCode)
    const res = await call('/api/gh-login/login/device/code', makeEnv().env, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'client_id=Ov23liX&scope=repo+read%3Aorg&client_secret=leak',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user_code: 'ABCD-1234' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://github.com/login/device/code')
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(body)).toEqual({ client_id: 'Ov23liX', scope: 'repo read:org' })
  })

  it('forwards token polling and passes GitHub’s answer through', async () => {
    const fetchMock = mockFetch(() => Response.json({ error: 'authorization_pending', error_description: 'The authorization request is still pending.' }))
    const res = await call('/api/gh-login/login/oauth/access_token', makeEnv().env, { method: 'POST', body: 'client_id=Ov23liX&device_code=dc&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://github.com/login/oauth/access_token')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ error: 'authorization_pending' })
  })

  it('passes GitHub’s status through for an unknown client ID', async () => {
    mockFetch(() => Response.json({ error: 'Not Found' }, { status: 404 }))
    const res = await call('/api/gh-login/login/device/code', makeEnv().env, { method: 'POST', body: 'client_id=nope' })
    expect(res.status).toBe(404)
  })

  it.each([
    ['GET', '/api/gh-login/login/device/code', 405],
    ['POST', '/api/gh-login/login/oauth/authorize', 404],
    ['POST', '/api/gh-login/api/v3/user', 404],
    ['POST', '/api/gh-login/login/device/code/../../../user', 404],
    ['POST', '/api/gh-login/login/device/code?host=evil.example', 403],
    ['POST', '/api/gh-login/login/device/code?host=github.com.evil.example', 403],
    ['POST', '/api/gh-login/login/device/code?host=git.corp.example', 403],
  ])('refuses %s %s', async (method, path, status) => {
    const fetchMock = mockFetch(deviceCode)
    const res = await call(path, makeEnv().env, { method, body: method === 'GET' ? undefined : 'client_id=x' })
    expect(res.status).toBe(status)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows GHES_HOSTS and GHE.com subdomains', async () => {
    const fetchMock = mockFetch(deviceCode)
    const { env } = makeEnv({ GHES_HOSTS: 'git.corp.example' })
    await call('/api/gh-login/login/device/code?host=Git.Corp.Example', env, { method: 'POST', body: 'client_id=x' })
    await call('/api/gh-login/login/oauth/access_token?host=acme.ghe.com', env, { method: 'POST', body: 'client_id=x' })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://git.corp.example/login/device/code', 'https://acme.ghe.com/login/oauth/access_token'])
  })

  it('reports an unreachable host as JSON', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')))
    const res = await call('/api/gh-login/login/device/code', makeEnv().env, { method: 'POST', body: 'client_id=x' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'fetch failed' })
  })
})

describe('/api/anthropic/* (agent proxy)', () => {
  let tokenSeq = 0
  // The Worker caches identities per token, so every test uses fresh tokens.
  const freshToken = () => `gho_test${++tokenSeq}_${Math.random().toString(36).slice(2)}`

  function upstream(users: Record<string, string>) {
    return mockFetch((url, init) => {
      if (url.endsWith('/user')) {
        const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        const key = `${new URL(url).host}|${token}`
        return users[key] ? Response.json({ login: users[key] }) : Response.json({ message: 'Bad credentials' }, { status: 401 })
      }
      if (url.startsWith('https://api.anthropic.com/')) return Response.json({ id: 'msg_1', type: 'message' }, { headers: { 'request-id': 'req_1' } })
      return new Response('unexpected', { status: 599 })
    })
  }

  const post = (env: Env, headers: Record<string, string>, path = '/api/anthropic/v1/messages') =>
    call(path, env, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: '{"model":"claude"}' })

  const anthropicCalls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter((c) => String(c[0]).startsWith('https://api.anthropic.com/'))

  it('answers CORS preflight without checking anything', async () => {
    const fetchMock = mockFetch()
    const res = await call('/api/anthropic/v1/messages', makeEnv().env, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'x-new-header' } })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toBe('x-new-header')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is off without a key or an allow list', async () => {
    const fetchMock = upstream({})
    expect((await post(makeEnv({ ALLOWED_GITHUB_USERS: '*' }).env, {})).status).toBe(503)
    expect((await post(makeEnv({ ANTHROPIC_API_KEY: 'sk-server' }).env, {})).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a GitHub token that GitHub accepts', async () => {
    const fetchMock = upstream({})
    const { env } = makeEnv({ ANTHROPIC_API_KEY: 'sk-server', ALLOWED_GITHUB_USERS: '*' })
    expect((await post(env, {})).status).toBe(401)
    const res = await post(env, { 'x-gh-ui-github-token': freshToken() })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(anthropicCalls(fetchMock)).toHaveLength(0)
  })

  it('reads a bare login as a github.com user and forwards with the server key only', async () => {
    const token = freshToken()
    const fetchMock = upstream({ [`api.github.com|${token}`]: 'Octo' })
    const { env } = makeEnv({ ANTHROPIC_API_KEY: 'sk-server', ALLOWED_GITHUB_USERS: 'someone, octo' })
    const res = await post(env, { 'x-gh-ui-github-token': token, authorization: 'Bearer proxy', 'x-api-key': 'sk-client' })
    expect(res.status).toBe(200)
    expect(res.headers.get('request-id')).toBe('req_1')
    const [[url, init]] = anthropicCalls(fetchMock)
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe('sk-server')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-gh-ui-github-token')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
  })

  it('refuses a user who is not on the list', async () => {
    const token = freshToken()
    const fetchMock = upstream({ [`api.github.com|${token}`]: 'mallory' })
    const res = await post(makeEnv({ ANTHROPIC_API_KEY: 'sk-server', ALLOWED_GITHUB_USERS: 'octo' }).env, { 'x-gh-ui-github-token': token })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('github.com/mallory is not in ALLOWED_GITHUB_USERS.')
    expect(anthropicCalls(fetchMock)).toHaveLength(0)
  })

  it('does not let an Enterprise user borrow a github.com entry with the same login', async () => {
    const token = freshToken()
    const fetchMock = upstream({ [`git.corp.example|${token}`]: 'octo' })
    const vars = { ANTHROPIC_API_KEY: 'sk-server', GHES_HOSTS: 'git.corp.example' }
    const ghes = { 'x-gh-ui-github-token': token, 'x-gh-ui-github-host': 'git.corp.example' }
    expect((await post(makeEnv({ ...vars, ALLOWED_GITHUB_USERS: 'octo' }).env, ghes)).status).toBe(403)
    expect(fetchMock.mock.calls[0][0]).toBe('https://git.corp.example/api/v3/user')
    expect((await post(makeEnv({ ...vars, ALLOWED_GITHUB_USERS: 'git.corp.example/Octo' }).env, ghes)).status).toBe(200)
    expect(anthropicCalls(fetchMock)).toHaveLength(1)
  })

  it('lets "*" in any signed-in user, but never checks identity against an unlisted host', async () => {
    const token = freshToken()
    const fetchMock = upstream({ [`api.github.com|${token}`]: 'anyone', [`evil.example|${token}`]: 'octo' })
    const { env } = makeEnv({ ANTHROPIC_API_KEY: 'sk-server', ALLOWED_GITHUB_USERS: '*' })
    expect((await post(env, { 'x-gh-ui-github-token': token })).status).toBe(200)
    const evil = await post(env, { 'x-gh-ui-github-token': token, 'x-gh-ui-github-host': 'evil.example' })
    expect(evil.status).toBe(401)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('evil.example'))).toBe(false)
  })

  it('only forwards the messages and models endpoints', async () => {
    const token = freshToken()
    const fetchMock = upstream({ [`api.github.com|${token}`]: 'octo' })
    const res = await post(makeEnv({ ANTHROPIC_API_KEY: 'sk-server', ALLOWED_GITHUB_USERS: 'octo' }).env, { 'x-gh-ui-github-token': token }, '/api/anthropic/v1/files')
    expect(res.status).toBe(404)
    expect(anthropicCalls(fetchMock)).toHaveLength(0)
  })
})

describe('GET /api/gh/job-logs', () => {
  const path = '/api/gh/job-logs?owner=octo&repo=hello&job=42'

  it('follows the redirect to the pre-signed log URL without the token', async () => {
    const fetchMock = mockFetch((url) =>
      url.startsWith('https://api.github.com/')
        ? new Response(null, { status: 302, headers: { location: 'https://productionresultssa0.blob.core.windows.net/logs/42.txt?sig=abc' } })
        : new Response('2026-10-31T00:00:00Z hello\n'),
    )
    const res = await call(path, makeEnv().env, { headers: { authorization: 'Bearer gho_secret' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('2026-10-31T00:00:00Z hello\n')
    const [first, second] = fetchMock.mock.calls
    expect(first[0]).toBe('https://api.github.com/repos/octo/hello/actions/jobs/42/logs')
    expect(new Headers(first[1]?.headers).get('authorization')).toBe('Bearer gho_secret')
    expect(first[1]?.redirect).toBe('manual')
    expect(second[0]).toBe('https://productionresultssa0.blob.core.windows.net/logs/42.txt?sig=abc')
    expect(new Headers(second[1]?.headers).get('authorization')).toBeNull()
  })

  it('passes GitHub errors through when there is no redirect', async () => {
    const fetchMock = mockFetch(() => new Response('{"message":"Not Found"}', { status: 404 }))
    const res = await call(path, makeEnv().env, { headers: { authorization: 'Bearer t' } })
    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the Enterprise API base and refuses hosts that are not configured', async () => {
    const fetchMock = mockFetch(() => new Response('log'))
    const ghes = `${path}&api=${encodeURIComponent('https://git.corp.example/api/v3')}`
    expect((await call(ghes, makeEnv().env, { headers: { authorization: 'Bearer t' } })).status).toBe(403)
    expect((await call(`${path}&api=${encodeURIComponent('http://api.github.com')}`, makeEnv().env, { headers: { authorization: 'Bearer t' } })).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    await call(ghes, makeEnv({ GHES_HOSTS: 'git.corp.example' }).env, { headers: { authorization: 'Bearer t' } })
    expect(fetchMock.mock.calls[0][0]).toBe('https://git.corp.example/api/v3/repos/octo/hello/actions/jobs/42/logs')
  })

  it('rejects requests without a token or with a non-numeric job', async () => {
    const fetchMock = mockFetch()
    expect((await call(path, makeEnv().env)).status).toBe(400)
    expect((await call('/api/gh/job-logs?owner=o&repo=r&job=1/../2', makeEnv().env, { headers: { authorization: 'Bearer t' } })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('everything else', () => {
  it('serves the SPA from static assets and 404s unknown API routes', async () => {
    mockFetch()
    const { env, assets } = makeEnv()
    expect((await call('/octo/hello/pulls', env)).headers.get('content-type')).toBe('text/html')
    expect(assets).toHaveBeenCalledTimes(1)
    const res = await call('/api/nope', env)
    expect(res.status).toBe(404)
    expect(assets).toHaveBeenCalledTimes(1)
  })
})
