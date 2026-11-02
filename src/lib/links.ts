// Maps github.com (and API) URLs onto in-app routes so links inside rendered
// markdown, notifications and timelines stay inside gh-ui.

import { webBaseFor } from './hosts'

const RESERVED_OWNERS = new Set([
  'settings', 'notifications', 'pulls', 'issues', 'login', 'marketplace', 'explore', 'topics', 'sponsors',
  'orgs', 'features', 'about', 'pricing', 'enterprise', 'apps', 'codespaces', 'search', 'new', 'organizations',
  'users', 'security', 'site', 'trending', 'collections', 'events', 'customer-stories', 'readme', 'copilot',
  'local', 'oauth',
])

const SUPPORTED_REPO_SECTIONS = new Set([
  '', 'tree', 'blob', 'blame', 'commits', 'commit', 'branches', 'pulls', 'pull', 'compare', 'issues', 'actions',
  'releases', 'tags', 'discussions', 'projects', 'security', 'pulse', 'graphs', 'wiki', 'settings',
])

const ORG_TABS = new Set(['repositories', 'projects', 'people'])

// Repository settings pages gh-ui has; the rest (Pages, Actions, ruleset editing, …) open on github.com.
const SETTINGS_PATHS = /^(|access|branches|branch_protection_rules\/(new|\d+)|rules|hooks|keys|secrets\/actions|variables\/actions)$/

export function appPathFromUrl(href: string, host: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const apiHost = host === 'github.com' ? 'api.github.com' : host.endsWith('.ghe.com') ? `api.${host}` : host
  if (url.hostname === apiHost && (host === 'github.com' || host.endsWith('.ghe.com') || url.pathname.startsWith('/api/v3/'))) {
    return appPathFromApiUrl(href)
  }
  if (url.hostname !== host && url.hostname !== `www.${host}`) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const [owner, repo, section = '', ...rest] = parts
  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    if (['pulls', 'issues', 'notifications'].includes(owner) && parts.length === 1) return `/${owner}`
    // /orgs/<org>[/<tab>] is the organization profile; only the tabs gh-ui has stay in-app.
    if (owner === 'orgs' && repo && (!section || ORG_TABS.has(section)) && rest.length === 0) {
      const search = new URLSearchParams(url.search)
      if (section) search.set('tab', section)
      const query = search.toString()
      return `/${repo}${query ? `?${query}` : ''}` + url.hash
    }
    return null
  }
  if (!repo) return `/${owner}`
  if (!SUPPORTED_REPO_SECTIONS.has(section)) return null
  // Only the release list, latest, tag, new and edit pages exist in-app; downloads (releases/download/...,
  // releases/latest/download/...) and the rest open externally.
  if (section === 'releases') {
    if (rest.length === 0) return `/${owner}/${repo}/releases` + url.search + url.hash
    if (rest.length === 1 && (rest[0] === 'latest' || rest[0] === 'new')) return `/${owner}/${repo}/releases/${rest[0]}` + url.search + url.hash
    if ((rest[0] === 'tag' || rest[0] === 'edit') && rest[1]) return `/${owner}/${repo}/releases/${rest[0]}/${rest.slice(1).join('/')}` + url.search + url.hash
    return null
  }
  if (section === 'settings') {
    const sub = rest.join('/')
    return SETTINGS_PATHS.test(sub) ? `/${owner}/${repo}/settings${sub ? `/${sub}` : ''}` + url.search + url.hash : null
  }

  let path = `/${owner}/${repo}`
  if (section === 'pull' && rest[0]) {
    path += `/pull/${rest[0]}`
    if (rest[1] === 'files' || rest[1] === 'commits' || rest[1] === 'checks') path += `/${rest[1]}`
  } else if (section) {
    path += `/${section}${rest.length ? '/' + rest.join('/') : ''}`
  }
  return path + url.search + url.hash
}

