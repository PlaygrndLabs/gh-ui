import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Avatar, Button, Dialog, FormControl, IconButton, Radio, RadioGroup, RelativeTime, Spinner, TextInput, useConfirm } from '@primer/react'
import { LockIcon, PeopleIcon, RepoIcon, SearchIcon, TrashIcon, TriangleDownIcon, XIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { REPO_ROLES, collaboratorPermission, directAccessSummary, roleId, roleLabel, type RepoRole } from '../../../lib/repoSettings'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { SettingsSubhead } from './common'

/** One row of the access list: a direct collaborator or a pending invitation. */
interface Member {
  kind: 'collaborator' | 'invitation'
  id: number
  login: string
  avatarUrl: string
  role: RepoRole
  roleName: string
  invitedAt?: string
}

function useAccessList() {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'repo-access', owner, repo],
    queryFn: async () => {
      const [collaborators, invitations] = await Promise.all([
        octokit.paginate(octokit.rest.repos.listCollaborators, { owner, repo, affiliation: 'direct', per_page: 100 }),
        octokit.paginate(octokit.rest.repos.listInvitations, { owner, repo, per_page: 100 }),
      ])
      const members: Member[] = [
        // A personal repository's owner is listed as an admin collaborator; github.com leaves them out.
        ...collaborators
          .filter((c) => !(data.owner.type === 'User' && c.login.toLowerCase() === owner.toLowerCase()))
          .map((c) => ({ kind: 'collaborator' as const, id: c.id, login: c.login, avatarUrl: c.avatar_url, role: roleId(c.role_name), roleName: c.role_name })),
        ...invitations
          .filter((i) => i.invitee)
          .map((i) => ({ kind: 'invitation' as const, id: i.id, login: i.invitee!.login, avatarUrl: i.invitee!.avatar_url, role: roleId(i.permissions), roleName: i.permissions, invitedAt: i.created_at })),
      ]
      return members.sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }))
    },
  })
}

