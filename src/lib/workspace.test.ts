import { describe, expect, it } from 'vitest'
import { addGitHubRepo, buildWorkspaceRepos, githubKey, removeGitHubRepo, syncAction, workspacePath, type GitHubRepoRef } from './workspace'
import type { LocalRepo } from './platform'

const folder = (id: string, addedAt: number, remoteUrl = '') => ({ repo: { id, path: `/code/${id}`, name: id, addedAt } satisfies LocalRepo, remoteUrl })
const web: GitHubRepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }
const api: GitHubRepoRef = { host: 'github.com', owner: 'acme', repo: 'api' }

describe('buildWorkspaceRepos', () => {
  it('links a folder to its GitHub repository through origin', () => {
    const [repo] = buildWorkspaceRepos([folder('checkout', 1, 'git@github.com:acme/web.git')], [])
    expect(repo).toMatchObject({ key: 'github.com/acme/web', name: 'web', location: 'both', github: web })
    expect(repo.local?.id).toBe('checkout')
  })

  it('keeps a folder without a remote, or with one that isn’t a GitHub URL', () => {
    const repos = buildWorkspaceRepos([folder('notes', 1), folder('odd', 2, '/mnt/backup/odd.git')], [])
    expect(repos.map((r) => [r.key, r.location, r.github])).toEqual([
      ['local/notes', 'local', null],
      ['local/odd', 'local', null],
    ])
  })

  it('merges a GitHub-only repository with a folder of it, ignoring case', () => {
    const repos = buildWorkspaceRepos([folder('checkout', 1, 'https://github.com/Acme/Web.git')], [web, api])
    expect(repos.map((r) => [r.key, r.location])).toEqual([
      ['github.com/acme/web', 'both'],
      ['github.com/acme/api', 'github'],
    ])
  })

  it('gives a second clone its own entry, and the oldest keeps the link', () => {
    const repos = buildWorkspaceRepos([folder('newer', 2, 'https://github.com/acme/web'), folder('older', 1, 'https://github.com/acme/web')], [])
    expect(repos.map((r) => [r.key, r.local?.id])).toEqual([
      ['github.com/acme/web', 'older'],
      ['local/newer', 'newer'],
    ])
    expect(repos[1].location).toBe('both')
  })
})

describe('workspacePath', () => {
  const [both, local, github] = buildWorkspaceRepos([folder('checkout', 1, 'git@github.com:acme/web.git'), folder('notes', 2)], [api])

  it('prefers the GitHub path on the account’s host', () => {
    expect(workspacePath(both, 'GitHub.com')).toBe('/acme/web')
    expect(workspacePath(github, 'github.com')).toBe('/acme/api')
  })

  it('opens the folder when there’s no GitHub path for this account', () => {
    expect(workspacePath(local, 'github.com')).toBe('/local/notes')
    expect(workspacePath(both, 'ghe.example.com')).toBe('/local/checkout')
  })

  it('keeps a second clone on its own page', () => {
    const [, extra] = buildWorkspaceRepos([folder('first', 1, 'git@github.com:acme/web.git'), folder('second', 2, 'git@github.com:acme/web.git')], [])
    expect(workspacePath(extra, 'github.com')).toBe('/local/second')
  })

  it('can’t open a GitHub-only repository on another host', () => {
    expect(workspacePath(github, 'ghe.example.com')).toBeNull()
  })
})

describe('the GitHub-only list', () => {
  it('adds once and removes by key', () => {
    const list = addGitHubRepo(addGitHubRepo([], web), { ...web, owner: 'ACME' })
    expect(list).toEqual([web])
    expect(removeGitHubRepo(list, githubKey(web))).toEqual([])
  })
})

describe('syncAction', () => {
  const status = (upstream: string | null, ahead = 0, behind = 0) => ({ upstream, ahead, behind })

  it('offers what the repository’s location calls for first', () => {
    expect(syncAction('github', undefined)).toEqual({ kind: 'clone', count: 0 })
    expect(syncAction('local', status(null))).toEqual({ kind: 'publish-repo', count: 0 })
    expect(syncAction('both', undefined)).toBeNull()
  })

  it('then publishes, pulls before pushing, and otherwise fetches', () => {
    expect(syncAction('both', status(null, 3))).toEqual({ kind: 'publish-branch', count: 0 })
    expect(syncAction('both', status('origin/x', 1, 2))).toEqual({ kind: 'pull', count: 2 })
    expect(syncAction('both', status('origin/x', 1))).toEqual({ kind: 'push', count: 1 })
    expect(syncAction('both', status('origin/x'))).toEqual({ kind: 'fetch', count: 0 })
  })
})
