import { afterEach, describe, expect, it, vi } from 'vitest'
import { onTokenRejected, reauthPath, rejectedAccountIds, reportRejectedToken, tokenSignInProblem, verifyToken, type Account } from './auth'
import { octokitFor } from './github'

function mockUserResponse(status: number, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    void init
    return new Response(JSON.stringify(status === 200 ? { login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/1' } : { message: 'Bad credentials' }), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('verifyToken (PAT sign-in)', () => {
  it('accepts a classic PAT and records its scopes', async () => {
    const fetchMock = mockUserResponse(200, { 'x-oauth-scopes': 'repo, workflow, read:org' })
    const info = await verifyToken('ghp_exampleexampleexampleexample0000', 'github.com')
    expect(info).toMatchObject({ login: 'octo', apiBase: 'https://api.github.com', scopes: ['repo', 'workflow', 'read:org'] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/user')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghp_exampleexampleexampleexample0000')
  })

  it('accepts a fine-grained PAT, which has no OAuth scopes header', async () => {
    mockUserResponse(200)
    const info = await verifyToken('github_pat_example', 'github.com')
    expect(info.scopes).toBeNull()
  })

  it('talks to the Enterprise Server API for GHES hosts', async () => {
    const fetchMock = mockUserResponse(200)
    await verifyToken('ghp_x', 'git.corp.example')
    expect(fetchMock.mock.calls[0][0]).toBe('https://git.corp.example/api/v3/user')
  })

  it('reports bad credentials clearly', async () => {
    mockUserResponse(401)
    await expect(verifyToken('ghp_revoked', 'github.com')).rejects.toThrow(/Bad credentials/)
  })

  it('explains why installation tokens cannot sign in, without asking GitHub', async () => {
    const fetchMock = mockUserResponse(403)
    await expect(verifyToken('ghs_installation', 'github.com')).rejects.toThrow(/installation tokens \(ghs_…\) have no user identity/)
    await expect(verifyToken('ghs_installation', 'github.com')).rejects.toThrow(/device flow using the GitHub App’s client ID, which gives you a user token \(ghu_…\)/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('points a pasted refresh token at its access token', async () => {
    const fetchMock = mockUserResponse(200)
    await expect(verifyToken('ghr_refresh', 'github.com')).rejects.toThrow(/refresh token \(ghr_…\)/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a GitHub App user token and does not read app permissions as missing scopes', async () => {
    mockUserResponse(200, { 'x-oauth-scopes': '' })
    const info = await verifyToken('ghu_usertoken', 'github.com')
    expect(info).toMatchObject({ login: 'octo', scopes: null })
    expect(tokenSignInProblem('ghu_usertoken')).toBeNull()
    expect(tokenSignInProblem('gho_oauth')).toBeNull()
  })

  it("passes GitHub's message on for other refusals", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })))
    await expect(verifyToken('v1.0123456789abcdef', 'github.com')).rejects.toThrow('GitHub returned 403 for /user: Resource not accessible by integration.')
  })
})

const account = (login: string, token: string): Account => ({
  id: `github.com:${login}`,
  method: 'pat',
  kind: 'classic-pat',
  token,
  host: 'github.com',
  apiBase: 'https://api.github.com',
  login,
  name: null,
  avatarUrl: '',
  scopes: [],
  addedAt: 0,
})

describe('rejected tokens (expired or revoked)', () => {
  it('flags only accounts that still hold the rejected token', () => {
    const accounts = [account('octo', 'ghp_new'), account('hubot', 'ghu_expired'), account('mona', 'ghp_fine')]
    const rejected = rejectedAccountIds(accounts, { 'github.com:octo': 'ghp_old', 'github.com:hubot': 'ghu_expired', 'github.com:gone': 'x' })
    expect([...rejected]).toEqual(['github.com:hubot'])
  })

  it('tells subscribers until they unsubscribe', () => {
    const seen: string[] = []
    const off = onTokenRejected((id, token) => seen.push(`${id}=${token}`))
    reportRejectedToken('github.com:octo', 'ghp_a')
    off()
    reportRejectedToken('github.com:octo', 'ghp_b')
    expect(seen).toEqual(['github.com:octo=ghp_a'])
  })

  it('builds the sign-in-again link for an account', () => {
    const url = new URL(reauthPath({ login: 'octo', host: 'git.corp.example' }, '/octo/repo/pulls?q=is:open'), 'https://x.invalid')
    expect(url.pathname).toBe('/login')
    expect(Object.fromEntries(url.searchParams)).toEqual({ reauth: 'octo', host: 'git.corp.example', next: '/octo/repo/pulls?q=is:open' })
  })

  it('is reported by Octokit when GitHub answers 401, for REST and GraphQL alike', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Bad credentials', status: '401' }, { status: 401 })))
    const seen: string[] = []
    const off = onTokenRejected((id, token) => seen.push(`${id}=${token}`))
    const octokit = octokitFor(account('octo', 'ghu_expired_401'))
    await expect(octokit.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 401 })
    await expect(octokit.graphql('{ viewer { login } }')).rejects.toMatchObject({ status: 401 })
    off()
    expect(seen).toEqual(['github.com:octo=ghu_expired_401', 'github.com:octo=ghu_expired_401'])
  })

  it('is not reported for other errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Not Found' }, { status: 404 })))
    const seen: string[] = []
    const off = onTokenRejected((id) => seen.push(id))
    await expect(octokitFor(account('octo', 'ghp_fine_404')).rest.repos.get({ owner: 'o', repo: 'r' })).rejects.toMatchObject({ status: 404 })
    off()
    expect(seen).toEqual([])
  })
})
