import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SCOPES, pollDeviceToken, requestDeviceCode, takeWebOAuthResult, type DeviceCode } from './oauth'

// In a plain browser (no Electron bridge) the device flow goes through /api/gh-login.
function mockLogin(...replies: Array<{ status?: number; body: unknown }>) {
  const queue = [...replies]
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    void init
    const next = queue.shift()
    if (!next) throw new Error('unexpected extra request')
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const formOf = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body)))

const CODE: DeviceCode = { device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const pending = { body: { error: 'authorization_pending', error_description: 'The authorization request is still pending.' } }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('requestDeviceCode', () => {
  it('asks for a device code with the client ID and the default scopes', async () => {
    const fetchMock = mockLogin({ body: CODE })
    await expect(requestDeviceCode('github.com', 'Ov23liX')).resolves.toEqual(CODE)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gh-login/login/device/code')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
    expect(formOf(init)).toEqual({ client_id: 'Ov23liX', scope: DEFAULT_SCOPES.join(' ') })
  })

  it('names the Enterprise host for the proxy', async () => {
    const fetchMock = mockLogin({ body: CODE })
    await requestDeviceCode('git.corp.example', 'Iv1.abc')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/gh-login/login/device/code?host=git.corp.example')
  })

  it('explains the bare 404 GitHub gives an unknown client ID', async () => {
    mockLogin({ status: 404, body: { error: 'Not Found' } })
    await expect(requestDeviceCode('github.com', 'Ov23liDummy')).rejects.toThrow('GitHub answered “Not Found” for client ID Ov23liDummy.')
  })

  it("shows GitHub's description for other errors", async () => {
    mockLogin({ status: 400, body: { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App' } })
    await expect(requestDeviceCode('github.com', 'Ov23liX')).rejects.toThrow('Device Flow must be explicitly enabled for this App')
  })

  it('reports a non-JSON answer with its status', async () => {
    mockLogin({ status: 502, body: '<html>Bad gateway</html>' })
    await expect(requestDeviceCode('github.com', 'Ov23liX')).rejects.toThrow('GitHub login endpoint returned 502: <html>Bad gateway</html>')
  })
})

describe('pollDeviceToken', () => {
  beforeEach(() => vi.useFakeTimers())

  it('waits the interval between polls and returns the token once authorized', async () => {
    const fetchMock = mockLogin(pending, { body: { access_token: 'ghu_usertoken', token_type: 'bearer', expires_in: 28800, refresh_token: 'ghr_refresh' } })
    const token = pollDeviceToken('github.com', 'Iv23liApp', CODE, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(token).resolves.toBe('ghu_usertoken')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gh-login/login/oauth/access_token')
    expect(formOf(init)).toEqual({ client_id: 'Iv23liApp', device_code: 'dev-code', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
  })

  it('never polls faster than every 5 seconds', async () => {
    const fetchMock = mockLogin({ body: { access_token: 'gho_x' } })
    const token = pollDeviceToken('github.com', 'Ov23liX', { ...CODE, interval: 1 }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(token).resolves.toBe('gho_x')
  })

  it('adds 5 seconds to the interval on slow_down', async () => {
    const fetchMock = mockLogin({ body: { error: 'slow_down', error_description: 'Too many requests have been made in the same timeframe.' } }, pending, { body: { access_token: 'gho_x' } })
    const token = pollDeviceToken('github.com', 'Ov23liX', CODE, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The longer interval sticks.
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(token).resolves.toBe('gho_x')
  })

  it('uses the new interval GitHub sends with slow_down when it is longer', async () => {
    const fetchMock = mockLogin({ body: { error: 'slow_down', interval: 20 } }, { body: { access_token: 'gho_x' } })
    const token = pollDeviceToken('github.com', 'Ov23liX', CODE, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(5_000 + 19_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(token).resolves.toBe('gho_x')
  })

  it.each([
    ['expired_token', { error: 'expired_token', error_description: 'The device_code has expired.' }, 'The device code expired. Start again.'],
    ['access_denied', { error: 'access_denied', error_description: 'The authorization request was denied.' }, 'Authorization was cancelled on GitHub.'],
    ['incorrect_device_code', { error: 'incorrect_device_code', error_description: 'The device_code provided is not valid.' }, 'The device_code provided is not valid.'],
    ['incorrect_client_credentials', { error: 'incorrect_client_credentials', error_description: 'The client_id is not valid.' }, 'The client_id is not valid.'],
    ['an unknown answer', { foo: 'bar' }, 'Unexpected response from GitHub'],
  ])('stops on %s', async (_label, body, message) => {
    const fetchMock = mockLogin(pending, { body })
    const token = pollDeviceToken('github.com', 'Ov23liX', CODE, new AbortController().signal)
    const settled = expect(token).rejects.toThrow(message)
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up when the device code runs out', async () => {
    const fetchMock = mockLogin(pending, pending)
    const token = pollDeviceToken('github.com', 'Ov23liX', { ...CODE, expires_in: 12 }, new AbortController().signal)
    const settled = expect(token).rejects.toThrow('The device code expired. Start again.')
    await vi.advanceTimersByTimeAsync(15_000)
    await settled
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops waiting as soon as it is aborted', async () => {
    const fetchMock = mockLogin(pending)
    const abort = new AbortController()
    const token = pollDeviceToken('github.com', 'Ov23liX', CODE, abort.signal)
    const settled = expect(token).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(7_000)
    abort.abort()
    await settled
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start when already aborted', async () => {
    const fetchMock = mockLogin()
    const abort = new AbortController()
    abort.abort()
    await expect(pollDeviceToken('github.com', 'Ov23liX', CODE, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('takeWebOAuthResult', () => {
  function fakeSessionStorage(initial?: string) {
    const store = new Map<string, string>(initial === undefined ? [] : [['gi-ui:oauth-handoff', initial]])
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    return store
  }

  it('takes the token the callback page left, once', () => {
    const store = fakeSessionStorage(JSON.stringify({ token: 'gho_web', host: 'github.com' }))
    expect(takeWebOAuthResult()).toEqual({ token: 'gho_web', host: 'github.com' })
    expect(store.size).toBe(0)
    expect(takeWebOAuthResult()).toBeNull()
  })

  it('passes on why sign-in failed', () => {
    fakeSessionStorage(JSON.stringify({ error: 'Authorization was cancelled on GitHub.' }))
    expect(takeWebOAuthResult()).toEqual({ error: 'Authorization was cancelled on GitHub.' })
  })

  it('ignores missing or garbled hand-offs', () => {
    fakeSessionStorage()
    expect(takeWebOAuthResult()).toBeNull()
    fakeSessionStorage('{not json')
    expect(takeWebOAuthResult()).toBeNull()
    fakeSessionStorage('{}')
    expect(takeWebOAuthResult()).toBeNull()
  })
})
