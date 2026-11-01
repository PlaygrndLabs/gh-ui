import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, FormControl, IconButton, RelativeTime, Textarea, TextInput, UnderlineNav, useConfirm } from '@primer/react'
import { LockIcon, PencilIcon, PlusIcon, TrashIcon } from '@primer/octicons-react'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { encryptSecret } from '../../../lib/sealedBox'
import { actionsNameError, normalizeActionsName } from '../../../lib/repoSettings'
import { ErrorBox, Loading } from '../../../components/Bits'
import { SettingsCrumb, SettingsFlash, SettingsSubhead, useNavigateWithFlash } from './common'

type Kind = 'secret' | 'variable'

function useSecrets() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'actions-secrets', owner, repo],
    queryFn: async () => (await octokit.rest.actions.listRepoSecrets({ owner, repo, per_page: 100 })).data.secrets,
  })
}

function useVariables() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'actions-variables', owner, repo],
    // The variables list pages at most 30 at a time (a repository can hold far more), so read every page.
    queryFn: async () => {
      const all: RestEndpointMethodTypes['actions']['listRepoVariables']['response']['data']['variables'] = []
      for (let page = 1; ; page++) {
        const { data } = await octokit.rest.actions.listRepoVariables({ owner, repo, per_page: 30, page })
        all.push(...data.variables)
        if (data.variables.length < 30 || all.length >= data.total_count) return all
      }
    },
  })
}

/** /settings/secrets/actions and /settings/variables/actions: the page header and its Secrets / Variables tabs. */
export function SecretsSettings() {
  const { owner, repo } = useRepo()
  const { pathname } = useLocation()
  const tab: Kind = pathname.includes('/settings/variables/') ? 'variable' : 'secret'
  const base = `/${owner}/${repo}/settings`
  return (
    <>
      <SettingsSubhead title="Actions secrets and variables" />
      <SettingsFlash />
      <p className="settings-text">
        Secrets and variables allow you to manage reusable configuration data. Secrets are <strong>encrypted</strong> and are used for sensitive data.{' '}
        <a href="https://docs.github.com/actions/security-guides/using-secrets-in-github-actions" target="_blank" rel="noreferrer">
          Learn more about encrypted secrets
        </a>
        . Variables are shown as plain text and are used for <strong>non-sensitive</strong> data.{' '}
        <a href="https://docs.github.com/actions/learn-github-actions/variables" target="_blank" rel="noreferrer">
          Learn more about variables
        </a>
        .
      </p>
      <p className="settings-text">
        Anyone with collaborator access to this repository can use these secrets and variables for actions. They are not passed to workflows that are triggered by a pull request from a fork.
      </p>
      <UnderlineNav aria-label="Secrets and variables" className="actions-config-tabs">
        <UnderlineNav.Item as={Link} to={`${base}/secrets/actions`} aria-current={tab === 'secret' ? 'page' : undefined}>
          Secrets
        </UnderlineNav.Item>
        <UnderlineNav.Item as={Link} to={`${base}/variables/actions`} aria-current={tab === 'variable' ? 'page' : undefined}>
          Variables
        </UnderlineNav.Item>
      </UnderlineNav>
      {tab === 'secret' ? <SecretsTab /> : <VariablesTab />}
    </>
  )
}

function SectionHeader({ title, action, to }: { title: string; action: string; to: string }) {
  return (
    <div className="actions-config-header">
      <h3>{title}</h3>
      <Button as={Link} to={to} variant="primary" leadingVisual={PlusIcon}>
        {action}
      </Button>
    </div>
  )
}

