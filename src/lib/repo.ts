import { useMemo } from 'react'
import { useOutletContext, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useGitHub, type Repo } from './github'
import { native } from './platform'
import { readPref, writePref } from './storage'

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

type RepoSnapshots = Record<string, { at: number; data: Repo }>

const MAX_REPO_SNAPSHOTS = 30
const snapshotsPref = (accountId: string) => `repoSnapshots:${accountId}`
const loadedSnapshots = new Map<string, RepoSnapshots>()
const snapshotId = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

function snapshotsOf(accountId: string): RepoSnapshots {
  let all = loadedSnapshots.get(accountId)
  if (!all) {
    all = readPref<RepoSnapshots>(snapshotsPref(accountId), {})
    loadedSnapshots.set(accountId, all)
  }
  return all
}

function saveRepoSnapshot(accountId: string, owner: string, repo: string, data: Repo) {
  if (!native) return
  const all = snapshotsOf(accountId)
  all[snapshotId(owner, repo)] = { at: Date.now(), data }
  const ids = Object.keys(all)
  if (ids.length > MAX_REPO_SNAPSHOTS) for (const id of ids.sort((a, b) => all[a].at - all[b].at).slice(0, ids.length - MAX_REPO_SNAPSHOTS)) delete all[id]
  writePref(snapshotsPref(accountId), all)
}

export function forgetRepoSnapshots(accountId: string) {
  loadedSnapshots.delete(accountId)
  try {
    localStorage.removeItem(`gh-ui:${snapshotsPref(accountId)}`)
  } catch {
    // storage blocked; nothing was saved then either
  }
}

/**
 * Every page of a repository waits for this, so a repository seen before starts from what it last looked like and
 * catches up behind the page. The desktop app only: the web build has no reason to leave this in a shared browser.
 */
export function useRepoQuery(owner: string, repo: string, enabled = true) {
  const { octokit, key } = useGitHub()
  const on = enabled && !!owner && !!repo
  const snapshot = () => (native && on ? snapshotsOf(key)[snapshotId(owner, repo)] : undefined)
  return useQuery({
    queryKey: [key, 'repo', owner, repo],
    queryFn: async () => {
      const { data } = await octokit.rest.repos.get({ owner, repo })
      saveRepoSnapshot(key, owner, repo, data)
      return data
    },
    enabled: on,
    staleTime: 60_000,
    initialData: () => snapshot()?.data,
    initialDataUpdatedAt: () => snapshot()?.at,
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

/**
 * Resolves ref + path from the route splat. A ref can contain slashes, so where it ends takes knowing which refs exist,
 * but only those starting with the splat's first segment. Git won't put a branch under another branch's name, so when
 * that segment is the default branch (nearly every link) or a commit, there's nothing to ask.
 */
export function useRefPath() {
  const { data } = useRepo()
  const { octokit, key } = useGitHub()
  const params = useParams()
  const splat = params['*'] ?? ''
  const first = splat.replace(/^\/+/, '').split('/')[0]
  const owner = data.owner.login
  const repo = data.name
  const known = !splat.includes('/') || first === data.default_branch || /^[0-9a-f]{40}$/i.test(first)
  const candidates = useQuery({
    queryKey: [key, 'refs-under', owner, repo, first],
    enabled: !known,
    staleTime: 60_000,
    queryFn: async () => {
      const under = (kind: 'heads' | 'tags') => octokit.paginate(octokit.rest.git.listMatchingRefs, { owner, repo, ref: `${kind}/${first}`, per_page: 100 })
      const [heads, tags] = await Promise.all([under('heads'), under('tags')])
      return [...heads, ...tags].map((r) => r.ref.replace(/^refs\/(heads|tags)\//, ''))
    },
  })
  const refs = useMemo(() => (known ? [first] : (candidates.data ?? [])), [known, first, candidates.data])
  return { ...splitRefPath(splat, refs, data.default_branch), resolving: !known && candidates.isLoading }
}
