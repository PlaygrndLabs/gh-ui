import { describe, expect, it } from 'vitest'
import { tabIdentities } from './tabIdentity'
import type { Tab } from './tabs'
import { buildWorkspaceRepos } from './workspace'

const tab = (id: string, url: string, title: string | null = null, branch?: string): Tab => ({ id, url, title, branch })
const folder = (id: string, path: string, remoteUrl = '') => ({ repo: { id, path, name: path.split('/').pop()!, addedAt: Number(id.replace(/\D/g, '') || 0) }, remoteUrl })
const ids = (tabs: Tab[], folders: ReturnType<typeof folder>[] = []) => tabIdentities(tabs, buildWorkspaceRepos(folders, []), 'github.com')

describe('tabIdentities', () => {
  it('shows the server as the icon', () => {
    const r = ids(
      [tab('a', '/acme/web'), tab('b', '/local/f1', 'lab'), tab('c', '/local/f2', 'solo'), tab('d', '/local/f3', 'hub'), tab('e', '/settings')],
      [folder('f1', '/w/lab', 'git@gitlab.com:acme/lab.git'), folder('f2', '/w/solo'), folder('f3', '/w/hub', 'https://git.example.com/acme/hub.git')],
    )
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => r.get(id)!.server)).toEqual(['github', 'gitlab', 'mac', 'server', null])
  })

  it('keeps the short name when the server already tells two apart', () => {
    const r = ids([tab('a', '/local/f1', 'coopr', 'llm'), tab('b', '/acme/coopr', null, 'main')], [folder('f1', '/w/coopr', 'https://gitlab.com/acme/coopr.git')])
    expect(r.get('a')!.name).toBe('coopr')
    expect(r.get('b')!.name).toBe('coopr')
  })

  it('adds the owner when two on one server share a name, and drops it when one closes', () => {
    const both = ids([tab('a', '/acme/coopr'), tab('b', '/beta/Coopr')])
    expect(both.get('a')!.name).toBe('acme/coopr')
    expect(both.get('b')!.name).toBe('beta/Coopr')
    expect(ids([tab('a', '/acme/coopr')]).get('a')!.name).toBe('coopr')
  })

  it('adds the parent folder for two clones of one repository', () => {
    const url = 'https://gitlab.com/acme/coopr.git'
    const r = ids([tab('a', '/local/f1', 'coopr'), tab('b', '/local/f2', 'coopr')], [folder('f1', '/home/work/coopr', url), folder('f2', '/home/play/coopr', url)])
    expect(r.get('a')!.name).toBe('coopr (work)')
    expect(r.get('b')!.name).toBe('coopr (play)')
  })

  it('tells folders with no remote apart by where they sit', () => {
    const r = ids([tab('a', '/local/f1', 'notes'), tab('b', '/local/f2', 'notes')], [folder('f1', '/a/notes'), folder('f2', '/b/notes')])
    expect(r.get('a')!.name).toBe('notes (a)')
    expect(r.get('b')!.name).toBe('notes (b)')
  })

  it('uses the whole group path for GitLab subgroups', () => {
    const r = ids([tab('a', '/local/f1', 'coopr'), tab('b', '/local/f2', 'coopr')], [folder('f1', '/w/a/coopr', 'https://gitlab.com/acme/one/coopr.git'), folder('f2', '/w/b/coopr', 'git@gitlab.com:acme/two/coopr.git')])
    expect(r.get('a')).toMatchObject({ name: 'acme/one/coopr', tooltip: 'gitlab.com/acme/one/coopr\n/w/a/coopr' })
    expect(r.get('b')!.name).toBe('acme/two/coopr')
  })

  it('does not count pages of one repository as a clash', () => {
    const r = ids([tab('a', '/acme/web/pull/2'), tab('b', '/acme/web/issues')])
    expect(r.get('a')!.name).toBe('web')
  })

  it('gives the full address on hover, with no credentials', () => {
    const r = ids([tab('a', '/local/f1', 'coopr', 'llm'), tab('b', '/acme/web', null, 'main'), tab('c', '/local/f2', 'x')], [folder('f1', '/w/coopr', 'https://me:secret@gitlab.com/acme/coopr.git'), folder('f2', '/w/x')])
    expect(r.get('a')!.tooltip).toBe('gitlab.com/acme/coopr · llm\n/w/coopr')
    expect(r.get('b')!.tooltip).toBe('github.com/acme/web · main')
    expect(r.get('c')!.tooltip).toBe('/w/x')
  })

  it('splits off the branch so it can be shortened first', () => {
    const r = ids([tab('a', '/acme/web', null, 'main'), tab('b', '/settings', null, 'main')])
    expect(r.get('a')).toMatchObject({ name: 'web', branch: 'main' })
    expect(r.get('b')).toMatchObject({ name: 'Settings', branch: null })
  })

  it('waits for a folder it does not know yet', () => {
    expect(ids([tab('a', '/local/f9', 'coopr', 'main')]).get('a')).toMatchObject({ server: null, name: 'coopr', branch: 'main', tooltip: 'coopr - main' })
  })
})
