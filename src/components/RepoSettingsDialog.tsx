import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, FormControl, IconButton, TextInput, useConfirm } from '@primer/react'
import { PencilIcon, TrashIcon } from '@primer/octicons-react'
import { errorMessage, useGitHub } from '../lib/github'
import { primaryRemote, type GitRemote } from '../lib/git'
import { displayRemote, isValidRemoteUrl, remoteProvider, sameRemote } from '../lib/links'
import { useLocalRepo } from '../lib/useLocalRepo'
import type { WorkspaceRepo } from '../lib/workspace'

const NAME_RE = /^[A-Za-z0-9][\w.-]*$/
const URL_HINT = 'Use an https:// address, ssh://, or git@host:path.'

/** One folder's settings, as in GitHub Desktop: where it syncs, and who its commits are by. */
export function RepoSettingsDialog({ repo, onClose }: { repo: WorkspaceRepo; onClose(): void }) {
  const { account } = useGitHub()
  const local = useLocalRepo(repo.local)
  const git = local.git!
  const qc = useQueryClient()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const id = repo.local!.id

  const remotes = useQuery({ queryKey: ['local-remotes', id], queryFn: () => git.remotes() })
  const identity = useQuery({ queryKey: ['local-identity', id], queryFn: async () => ({ name: await git.identity('user.name'), email: await git.identity('user.email') }) })

  const [editing, setEditing] = useState<{ name: string; url: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [userName, setUserName] = useState('')
  const [email, setEmail] = useState('')
  useEffect(() => {
    if (identity.data) {
      setUserName(identity.data.name)
      setEmail(identity.data.email)
    }
  }, [identity.data])

  const change = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => {
      const before = repo.remote?.url ?? ''
      await fn()
      const after = primaryRemote(await git.remotes())?.url ?? ''
      await Promise.all([qc.invalidateQueries({ queryKey: ['local-remotes', id] }), qc.invalidateQueries({ queryKey: ['workspace-folders'] })])
      local.refresh()
      // A page at a GitHub address no longer describes a folder that has moved; the folder's own address sorts it out.
      if (!sameRemote(before, after) && !pathname.startsWith('/local/') && before !== after) navigate(`/local/${id}`, { replace: true })
    },
    onSuccess: () => {
      setEditing(null)
      setNewName('')
      setNewUrl('')
    },
  })
  const saveIdentity = useMutation({
    mutationFn: async () => {
      await git.setIdentity('user.name', userName.trim())
      await git.setIdentity('user.email', email.trim())
      await qc.invalidateQueries({ queryKey: ['local-identity', id] })
    },
  })

  const remove = async (r: GitRemote) => {
    const ok = await confirm({
      title: `Remove ${r.name}?`,
      content: `This folder stops syncing with ${displayRemote(r.url)}. The repository there and your files here aren’t touched.`,
      confirmButtonContent: 'Remove remote',
      confirmButtonType: 'danger',
    })
    if (ok) change.mutate(() => git.removeRemote(r.name))
  }

  const list = remotes.data ?? []
  const nameTaken = list.some((r) => r.name === newName.trim())
  const canAdd = NAME_RE.test(newName.trim()) && !nameTaken && isValidRemoteUrl(newUrl.trim()) && !change.isPending
  const identityChanged = !!identity.data && (identity.data.name !== userName.trim() || identity.data.email !== email.trim())
  const primary = primaryRemote(list)

  return (
    <Dialog title="Repository settings" subtitle={repo.local!.path} width="xlarge" onClose={onClose} footerButtons={[{ content: 'Done', buttonType: 'primary', onClick: onClose }]}>
      <section className="repo-settings-section" aria-label="Remotes">
        <h3 className="repo-settings-title">Remotes</h3>
        {remotes.error ? <div className="error-box">{errorMessage(remotes.error)}</div> : null}
        {remotes.data && !list.length && <p className="ws-note">No remote yet.</p>}
        {list.map((r) =>
          editing?.name === r.name ? (
            <form
              key={r.name}
              className="repo-remote"
              onSubmit={(e) => {
                e.preventDefault()
                if (isValidRemoteUrl(editing.url.trim())) change.mutate(() => git.setRemoteUrl(r.name, editing.url.trim()))
              }}
            >
              <span className="repo-remote-name text-mono text-bold">{r.name}</span>
              <TextInput className="repo-remote-input" autoFocus aria-label={`Address of ${r.name}`} value={editing.url} onChange={(e) => setEditing({ name: r.name, url: e.target.value })} />
              <Button size="small" type="submit" variant="primary" disabled={!isValidRemoteUrl(editing.url.trim()) || change.isPending}>
                Save
              </Button>
              <Button size="small" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div key={r.name} className="repo-remote">
              <span className="repo-remote-name text-mono text-bold">{r.name}</span>
              <span className="ws-tag">{remoteProvider(r.url, account.host)}</span>
              <span className="repo-remote-url text-mono" title={displayRemote(r.url)}>
                {displayRemote(r.url)}
              </span>
              <IconButton size="small" variant="invisible" icon={PencilIcon} aria-label={`Change address of ${r.name}`} onClick={() => setEditing({ name: r.name, url: r.url })} />
              <IconButton size="small" variant="invisible" icon={TrashIcon} aria-label={`Remove ${r.name}`} onClick={() => void remove(r)} />
            </div>
          ),
        )}
        <form
          className="repo-remote repo-remote-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (canAdd) change.mutate(() => git.addRemote(newName.trim(), newUrl.trim()))
          }}
        >
          <TextInput className="repo-remote-name-input" aria-label="New remote name" placeholder={list.length ? 'name' : 'origin'} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <TextInput className="repo-remote-input" aria-label="New remote address" placeholder="https://gitlab.com/you/repo.git" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
          <Button size="small" type="submit" disabled={!canAdd}>
            Add remote
          </Button>
        </form>
        {newUrl.trim() && !isValidRemoteUrl(newUrl.trim()) && <p className="ws-note">{URL_HINT}</p>}
        {nameTaken && <p className="ws-note">This folder already has a remote called {newName.trim()}.</p>}
        {change.error ? <div className="error-box mt-2">{errorMessage(change.error)}</div> : null}
        <p className="ws-note repo-settings-note">
          {primary
            ? `Syncs with ${primary.name} on ${remoteProvider(primary.url, account.host)}. A folder with a remote is never offered Publish to GitHub.`
            : 'With no remote, this folder stays on your Mac until you add one or choose Publish repository.'}
        </p>
      </section>

      <section className="repo-settings-section" aria-label="Commit identity">
        <h3 className="repo-settings-title">Commit identity</h3>
        <p className="ws-note">For this repository only. Leave a field empty to use your global Git setting.</p>
        <div className="repo-identity">
          <FormControl>
            <FormControl.Label>Name</FormControl.Label>
            <TextInput block value={userName} onChange={(e) => setUserName(e.target.value)} />
          </FormControl>
          <FormControl>
            <FormControl.Label>Email</FormControl.Label>
            <TextInput block value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormControl>
        </div>
        <Button size="small" className="mt-2" disabled={!identityChanged || saveIdentity.isPending} onClick={() => saveIdentity.mutate()}>
          Save identity
        </Button>
        {saveIdentity.error ? <div className="error-box mt-2">{errorMessage(saveIdentity.error)}</div> : null}
      </section>
    </Dialog>
  )
}
