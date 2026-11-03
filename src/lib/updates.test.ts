import { describe, expect, it } from 'vitest'
import { isNewerVersion, releasePage, releaseVersion } from './updates'

describe('isNewerVersion', () => {
  it('compares numerically, part by part', () => {
    expect(isNewerVersion('0.3.0', '0.2.1')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
  })
  it('stays quiet for the same or an older version', () => {
    expect(isNewerVersion('0.2.1', '0.2.1')).toBe(false)
    expect(isNewerVersion('0.2.0', '0.2.1')).toBe(false)
  })
  it('stays quiet for anything that is not X.Y.Z', () => {
    expect(isNewerVersion('nightly', '0.2.1')).toBe(false)
    expect(isNewerVersion('1.0.0-rc.1', '0.2.1')).toBe(false)
    expect(isNewerVersion('0.3.0', '0.0.0-dev')).toBe(false)
  })
})

describe('releaseVersion', () => {
  it('reads the tag', () => expect(releaseVersion({ tag_name: 'v0.3.0' })).toBe('0.3.0'))
  it.each([[null], [{}], [{ tag_name: 7 }], [{ tag_name: 'v1' }], [{ tag_name: 'v0.3.0"><script>' }], [{ tag_name: 'v1.0.0', draft: true }], [{ tag_name: 'v1.0.0', prerelease: true }]])(
    'ignores %j',
    (body) => expect(releaseVersion(body)).toBeNull(),
  )
  it('builds the page link itself', () => expect(releasePage('0.3.0')).toBe('https://github.com/PlaygrndLabs/gh-ui/releases/tag/v0.3.0'))
})