function SecretsTab() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const secrets = useSecrets()
  const navigateWithFlash = useNavigateWithFlash()
  const [error, setError] = useState<string | null>(null)
  const base = `/${owner}/${repo}/settings/secrets/actions`
  const remove = useMutation({
    mutationFn: async (name: string) => octokit.rest.actions.deleteRepoSecret({ owner, repo, secret_name: name }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'actions-secrets', owner, repo] })
      navigateWithFlash(base, 'Repository secret removed.')
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <>
      <SectionHeader title="Repository secrets" action="New repository secret" to={`${base}/new`} />
      {error && <div className="error-box mb-3">{error}</div>}
      {secrets.isLoading ? (
        <Loading />
      ) : secrets.error ? (
        <ErrorBox error={secrets.error} title="Could not load secrets" />
      ) : (
        <div className="Box actions-config-table">
          <div className="Box-header compact actions-config-row secrets">
            <span>Name</span>
            <span>Last updated</span>
            <span />
          </div>
          {secrets.data!.length === 0 ? (
            <div className="Box-row actions-config-empty">This repository has no secrets.</div>
          ) : (
            secrets.data!.map((s) => (
              <div key={s.name} className="Box-row actions-config-row secrets">
                <span className="flex-center gap-2 text-break">
                  <LockIcon className="fg-muted" />
                  <span className="text-mono">{s.name}</span>
                </span>
                <span className="fg-muted text-small">
                  <RelativeTime date={new Date(s.updated_at)} />
                </span>
                <span className="actions-config-actions">
                  <IconButton as={Link} to={`${base}/${encodeURIComponent(s.name)}`} icon={PencilIcon} size="small" variant="invisible" aria-label={`Update ${s.name}`} />
                  <IconButton
                    icon={TrashIcon}
                    size="small"
                    variant="invisible"
                    aria-label={`Remove ${s.name}`}
                    disabled={remove.isPending}
                    onClick={async () => {
                      setError(null)
                      const ok = await confirm({
                        title: 'Remove secret',
                        content: (
                          <>
                            Are you sure you want to delete <strong>{s.name}</strong>?
                          </>
                        ),
                        confirmButtonContent: 'Yes, remove this secret from the repository',
                        confirmButtonType: 'danger',
                      })
                      if (ok) remove.mutate(s.name)
                    }}
                  />
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  )
}

function VariablesTab() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const variables = useVariables()
  const navigateWithFlash = useNavigateWithFlash()
  const [error, setError] = useState<string | null>(null)
  const base = `/${owner}/${repo}/settings/variables/actions`
  const remove = useMutation({
    mutationFn: async (name: string) => octokit.rest.actions.deleteRepoVariable({ owner, repo, name }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'actions-variables', owner, repo] })
      navigateWithFlash(base, 'Repository variable deleted.')
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <>
      <SectionHeader title="Repository variables" action="New repository variable" to={`${base}/new`} />
      {error && <div className="error-box mb-3">{error}</div>}
      {variables.isLoading ? (
        <Loading />
      ) : variables.error ? (
        <ErrorBox error={variables.error} title="Could not load variables" />
      ) : (
        <div className="Box actions-config-table">
          <div className="Box-header compact actions-config-row variables">
            <span>Name</span>
            <span>Value</span>
            <span>Last updated</span>
            <span />
          </div>
          {variables.data!.length === 0 ? (
            <div className="Box-row actions-config-empty">This repository has no variables.</div>
          ) : (
            variables.data!.map((v) => (
              <div key={v.name} className="Box-row actions-config-row variables">
                <span className="text-mono text-break">{v.name}</span>
                <span className="text-mono text-truncate" title={v.value}>
                  {v.value}
                </span>
                <span className="fg-muted text-small">
                  <RelativeTime date={new Date(v.updated_at)} />
                </span>
                <span className="actions-config-actions">
                  <IconButton as={Link} to={`${base}/${encodeURIComponent(v.name)}`} icon={PencilIcon} size="small" variant="invisible" aria-label={`Edit ${v.name}`} />
                  <IconButton
                    icon={TrashIcon}
                    size="small"
                    variant="invisible"
                    aria-label={`Delete ${v.name}`}
                    disabled={remove.isPending}
                    onClick={async () => {
                      setError(null)
                      const ok = await confirm({
                        title: 'Delete variable',
                        content: (
                          <>
                            Are you sure you want to delete <strong>{v.name}</strong>?
                          </>
                        ),
                        confirmButtonContent: 'Yes, delete this variable',
                        confirmButtonType: 'danger',
                      })
                      if (ok) remove.mutate(v.name)
                    }}
                  />
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  )
}

/**
 * /settings/secrets/actions/new and /settings/secrets/actions/:name. The value is sealed with the repository's Actions
 * public key in the browser (libsodium sealed box), so GitHub only ever receives ciphertext.
 */
export function SecretFormPage() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const navigateWithFlash = useNavigateWithFlash()
  const { name: param } = useParams()
  const editing = param && param !== 'new' ? param : null
  const [name, setName] = useState(editing ?? '')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const list = `/${owner}/${repo}/settings/secrets/actions`
  const nameError = editing ? null : actionsNameError(name, 'secret')
  const existing = useSecrets()
  const taken = !editing && !!existing.data?.some((s) => s.name === normalizeActionsName(name))

  const save = useMutation({
    mutationFn: async () => {
      const { data: pk } = await octokit.rest.actions.getRepoPublicKey({ owner, repo })
      await octokit.rest.actions.createOrUpdateRepoSecret({ owner, repo, secret_name: editing ?? normalizeActionsName(name), encrypted_value: encryptSecret(value, pk.key), key_id: pk.key_id })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'actions-secrets', owner, repo] })
      navigateWithFlash(list, editing ? 'Repository secret updated.' : 'Repository secret added.')
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <SettingsSubhead title={<SettingsCrumb to={list} parent="Actions secrets" current={editing ? 'Update secret' : 'New secret'} />} />
      <FormControl required={!editing} className="settings-field actions-config-name" disabled={!!editing}>
        <FormControl.Label>Name</FormControl.Label>
        <TextInput block placeholder="YOUR_SECRET_NAME" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!editing} readOnly={!!editing} />
        {nameError && <FormControl.Validation variant="error">{nameError}</FormControl.Validation>}
        {taken && <FormControl.Validation variant="error">Secret {normalizeActionsName(name)} already exists. Update it from the secrets list instead.</FormControl.Validation>}
      </FormControl>
      <FormControl required className="settings-field">
        <FormControl.Label>{editing ? 'Value' : 'Secret'}</FormControl.Label>
        <Textarea block rows={8} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoFocus={!!editing} autoComplete="off" />
      </FormControl>
      {error && <div className="error-box mb-3">{error}</div>}
      <Button type="submit" variant="primary" loading={save.isPending} disabled={save.isPending || !name.trim() || !value || !!nameError || taken}>
        {editing ? 'Update secret' : 'Add secret'}
      </Button>
    </form>
  )
}

/** /settings/variables/actions/new and /settings/variables/actions/:name. */
export function VariableFormPage() {
  const { name: param } = useParams()
  const editing = param && param !== 'new' ? param : null
  const variables = useVariables()
  if (variables.isLoading) return <Loading />
  if (variables.error) return <ErrorBox error={variables.error} title="Could not load variables" />
  const current = editing ? variables.data!.find((v) => v.name === editing) : undefined
  if (editing && !current) return <ErrorBox error={new Error(`Variable ${editing} no longer exists.`)} title="Variable not found" />
  return <VariableForm key={editing ?? 'new'} original={current} others={variables.data!.map((v) => v.name).filter((n) => n !== current?.name)} />
}

function VariableForm({ original, others }: { original?: { name: string; value: string }; others: string[] }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const navigateWithFlash = useNavigateWithFlash()
  const [name, setName] = useState(original?.name ?? '')
  const [value, setValue] = useState(original?.value ?? '')
  const [error, setError] = useState<string | null>(null)
  const list = `/${owner}/${repo}/settings/variables/actions`
  const nameError = actionsNameError(name, 'variable')
  const taken = others.includes(normalizeActionsName(name))

  const save = useMutation({
    mutationFn: async () => {
      const next = normalizeActionsName(name)
      if (original)
        // The path names the variable and the body may rename it, so the URL is built here: Octokit would take `name` for the path.
        await octokit.request(`PATCH /repos/${owner}/${repo}/actions/variables/${encodeURIComponent(original.name)}`, { name: next, value })
      else await octokit.rest.actions.createRepoVariable({ owner, repo, name: next, value })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'actions-variables', owner, repo] })
      navigateWithFlash(list, original ? 'Repository variable updated.' : 'Repository variable added.')
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <SettingsSubhead title={<SettingsCrumb to={list} parent="Actions variables" current={original ? 'Update variable' : 'New variable'} />} />
      <FormControl required className="settings-field actions-config-name">
        <FormControl.Label>Name</FormControl.Label>
        <TextInput block placeholder="YOUR_VARIABLE_NAME" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!original} />
        {nameError && <FormControl.Validation variant="error">{nameError}</FormControl.Validation>}
        {taken && <FormControl.Validation variant="error">Variable {normalizeActionsName(name)} already exists.</FormControl.Validation>}
      </FormControl>
      <FormControl required className="settings-field">
        <FormControl.Label>Value</FormControl.Label>
        <Textarea block rows={8} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoFocus={!!original} />
      </FormControl>
      {error && <div className="error-box mb-3">{error}</div>}
      <Button type="submit" variant="primary" loading={save.isPending} disabled={save.isPending || !name.trim() || !value || !!nameError || taken}>
        {original ? 'Update variable' : 'Add variable'}
      </Button>
    </form>
  )
}
