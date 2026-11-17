import { describe, expect, it } from 'vitest'
import { avatarUrlFor, initials, loginFromEmail } from './people'

describe('loginFromEmail', () => {
  it('reads the login from GitHub noreply addresses', () => {
    expect(loginFromEmail('12345+octo-cat@users.noreply.github.com')).toBe('octo-cat')
    expect(loginFromEmail('octocat@users.noreply.github.com')).toBe('octocat')
    expect(loginFromEmail('49699333+dependabot[bot]@users.noreply.github.com')).toBe('dependabot[bot]')
  })
  it('knows nothing from any other email', () => {
    expect(loginFromEmail('babak@example.com')).toBeUndefined()
    expect(loginFromEmail('noreply@github.com')).toBeUndefined()
    expect(loginFromEmail(undefined)).toBeUndefined()
  })
})

describe('avatarUrlFor', () => {
  it('uses the login when there is one', () => {
    expect(avatarUrlFor({ login: 'octocat', email: 'x@example.com', size: 20 })).toBe('https://avatars.githubusercontent.com/octocat?size=40')
    expect(avatarUrlFor({ login: 'renovate[bot]', size: 16 })).toBe('https://avatars.githubusercontent.com/renovate?size=32')
  })
  it('looks a git author up by email, never by name', () => {
    expect(avatarUrlFor({ email: '1+lena@users.noreply.github.com', size: 20 })).toBe('https://avatars.githubusercontent.com/lena?size=40')
    expect(avatarUrlFor({ email: 'babak+work@example.com', size: 16 })).toBe('https://avatars.githubusercontent.com/u/e?email=babak%2Bwork%40example.com&s=32')
    expect(avatarUrlFor({ size: 16 })).toBe('')
  })
})

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Babak Rahimi')).toBe('BR')
    expect(initials('ada lovelace byron')).toBe('AB')
    expect(initials('rae')).toBe('R')
    expect(initials('')).toBe('?')
  })
})
