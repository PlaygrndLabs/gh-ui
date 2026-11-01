import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import type { Account } from './auth'
import { useGitHub, FULL_BODY } from './github'
import { native } from './platform'

// Release data shared by the release pages (src/pages/repo/Releases.tsx) and the release form (ReleaseForm.tsx).

export type Release = RestEndpointMethodTypes['repos']['listReleases']['response']['data'][number] & { body_html?: string }

/**
 * The repository's latest release (what github.com badges "Latest"), or null when it has none. GraphQL answers
 * null where REST getLatestRelease would log a 404.
 */
export function useLatestRelease(owner: string, repo: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'release-latest', owner, repo],
    staleTime: 60_000,
    queryFn: async () => {
      const res: { repository: { latestRelease: { databaseId: number; tagName: string } | null } } = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ latestRelease{ databaseId tagName } } }`,
        { owner, repo },
      )
      const latest = res.repository.latestRelease
      return latest ? { id: latest.databaseId, tag: latest.tagName } : null
    },
  })
}

/**
 * The release for a tag, or null when the tag has none (github.com links every tag to /releases/tag/<tag>).
 * GraphQL answers null where REST getReleaseByTag would log a 404. Drafts can't be found by tag there (their
 * tag may not exist yet, and github.com links them as /releases/tag/untagged-…), so viewers who can push also
 * look for a draft with that tag or URL among the newest releases.
 */
export function useReleaseByTag(owner: string, repo: string, tag: string, canPush: boolean) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'release', owner, repo, tag],
    queryFn: async (): Promise<Release | null> => {
      const res: { repository: { release: { databaseId: number | null } | null } } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$tag:String!){ repository(owner:$owner,name:$repo){ release(tagName:$tag){ databaseId } } }`,
        { owner, repo, tag },
      )
      let id = res.repository.release?.databaseId
      if (!id && canPush) {
        const { data } = await octokit.rest.repos.listReleases({ owner, repo, per_page: 100 })
        id = data.find((r) => r.draft && (r.tag_name === tag || r.html_url.endsWith(`/releases/tag/${tag}`)))?.id
      }
      if (!id) return null
      return (await octokit.rest.repos.getRelease({ owner, repo, release_id: id, ...FULL_BODY })).data as Release
    },
  })
}

/** Refetches every release and tag query of a repository after a release changed. */
export function invalidateReleases(qc: QueryClient, key: string, owner: string, repo: string) {
  void qc.invalidateQueries({
    predicate: ({ queryKey: [k, kind, o, r] }) => k === key && typeof kind === 'string' && /^(release|tag)/.test(kind) && o === owner && r === repo,
  })
}

/**
 * Whether a typed name can become a tag, following `git check-ref-format`: no spaces, control characters or
 * ~^:?*[\, no "..", "@{", "//", no component starting with "." or ending with ".lock", no trailing "/" or ".".
 */
export function isValidTagName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** The "Choose a tag" menu: existing tags matching the filter, plus the name to offer as "Create new tag: … on publish". */
export function tagMenu(tags: string[], filter: string): { matches: string[]; create: string | null } {
  const f = filter.trim()
  const lower = f.toLowerCase()
  const matches = tags.filter((t) => t.toLowerCase().includes(lower))
  const create = f && !tags.includes(f) && isValidTagName(f) ? f : null
  return { matches, create }
}

/**
 * The REST `make_latest` value for the "Set as the latest release" checkbox. Drafts and pre-releases can't be
 * latest. Left unchecked on a new release, github.com picks the latest by semantic versioning ("legacy"); on an
 * existing release, unchecking only demotes it when it is the latest now.
 */
export function makeLatestValue(o: { checked: boolean; prerelease: boolean; publishing: boolean; isNew: boolean; wasLatest: boolean }): 'true' | 'false' | 'legacy' | undefined {
  if (!o.publishing || o.prerelease) return undefined
  if (o.checked) return 'true'
  if (o.isNew) return 'legacy'
  return o.wasLatest ? 'false' : undefined
}

/** Expands a release's upload_url template (".../assets{?name,label}") for one file. */
export function assetUploadUrl(uploadUrl: string, name: string, label?: string): string {
  const base = uploadUrl.replace(/\{[^}]*\}$/, '')
  return `${base}?name=${encodeURIComponent(name)}${label ? `&label=${encodeURIComponent(label)}` : ''}`
}

/**
 * uploads.github.com answers without CORS headers (not even to a preflight), so a browser page can't upload
 * release assets. The desktop app sends them from the main process instead.
 */
export const canUploadAssets = !!native

/** Uploads one file to a release through the desktop main process (see canUploadAssets). */
export async function uploadReleaseAsset(account: Pick<Account, 'token'>, uploadUrl: string, file: File): Promise<void> {
  if (!native) throw new Error('Uploading release assets needs the gh-ui desktop app.')
  const res = await native.http({
    url: assetUploadUrl(uploadUrl, file.name),
    method: 'POST',
    headers: { Authorization: `Bearer ${account.token}`, Accept: 'application/vnd.github+json', 'Content-Type': file.type || 'application/octet-stream' },
    body: new Uint8Array(await file.arrayBuffer()),
  })
  if (res.status >= 300) {
    let message = `HTTP ${res.status}`
    try {
      const data = JSON.parse(res.body) as { message?: string; errors?: Array<{ code?: string; field?: string }> }
      if (data.errors?.some((e) => e.code === 'already_exists')) message = 'A file with this name already exists'
      else if (data.message) message = data.message
    } catch {
      // not JSON: keep the status
    }
    throw new Error(`Could not upload ${file.name}: ${message}`)
  }
}
