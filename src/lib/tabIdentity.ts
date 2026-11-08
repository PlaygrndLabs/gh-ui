// What a repository tab shows so two with one name can be told apart: the server as its icon, and the owner or folder
// only when the icon and name alone would read the same.

import { displayRemote, parseRemote, remoteHost } from './links'
import { pathParts, repoKeyFromUrl, tabTitle, type Tab } from './tabs'
import type { WorkspaceRepo } from './workspace'

export type TabServer = 'github' | 'gitlab' | 'mac' | 'server'

export interface TabIdentity {
  /** Null for a page outside any repository, or a folder not loaded yet. */
  server: TabServer | null
  name: string
  branch: string | null
  tooltip: string
}

interface Place {
  tab: Tab
  key: string
  server: TabServer
  name: string
  owner: string | null
  folder: string | null
  address: string
}

const SERVERS: Record<string, TabServer> = { GitHub: 'github', GitLab: 'gitlab' }

function folderPlace(tab: Tab, key: string, repo: WorkspaceRepo, name: string): Place {
  const folder = repo.local!.path
  if (!repo.remote) return { tab, key, server: 'mac', name, owner: null, folder, address: folder }
  const parsed = parseRemote(repo.remote.url)
  const host = remoteHost(repo.remote.url)
  const address = parsed && host ? `${host}/${parsed.owner}/${parsed.repo}` : displayRemote(repo.remote.url)
  // In a GitLab subgroup, the owner is the whole path above the repository.
  const owner = parsed ? `${parsed.owner}/${parsed.repo}`.split('/').slice(0, -1).join('/') : null
  return { tab, key, server: SERVERS[repo.remote.provider] ?? 'server', name, owner, folder, address: `${address}\n${folder}` }
}

function placeOf(tab: Tab, repos: WorkspaceRepo[], accountHost: string): Place | null {
  const key = repoKeyFromUrl(tab.url)
  if (!key) return null
  const name = tabTitle({ url: tab.url, title: tab.title })
  if (key.startsWith('local/')) {
    const id = key.slice('local/'.length)
    const repo = repos.find((r) => r.local?.id === id)
    return repo ? folderPlace(tab, key, repo, name) : null
  }
  const [owner, repo] = pathParts(tab.url)
  return { tab, key, server: 'github', name, owner, folder: null, address: `${accountHost}/${owner}/${repo}` }
}

const parentFolder = (path: string) => path.split('/').filter(Boolean).slice(-2, -1)[0] ?? null

/** Each tab's identity, by tab id. Tabs that look alike are compared with each other, so closing one shortens the other. */
export function tabIdentities(tabs: Tab[], repos: WorkspaceRepo[], accountHost: string): Map<string, TabIdentity> {
  const places = tabs.map((tab) => placeOf(tab, repos, accountHost))
  const lookAlike = new Map<string, Place[]>()
  for (const place of places) {
    if (!place) continue
    const group = `${place.server}|${place.name.toLowerCase()}`
    lookAlike.set(group, [...(lookAlike.get(group) ?? []), place])
  }

  const owner = (p: Place) => p.owner?.toLowerCase() ?? ''
  const label = (place: Place) => {
    const others = lookAlike.get(`${place.server}|${place.name.toLowerCase()}`)!.filter((p) => p.key !== place.key)
    if (!others.length) return place.name
    const prefix = place.owner && others.some((p) => owner(p) !== owner(place)) ? `${place.owner}/` : ''
    // The same owner and name, so it's another clone: only where it sits on disk tells them apart.
    const parent = place.folder && others.some((p) => owner(p) === owner(place) && p.folder && parentFolder(p.folder) !== parentFolder(place.folder!)) ? parentFolder(place.folder) : null
    return `${prefix}${place.name}${parent ? ` (${parent})` : ''}`
  }

  return new Map(
    tabs.map((tab, i): [string, TabIdentity] => {
      const place = places[i]
      const branch = repoKeyFromUrl(tab.url) ? (tab.branch ?? null) : null
      if (!place) return [tab.id, { server: null, name: tabTitle({ url: tab.url, title: tab.title }), branch, tooltip: tabTitle(tab) }]
      const [first, ...rest] = place.address.split('\n')
      return [tab.id, { server: place.server, name: label(place), branch, tooltip: [branch ? `${first} · ${branch}` : first, ...rest].join('\n') }]
    }),
  )
}