/** Turns REST resource URLs (e.g. notification subjects) into app routes. */
export function appPathFromApiUrl(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null
  const m = apiUrl.match(/\/repos\/([^/]+)\/([^/]+)\/(pulls|issues|commits|actions\/runs|releases|check-suites)\/([^/?#]+)/)
  if (!m) {
    const repoOnly = apiUrl.match(/\/repos\/([^/]+)\/([^/?#]+)\/?$/)
    return repoOnly ? `/${repoOnly[1]}/${repoOnly[2]}` : null
  }
  const [, owner, repo, kind, id] = m
  switch (kind) {
    case 'pulls':
      return `/${owner}/${repo}/pull/${id}`
    case 'issues':
      return `/${owner}/${repo}/issues/${id}`
    case 'commits':
      return `/${owner}/${repo}/commit/${id}`
    case 'actions/runs':
      return `/${owner}/${repo}/actions/runs/${id}`
    default:
      return `/${owner}/${repo}`
  }
}

/** A ?next= target as a path on this origin. Resolving it catches what a prefix check misses: /\host and tab tricks become //host. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next?.startsWith('/')) return '/'
  const base = 'https://gh-ui.invalid'
  try {
    const url = new URL(next, base)
    // /..//host resolves to a same-origin //host, which still reads as another host once it's a path.
    return url.origin === base && !url.pathname.startsWith('//') ? url.pathname + url.search + url.hash : '/'
  } catch {
    return '/'
  }
}

export type LinkTarget = { app: string } | { external: string }

/**
 * Where a link leads, for opening it in a new tab: an in-app path, a URL for the system browser, or nowhere.
 * In-app links have absolute paths. In rendered markdown every href is the author's and means a page on GitHub, even an
 * absolute path: it only reaches the routes that GitHub URLs map onto, as a plain click on it does (useLinkInterceptor).
 */
export function linkTarget(href: string, host: string, routePath: string, rendered = false): LinkTarget | null {
  if (!rendered && href.startsWith('/') && !href.startsWith('//')) return { app: safeNextPath(href) }
  let url: string
  try {
    url = new URL(href, webBaseFor(host) + routePath).toString()
  } catch {
    return null
  }
  const app = appPathFromUrl(url, host)
  if (app) return { app: safeNextPath(app) }
  return /^(https?|mailto):/i.test(url) ? { external: url } : null
}

export function webUrl(host: string, path: string) {
  return `https://${host}${path.startsWith('/') ? path : '/' + path}`
}

/** Parses an `owner/repo` remote (https or ssh) into its parts. */
export function parseRemote(remote: string): { host: string; owner: string; repo: string } | null {
  const ssh = remote.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] }
  try {
    const url = new URL(remote)
    const [owner, repo] = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
    if (owner && repo) return { host: url.hostname, owner, repo }
  } catch {
    // not a URL
  }
  return null
}

/**
 * Rewrites each URL of a srcset ("a.png 1x, b.png 2x") with `map`, keeping descriptors; candidates `map` returns
 * null for stay as they are. Parses like the HTML spec: a URL runs to the next whitespace (trailing commas end
 * it), and its descriptors run to the next comma outside parentheses.
 */
export function mapSrcset(srcset: string, map: (url: string) => string | null): string {
  const out: string[] = []
  let i = 0
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i])) i++
    if (i >= srcset.length) break
    const start = i
    while (i < srcset.length && !/\s/.test(srcset[i])) i++
    let url = srcset.slice(start, i)
    let descriptor = ''
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '')
    } else {
      const from = i
      let depth = 0
      for (; i < srcset.length && (srcset[i] !== ',' || depth > 0); i++) {
        if (srcset[i] === '(') depth++
        else if (srcset[i] === ')') depth = Math.max(0, depth - 1)
      }
      descriptor = srcset.slice(from, i).trim()
      i++
    }
    const mapped = map(url) ?? url
    out.push(descriptor ? `${mapped} ${descriptor}` : mapped)
  }
  return out.join(', ')
}