/** /settings/access: github.com's "Who has access" summary and the "Manage access" list. */
export function CollaboratorsSettings() {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const list = useAccessList()
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const isOrg = data.owner.type === 'Organization'
  const members = list.data ?? []
  const collaborators = members.filter((m) => m.kind === 'collaborator')
  const invitations = members.filter((m) => m.kind === 'invitation')
  const visible = members.filter((m) => m.login.toLowerCase().includes(filter.trim().toLowerCase()))
  const visibility = data.visibility ?? (data.private ? 'private' : 'public')
  const refresh = () => qc.invalidateQueries({ queryKey: [key, 'repo-access', owner, repo] })

  const remove = useMutation({
    mutationFn: async (m: Member) =>
      m.kind === 'collaborator' ? octokit.rest.repos.removeCollaborator({ owner, repo, username: m.login }) : octokit.rest.repos.deleteInvitation({ owner, repo, invitation_id: m.id }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  })
  const changeRole = useMutation({
    mutationFn: async ({ m, role }: { m: Member; role: RepoRole }) =>
      m.kind === 'collaborator'
        ? octokit.rest.repos.addCollaborator({ owner, repo, username: m.login, permission: collaboratorPermission(role) })
        : octokit.rest.repos.updateInvitation({ owner, repo, invitation_id: m.id, permissions: role }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  })

  const askRemove = async (m: Member) => {
    setError(null)
    const ok = await confirm({
      title: m.kind === 'invitation' ? `Cancel ${m.login}’s invitation?` : `Remove ${m.login} from ${repo}?`,
      content: m.kind === 'invitation' ? `${m.login} will no longer be able to accept the invitation to ${owner}/${repo}.` : `${m.login} will lose access to ${owner}/${repo}. You can invite them again later.`,
      confirmButtonContent: m.kind === 'invitation' ? 'Cancel invitation' : `Remove ${m.login} from this repository`,
      confirmButtonType: 'danger',
      width: 'large',
    })
    if (ok) remove.mutate(m)
  }
  const askRole = async (m: Member, role: RepoRole) => {
    if (role === m.role) return
    setError(null)
    const ok = await confirm({
      title: `Change ${m.login}’s role?`,
      content: `${m.login} will have the ${roleLabel(role)} role on ${owner}/${repo} instead of ${roleLabel(m.roleName)}.`,
      confirmButtonContent: 'Change role',
      width: 'large',
    })
    if (ok) changeRole.mutate({ m, role })
  }

  const addButton = (
    <Button variant="primary" onClick={() => setAdding(true)}>
      Add people
    </Button>
  )

  return (
    <>
      <SettingsSubhead title="Who has access" />
      <div className="access-summary">
        <div className="Box access-card">
          <h3 className="access-card-heading">{visibility} repository</h3>
          <div className="access-card-body">
            {visibility === 'public' ? <RepoIcon size={24} className="fg-muted shrink-0" /> : <LockIcon size={24} className="fg-muted shrink-0" />}
            <span>{visibility === 'public' ? 'This repository is public and visible to anyone.' : visibility === 'internal' ? 'Enterprise members can view this repository.' : 'Only those with access to this repository can view it.'}</span>
          </div>
          <Link to={`/${owner}/${repo}/settings#danger-zone`} className="access-card-link">
            Manage
          </Link>
        </div>
        <div className="Box access-card">
          <h3 className="access-card-heading">Direct access</h3>
          <div className="access-card-body">
            <PeopleIcon size={24} className="fg-muted shrink-0" />
            <span>{list.data ? directAccessSummary(collaborators.length, invitations.length, !isOrg) : 'Loading…'}</span>
          </div>
        </div>
      </div>

      <SettingsSubhead title="Manage access" spacious actions={members.length > 0 ? addButton : undefined} />
      {error && <div className="error-box mb-3">{error}</div>}
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} title="Could not load collaborators" />
      ) : members.length === 0 ? (
        <div className="Box">
          <Blankslate icon={<PeopleIcon size={24} />} title="You haven't invited any collaborators yet" action={addButton} />
        </div>
      ) : (
        <div className="Box">
          <div className="Box-header access-list-header">
            <TextInput leadingVisual={SearchIcon} placeholder="Find a collaborator…" aria-label="Find a collaborator" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {visible.length === 0 && <div className="Box-row fg-muted">No collaborators match “{filter}”.</div>}
          {visible.map((m) => (
            <div key={`${m.kind}-${m.id}`} className="Box-row access-row">
              <Avatar src={m.avatarUrl} size={32} alt={`@${m.login}`} />
              <div className="flex-1">
                <Link to={`/${m.login}`} className="text-bold fg-default">
                  {m.login}
                </Link>
                <div className="text-small fg-muted">
                  {m.kind === 'invitation' ? (
                    <>
                      Pending Invite{m.invitedAt && <> · invited <RelativeTime date={new Date(m.invitedAt)} /></>}
                    </>
                  ) : isOrg ? (
                    roleLabel(m.roleName)
                  ) : (
                    'Collaborator'
                  )}
                </div>
              </div>
              {isOrg && (
                <ActionMenu>
                  <ActionMenu.Anchor>
                    <Button size="small" trailingVisual={TriangleDownIcon} disabled={changeRole.isPending}>
                      Role: {roleLabel(m.roleName)}
                    </Button>
                  </ActionMenu.Anchor>
                  <ActionMenu.Overlay width="medium" align="end">
                    <ActionList selectionVariant="single">
                      {REPO_ROLES.map((r) => (
                        <ActionList.Item key={r.id} selected={r.id === m.role} onSelect={() => void askRole(m, r.id)}>
                          {r.label}
                          <ActionList.Description variant="block">{r.description}</ActionList.Description>
                        </ActionList.Item>
                      ))}
                    </ActionList>
                  </ActionMenu.Overlay>
                </ActionMenu>
              )}
              <IconButton
                icon={TrashIcon}
                variant="invisible"
                aria-label={m.kind === 'invitation' ? `Cancel ${m.login}’s invitation` : `Remove ${m.login}`}
                description={m.kind === 'invitation' ? 'Cancel invite' : 'Remove'}
                disabled={remove.isPending}
                onClick={() => void askRemove(m)}
              />
            </div>
          ))}
        </div>
      )}
      {adding && <AddPeopleDialog existing={members.map((m) => m.login.toLowerCase())} onClose={() => setAdding(false)} />}
    </>
  )
}

