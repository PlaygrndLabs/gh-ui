import { describe, expect, it, vi } from 'vitest'
import type { Octokit } from '@octokit/rest'
import { githubSource, imageType, previewKind, sameBytes } from './filePreview'

describe('previewKind', () => {
  it.each([
    ['public/logo.PNG', 'image'],
    ['icons/pangram.svg', 'image'],
    ['a/b.webp', 'image'],
    ['README.md', 'markdown'],
    ['docs/guide.markdown', 'markdown'],
    ['src/app.ts', null],
    ['archive.zip', null],
  ])('%s → %s', (path, kind) => expect(previewKind(path)).toBe(kind))
  it('draws an SVG as one', () => expect(imageType('x.svg')).toBe('image/svg+xml'))
})

const b64 = (s: string) => btoa(s)

function fakeOctokit(files: Record<string, { size: number; content: string; sha: string } | 404>, blobs: Record<string, string> = {}) {
  const getContent = vi.fn(async ({ path, ref }: { path: string; ref: string }) => {
    const f = files[`${ref}:${path}`]
    if (!f || f === 404) throw Object.assign(new Error('Not Found'), { status: 404 })
    return { data: { type: 'file', encoding: 'base64', ...f } }
  })
  const getBlob = vi.fn(async ({ file_sha }: { file_sha: string }) => ({ data: { content: blobs[file_sha] } }))
  return { octokit: { rest: { repos: { getContent }, git: { getBlob } } } as unknown as Octokit, getContent, getBlob }
}

describe('githubSource', () => {
  it('reads a small file from the contents API at each side’s commit', async () => {
    const { octokit } = fakeOctokit({ 'p1:a.png': { size: 3, content: b64('old'), sha: 's1' }, 'c1:a.png': { size: 3, content: b64('new'), sha: 's2' } })
    const src = githubSource(octokit, 'o', 'r', { before: 'p1', after: 'c1' })
    expect(new TextDecoder().decode((await src.read('before', 'a.png'))!)).toBe('old')
    expect(new TextDecoder().decode((await src.read('after', 'a.png'))!)).toBe('new')
  })

  it('goes to the blobs API past the contents API’s 1 MB limit', async () => {
    const { octokit, getBlob } = fakeOctokit({ 'c1:big.png': { size: 2_000_000, content: '', sha: 'blob1' } }, { blob1: b64('big\n') })
    const bytes = await githubSource(octokit, 'o', 'r', { before: null, after: 'c1' }).read('after', 'big.png')
    expect(getBlob).toHaveBeenCalledWith({ owner: 'o', repo: 'r', file_sha: 'blob1' })
    expect(sameBytes(bytes, new TextEncoder().encode('big\n'))).toBe(true)
  })

  it('has nothing for a side with no commit, or a file that isn’t there', async () => {
    const { octokit, getContent } = fakeOctokit({ 'c1:a.png': 404 })
    const src = githubSource(octokit, 'o', 'r', { before: null, after: 'c1' })
    expect(await src.read('before', 'a.png')).toBeNull()
    expect(await src.read('after', 'a.png')).toBeNull()
    expect(getContent).toHaveBeenCalledTimes(1)
  })

  it('asks for a lazy revision once, however many files need it', async () => {
    const { octokit } = fakeOctokit({ 'base:a.png': { size: 1, content: b64('a'), sha: 'x' }, 'base:b.png': { size: 1, content: b64('b'), sha: 'y' } })
    const mergeBase = vi.fn(async () => 'base')
    const src = githubSource(octokit, 'o', 'r', { before: mergeBase, after: 'head' })
    await Promise.all([src.read('before', 'a.png'), src.read('before', 'b.png')])
    expect(mergeBase).toHaveBeenCalledTimes(1)
  })
})
