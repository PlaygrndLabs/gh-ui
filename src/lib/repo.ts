import { useMemo } from 'react'
import { useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useGitHub, type Repo } from './github'

export interface RepoContext {
  owner: string
  repo: string
  data: Repo
  fullName: string
}

/** Repository loaded by RepoLayout; available to every page under /:owner/:repo. */
export function useRepo() {
  return useOutletContext<RepoContext>()
}

export function useRepoParams() {
  const { owner = '', repo = '' } = useParams()
  return { owner, repo }
}

export function useRepoQuery(owner: string, repo: string, enabled = true) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'repo', owner, repo],
    queryFn: async () => (await octokit.rest.repos.get({ owner, repo })).data,
    enabled: enabled && !!owner && !!repo,
    staleTime: 60_000,
  })
}

/** Open issue / PR counts for the repo tabs, in one GraphQL call. */
export function useRepoCounts(owner: string, repo: string, enabled = true) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'repo-counts', owner, repo],
    enabled: enabled && !!owner && !!repo,
    staleTime: 60_000,
    queryFn: async () => {
      const res: { repository: { issues: { totalCount: number }; pullRequests: { totalCount: number } } } = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount} } }`,
        { owner, repo },
      )
      return { issues: res.repository.issues.totalCount, pulls: res.repository.pullRequests.totalCount }
    },
  })
}

/**
 * Published security advisories: the count github.com shows on the "Security and quality" tab to
 * everyone. Tokens without advisory access just get no counter.
 */
export function useRepoAdvisoryCount(owner: string, repo: string, enabled = true) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'repo-advisory-count', owner, repo],
    enabled: enabled && !!owner && !!repo,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => (await octokit.rest.securityAdvisories.listRepositoryAdvisories({ owner, repo, state: 'published', per_page: 100 })).data.length,
  })
}

export function useBranches(owner: string, repo: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'branches', owner, repo],
    staleTime: 60_000,
    queryFn: async () => {
      const out: Array<{ name: string; protected: boolean; sha: string }> = []
      for await (const page of octokit.paginate.iterator(octokit.rest.repos.listBranches, { owner, repo, per_page: 100 })) {
        for (const b of page.data) out.push({ name: b.name, protected: b.protected, sha: b.commit.sha })
        if (out.length >= 1000) break
      }
      return out
    },
  })
}

export function useTags(owner: string, repo: string, enabled = true) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'tags', owner, repo],
    enabled,
    staleTime: 60_000,
    // Fresh, so a tag a release just created shows up in the pickers.
    queryFn: async () => (await octokit.rest.repos.listTags({ owner, repo, per_page: 100 })).data.map((t) => ({ name: t.name, sha: t.commit.sha })),
  })
}

/**
 * Splits a `tree/<ref>/<path>` splat. Refs may contain slashes, so the longest
 * known branch or tag prefix wins; otherwise the first segment is the ref.
 */
export function splitRefPath(splat: string, refs: string[], fallbackRef: string): { ref: string; path: string } {
  const clean = splat.replace(/^\/+|\/+$/g, '')
  if (!clean) return { ref: fallbackRef, path: '' }
  const sorted = [...refs].sort((a, b) => b.length - a.length)
  for (const r of sorted) {
    if (clean === r) return { ref: r, path: '' }
    if (clean.startsWith(r + '/')) return { ref: r, path: clean.slice(r.length + 1) }
  }
  // The router has already decoded the splat; decoding again breaks refs containing '%'.
  const [first, ...rest] = clean.split('/')
  return { ref: first, path: rest.join('/') }
}

export function encodePath(path: string) {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/** Resolves ref + path from the route splat, using the branch/tag list for refs containing slashes. */
export function useRefPath() {
  const { data } = useRepo()
  const params = useParams()
  const splat = params['*'] ?? ''
  const branches = useBranches(data.owner.login, data.name)
  const tags = useTags(data.owner.login, data.name, splat.includes('/'))
  const refs = useMemo(() => [...(branches.data ?? []).map((b) => b.name), ...(tags.data ?? []).map((t) => t.name)], [branches.data, tags.data])
  const needsRefs = splat.includes('/') && !branches.data
  return { ...splitRefPath(splat, refs, data.default_branch), resolving: needsRefs && branches.isLoading }
}
