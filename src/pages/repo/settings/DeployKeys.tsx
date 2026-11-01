import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, FormControl, Label, Textarea, TextInput, useConfirm } from '@primer/react'
import { KeyIcon } from '@primer/octicons-react'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { keyLastUsed, sshFingerprint, sshKeyBlob } from '../../../lib/repoSettings'
import { Blankslate, ErrorBox, Loading, UserLink } from '../../../components/Bits'
import { allPages, SettingsCrumb, SettingsFlash, SettingsSubhead, useNavigateWithFlash } from './common'

type DeployKey = RestEndpointMethodTypes['repos']['listDeployKeys']['response']['data'][number]

const KEY_PLACEHOLDER =
  "Begins with 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519', 'sk-ecdsa-sha2-nistp256@openssh.com', or 'sk-ssh-ed25519@openssh.com'"

/** The API returns the key itself, not its fingerprint; github.com lists the SHA256 one. */
function Fingerprint({ value }: { value: string }) {
  const { data } = useQuery({ queryKey: ['ssh-fingerprint', value], staleTime: Infinity, queryFn: () => sshFingerprint(value) })
  return <code className="deploy-key-fingerprint">{data ?? ''}</code>
}

function addedOn(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** /settings/keys: github.com's deploy key list. */
export function DeployKeysSettings() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const navigateWithFlash = useNavigateWithFlash()
  const [error, setError] = useState<string | null>(null)
  const keys = useQuery({
    queryKey: [key, 'deploy-keys', owner, repo],
    queryFn: async () => allPages((p) => octokit.rest.repos.listDeployKeys({ owner, repo, ...p })),
  })
  const remove = useMutation({
    mutationFn: async (k: DeployKey) => octokit.rest.repos.deleteDeployKey({ owner, repo, key_id: k.id }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'deploy-keys', owner, repo] })
      navigateWithFlash(`/${owner}/${repo}/settings/keys`, 'Okay, you have successfully deleted that key.')
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <>
      <SettingsSubhead
        title="Deploy keys"
        actions={
          <Button as={Link} to={`/${owner}/${repo}/settings/keys/new`}>
            Add deploy key
          </Button>
        }
      />
      <SettingsFlash />
      {error && <div className="error-box mb-3">{error}</div>}
      {keys.isLoading ? (
        <Loading />
      ) : keys.error ? (
        <ErrorBox error={keys.error} title="Could not load deploy keys" />
      ) : keys.data!.length === 0 ? (
        <div className="Box">
          <Blankslate icon={<KeyIcon size={24} />} title="There are no deploy keys for this repository">
            Check out our{' '}
            <a href="https://docs.github.com/authentication/connecting-to-github-with-ssh/managing-deploy-keys" target="_blank" rel="noreferrer">
              guide on deploy keys
            </a>{' '}
            to learn more.
          </Blankslate>
        </div>
      ) : (
        <>
          <p className="settings-text">There {keys.data!.length === 1 ? 'is 1 deploy key' : `are ${keys.data!.length} deploy keys`} for this repository</p>
          <div className="Box">
            {keys.data!.map((k) => (
              <div key={k.id} className="Box-row deploy-key-row">
                <div className="deploy-key-badge">
                  <KeyIcon size={32} className={k.last_used && Date.now() - new Date(k.last_used).getTime() < 7 * 86_400_000 ? 'fg-success' : 'fg-muted'} />
                  <Label variant="secondary" size="small">
                    SSH
                  </Label>
                </div>
                <div className="flex-1 text-break">
                  <div>
                    <strong>{k.title}</strong>
                    {!k.read_only && (
                      <Label variant="attention" size="small" className="ml-2">
                        Read/write
                      </Label>
                    )}
                  </div>
                  <Fingerprint value={k.key} />
                  <div className="text-small fg-muted">
                    Added on {addedOn(k.created_at)}
                    {k.added_by && (
                      <>
                        {' '}
                        by <UserLink login={k.added_by} />
                      </>
                    )}
                  </div>
                  <div className="text-small fg-muted">
                    {keyLastUsed(k.last_used)} — {k.read_only ? 'Read-only' : 'Read/write'}
                  </div>
                </div>
                <Button
                  size="small"
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={async () => {
                    setError(null)
                    const ok = await confirm({
                      title: 'Are you sure you want to delete this SSH key?',
                      content: 'This action cannot be undone. This will permanently delete the SSH key and if you’d like to use it in the future, you will need to upload it again.',
                      confirmButtonContent: 'I understand, delete this SSH key',
                      confirmButtonType: 'danger',
                      width: 'large',
                    })
                    if (ok) remove.mutate(k)
                  }}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/** /settings/keys/new: "Deploy keys / Add new". */
export function NewDeployKeyPage() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const navigateWithFlash = useNavigateWithFlash()
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [write, setWrite] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = `/${owner}/${repo}/settings/keys`
  const looksWrong = !!value.trim() && !sshKeyBlob(value)

  const add = useMutation({
    mutationFn: async () => octokit.rest.repos.createDeployKey({ owner, repo, title: title.trim(), key: value.trim(), read_only: !write }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'deploy-keys', owner, repo] })
      navigateWithFlash(list, 'You have successfully added the key.')
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        add.mutate()
      }}
    >
      <SettingsSubhead title={<SettingsCrumb to={list} parent="Deploy keys" current="Add new" />} />
      <FormControl required className="settings-field">
        <FormControl.Label>Title</FormControl.Label>
        <TextInput block value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </FormControl>
      <FormControl required className="settings-field">
        <FormControl.Label>Key</FormControl.Label>
        <Textarea block rows={8} className="text-mono" placeholder={KEY_PLACEHOLDER} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
        {looksWrong && <FormControl.Validation variant="error">Key is invalid. You must supply a key in OpenSSH public key format.</FormControl.Validation>}
      </FormControl>
      <FormControl className="settings-field">
        <Checkbox checked={write} onChange={(e) => setWrite(e.target.checked)} />
        <FormControl.Label>Allow write access</FormControl.Label>
        <FormControl.Caption>Can this key be used to push to this repository? Deploy keys always have pull access.</FormControl.Caption>
      </FormControl>
      {error && <div className="error-box mb-3">{error}</div>}
      <Button type="submit" variant="primary" loading={add.isPending} disabled={add.isPending || !title.trim() || !value.trim() || looksWrong}>
        Add key
      </Button>
    </form>
  )
}
