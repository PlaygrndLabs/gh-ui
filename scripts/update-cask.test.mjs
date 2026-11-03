import { describe, expect, it } from 'vitest'
import { caskVersion, renderCask } from './update-cask.mjs'

const arm64 = 'a'.repeat(64)
const x64 = 'b'.repeat(64)

describe('renderCask', () => {
  it('pins the version and each architecture to its checksum', () => {
    const cask = renderCask({ version: '1.2.3', arm64, x64 })
    expect(caskVersion(cask)).toBe('1.2.3')
    expect(cask).toContain(`arm:   "${arm64}"`)
    expect(cask).toContain(`intel: "${x64}"`)
    expect(cask).toContain('/releases/download/v#{version}/GitHub-UI-#{arch}.dmg')
    expect(cask).not.toContain(':no_check')
    expect(cask).not.toContain(':latest')
  })
  it('refuses a bad version or checksum', () => {
    expect(() => renderCask({ version: 'latest', arm64, x64 })).toThrow()
    expect(() => renderCask({ version: '1.2.3', arm64: 'nope', x64 })).toThrow('sha256')
  })
})

describe('caskVersion', () => {
  it('reads a pinned version and reports an unpinned one as null', () => {
    expect(caskVersion('cask "x" do\n  version "0.2.1"\nend')).toBe('0.2.1')
    expect(caskVersion('cask "x" do\n  version :latest\nend')).toBeNull()
  })
})
