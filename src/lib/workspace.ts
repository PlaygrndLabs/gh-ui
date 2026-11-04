// One repository, wherever it lives: a folder on this computer, a repository on GitHub, or both, linked by the folder's
// origin remote. The workspace's tabs and repository list work from these and don't care which kind they have.

import { useQuery } from '@tanstack/react-query'
import { parseRemote } from './links'
import { localGit } from './git'
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
  if (repo.github && sameHost(repo.github.host, accountHost)) return `/${repo.github.owner}/${repo.github.repo}`
  return repo.local ? `/local/${repo.local.id}` : null
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
