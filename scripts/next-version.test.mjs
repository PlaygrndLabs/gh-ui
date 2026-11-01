import { describe, expect, it } from 'vitest'
import { commitBump, compareVersions, latestTag, nextVersion } from './next-version.mjs'

describe('latestTag', () => {
  it('compares numerically and ignores tags that are not releases', () => {
    expect(latestTag(['v0.9.0', 'v0.10.0', 'v0.2.5', ''])).toBe('0.10.0')
    expect(latestTag(['v1', 'v2.0.0-beta.1', 'nightly', 'x1.0.0', 'v0.1.0'])).toBe('0.1.0')
    expect(latestTag([])).toBeUndefined()
  })
})

describe('commitBump', () => {
  it('reads conventional commits', () => {
    expect(commitBump('feat: add a thing')).toBe('feature')
    expect(commitBump('feat(ui): add a thing')).toBe('feature')
    expect(commitBump('fix: a bug')).toBe('patch')
    expect(commitBump('ci: tweak')).toBe('patch')
    expect(commitBump('Plain sentence commit')).toBe('patch')
    expect(commitBump('feature flags cleanup')).toBe('patch')
  })
  it('finds breaking changes in the subject or a footer', () => {
    expect(commitBump('feat!: drop it')).toBe('breaking')
    expect(commitBump('refactor(api)!: drop it')).toBe('breaking')
    expect(commitBump('fix: x\n\nBREAKING CHANGE: y')).toBe('breaking')
    expect(commitBump('fix: mention BREAKING CHANGE: in passing')).toBe('patch')
  })
})

describe('nextVersion', () => {
  const next = (latest, messages, floor = '0.1.0') => nextVersion({ latest, messages, floor })
  it('releases nothing without new commits', () => expect(next('0.1.0', [])).toBeNull())
  it('takes the largest bump', () => {
    expect(next('0.1.0', ['fix: a', 'docs: b'])).toBe('0.1.1')
    expect(next('0.1.4', ['fix: a', 'feat: b'])).toBe('0.2.0')
    expect(next('1.2.3', ['feat: a', 'fix!: b'])).toBe('2.0.0')
    expect(next('1.2.3', ['feat: a'], '1.0.0')).toBe('1.3.0')
  })
  it('stays below 1.0 until package.json says otherwise', () => {
    expect(next('0.3.1', ['feat!: a'])).toBe('0.4.0')
    expect(next('0.3.1', ['fix: a'], '1.0.0')).toBe('1.0.0')
  })
  it('never goes below or repeats the latest tag', () => {
    expect(next('0.9.0', ['fix: a'], '0.1.0')).toBe('0.9.1')
    expect(compareVersions(next('0.9.0', ['fix: a'], '0.9.0'), '0.9.0')).toBeGreaterThan(0)
  })
})
