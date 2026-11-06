// One repository, wherever it lives: a folder on this computer, a repository on GitHub, or both, linked by the folder's
// origin remote. The workspace's tabs and repository list work from these and don't care which kind they have.

import { useQuery } from '@tanstack/react-query'
import { useGitHub } from './github'
import { parseRemote } from './links'
import { localGit, type BranchState } from './git'
import { native, type LocalRepo } from './platform'
import { useSharedPref } from './storage'

export interface GitHubRepoRef {
  host: string
  owner: string
  repo: string
}

export type RepoLocation = 'both' | 'local' | 'github'

export interface WorkspaceRepo {
  /** Stable across restarts, for tabs and preferences. */
  key: string
  name: string
  location: RepoLocation
  local: LocalRepo | null
  github: GitHubRepoRef | null
}

/** GitHub ignores case in names, so two spellings of one repository share a key. */
export const githubKey = (ref: GitHubRepoRef) => `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase()

const sameHost = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Folders first, oldest first, then the GitHub repositories without a folder here. A second clone of one repository is
 * its own entry, since it has its own branch and changes; the first clone is the one the GitHub repository links to.
 */
export function buildWorkspaceRepos(folders: Array<{ repo: LocalRepo; remoteUrl: string }>, githubOnly: GitHubRepoRef[]): WorkspaceRepo[] {
  const taken = new Set<string>()
  const result: WorkspaceRepo[] = []
  for (const { repo, remoteUrl } of [...folders].sort((a, b) => a.repo.addedAt - b.repo.addedAt)) {
    const github = remoteUrl ? parseRemote(remoteUrl) : null
    const key = github ? githubKey(github) : null
    if (key && !taken.has(key)) {
      taken.add(key)
      result.push({ key, name: github!.repo, location: 'both', local: repo, github })
    } else {
      result.push({ key: `local/${repo.id}`, name: repo.name, location: github ? 'both' : 'local', local: repo, github })
    }
  }
  for (const github of githubOnly) {
    const key = githubKey(github)
    if (taken.has(key)) continue
    taken.add(key)
    result.push({ key, name: github.repo, location: 'github', local: null, github })
  }
  return result
}

/**
 * The repository's in-app path. Pages under /:owner/:repo always read the signed-in account's host, so a repository on
 * another host can only open as its folder; null means this account can't open it at all.
 */
export function workspacePath(repo: WorkspaceRepo, accountHost: string): string | null {
  const isExtraClone = repo.key.startsWith('local/')
  if (repo.github && sameHost(repo.github.host, accountHost) && !isExtraClone) return `/${repo.github.owner}/${repo.github.repo}`
  return repo.local ? `/local/${repo.local.id}` : null
}

export type SyncKind = 'clone' | 'publish-repo' | 'publish-branch' | 'pull' | 'push' | 'fetch'

/** The one network action the toolbar offers, the way GitHub Desktop picks it. */
export function syncAction(location: RepoLocation, status: { upstream: string | null; ahead: number; behind: number } | undefined): { kind: SyncKind; count: number } | null {
  if (location === 'github') return { kind: 'clone', count: 0 }
  if (location === 'local') return { kind: 'publish-repo', count: 0 }
  if (!status) return null
  if (!status.upstream) return { kind: 'publish-branch', count: 0 }
  if (status.behind > 0) return { kind: 'pull', count: status.behind }
  if (status.ahead > 0) return { kind: 'push', count: status.ahead }
  return { kind: 'fetch', count: 0 }
}

export function addGitHubRepo(list: GitHubRepoRef[], ref: GitHubRepoRef): GitHubRepoRef[] {
  return list.some((r) => githubKey(r) === githubKey(ref)) ? list : [...list, ref]
}

export function removeGitHubRepo(list: GitHubRepoRef[], key: string): GitHubRepoRef[] {
  return list.filter((r) => githubKey(r) !== key)
}

/** Every repository the workspace knows about, plus the GitHub-only list to change. */
export function useWorkspaceRepos() {
  const [githubOnly, setGitHubOnly] = useSharedPref<GitHubRepoRef[]>('workspaceGitHubRepos', [])
  const folders = useQuery({
    queryKey: ['workspace-folders'],
    enabled: !!native,
    queryFn: async () => {
      const repos = await native!.repos.list()
      return Promise.all(repos.map(async (repo) => ({ repo, remoteUrl: await localGit(repo.id).remoteUrl() })))
    },
  })
  return {
    repos: buildWorkspaceRepos(folders.data ?? [], githubOnly),
    isLoading: folders.isLoading,
    addGitHubRepo: (ref: GitHubRepoRef) => setGitHubOnly((list) => addGitHubRepo(list, ref)),
    removeGitHubRepo: (key: string) => setGitHubOnly((list) => removeGitHubRepo(list, key)),
  }
}

/** Branches of a repository that has no folder here, default branch first. */
export function useRemoteBranches(repo: WorkspaceRepo) {
  const { octokit, key, account } = useGitHub()
  const github = repo.github && repo.github.host.toLowerCase() === account.host.toLowerCase() ? repo.github : null
  return useQuery({
    queryKey: [key, 'workspace-branches', github?.owner, github?.repo],
    enabled: !repo.local && !!github,
    queryFn: async () => {
      const [info, list] = await Promise.all([octokit.rest.repos.get({ owner: github!.owner, repo: github!.repo }), octokit.rest.repos.listBranches({ owner: github!.owner, repo: github!.repo, per_page: 100 })])
      const toState = (b: (typeof list.data)[number]): BranchState => ({ name: b.name, current: false, location: 'remote', upstream: null, ahead: 0, behind: 0, gone: false, sha: b.commit.sha, date: '' })
      return list.data.map(toState).sort((a, b) => Number(b.name === info.data.default_branch) - Number(a.name === info.data.default_branch))
    },
  })
}