interface Candidate {
  login: string
  avatarUrl: string
}

/**
 * github.com's "Add people" dialog: search users, pick one, choose a role (organization repositories only; personal
 * repositories have a single collaborator role), then send the invitation.
 */
function AddPeopleDialog({ existing, onClose }: { existing: string[]; onClose(): void }) {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const isOrg = data.owner.type === 'Organization'
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<Candidate | null>(null)
  const [role, setRole] = useState<RepoRole>('write')
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const results = useQuery({
    queryKey: [key, 'user-search', debounced],
    enabled: !!debounced && !selected,
    staleTime: 60_000,
    queryFn: async () => (await octokit.rest.search.users({ q: `${debounced} in:login in:name in:email`, per_page: 8 })).data.items.map((u) => ({ login: u.login, avatarUrl: u.avatar_url })),
  })

  const invite = useMutation({
    mutationFn: async () => octokit.rest.repos.addCollaborator({ owner, repo, username: selected!.login, ...(isOrg ? { permission: collaboratorPermission(role) } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [key, 'repo-access', owner, repo] })
      onClose()
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <Dialog
      title={isOrg ? `Add people to ${repo}` : `Add a collaborator to ${repo}`}
      onClose={onClose}
      initialFocusRef={searchRef}
      width="large"
      renderFooter={() => (
        <Dialog.Footer>
          <Button block variant="primary" disabled={!selected || invite.isPending} onClick={() => invite.mutate()}>
            {selected ? `Add ${selected.login} to ${repo}` : 'Select a collaborator above'}
          </Button>
        </Dialog.Footer>
      )}
    >
      {selected ? (
        <div className="add-people-selected">
          <Avatar src={selected.avatarUrl} size={32} alt="" />
          <span className="text-bold flex-1">{selected.login}</span>
          <IconButton icon={XIcon} variant="invisible" size="small" aria-label={`Remove ${selected.login}`} onClick={() => setSelected(null)} />
        </div>
      ) : (
        <>
          <TextInput
            ref={searchRef}
            block
            leadingVisual={SearchIcon}
            trailingVisual={results.isFetching ? <Spinner size="small" /> : undefined}
            placeholder="Search by username, full name, or email"
            aria-label="Search by username, full name, or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {debounced && results.data && (
            <ActionList className="add-people-results" aria-label="Matching people">
              {results.data.length === 0 && <ActionList.Item disabled>No matches</ActionList.Item>}
              {results.data.map((u) => {
                const already = existing.includes(u.login.toLowerCase()) || u.login.toLowerCase() === owner.toLowerCase()
                return (
                  <ActionList.Item key={u.login} disabled={already} onSelect={() => setSelected(u)}>
                    <ActionList.LeadingVisual>
                      <Avatar src={u.avatarUrl} size={20} />
                    </ActionList.LeadingVisual>
                    {u.login}
                    {already && <ActionList.Description>{u.login.toLowerCase() === owner.toLowerCase() ? 'Owner' : 'Already has access'}</ActionList.Description>}
                  </ActionList.Item>
                )
              })}
            </ActionList>
          )}
          {results.error && <div className="error-box mt-2">{errorMessage(results.error)}</div>}
        </>
      )}
      {isOrg && selected && (
        <RadioGroup name="collaborator-role" className="mt-3" onChange={(v) => v && setRole(v as RepoRole)}>
          <RadioGroup.Label>Choose a role</RadioGroup.Label>
          {REPO_ROLES.map((r) => (
            <FormControl key={r.id}>
              <Radio value={r.id} checked={role === r.id} onChange={() => setRole(r.id)} />
              <FormControl.Label>{r.label}</FormControl.Label>
              <FormControl.Caption>{r.description}</FormControl.Caption>
            </FormControl>
          ))}
        </RadioGroup>
      )}
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
