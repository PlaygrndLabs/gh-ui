import { useState, type MouseEvent } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, Dialog, FormControl, IconButton, NavList, TextInput, useConfirm } from '@primer/react'
import { DeviceDesktopIcon, RepoIcon, PlusIcon, FileDirectoryIcon, TrashIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../lib/github'
import { native, type LocalRepo } from '../lib/platform'
import { toHttpsRemote } from '../lib/links'
import { readPref, writePref } from '../lib/storage'
import { useEffectOnChange } from '../lib/activity'
import { useWorkspaceRepos, workspacePath } from '../lib/workspace'
import { PublishDialog } from '../components/WorkspaceHeader'
import { Blankslate, ErrorBox, Loading } from '../components/Bits'
import { BranchesWorkspace } from './workspace/BranchesWorkspace'

/** A folder's own page, when it has no GitHub path: one with a GitHub repository lives at that repository's path. */
function LocalWorkspace({ id, section }: { id: string; section?: string }) {
  const { repos, isLoading } = useWorkspaceRepos()
  const { account } = useGitHub()
  const [publishing, setPublishing] = useState(false)
  const repo = repos.find((r) => r.local?.id === id)
  if (isLoading) return <Loading />
  if (!repo?.local) return <LocalShell />
  const path = workspacePath(repo, account.host)
  if (path && path !== `/local/${id}`) return <Navigate to={`${path}${section ? `/${section}` : ''}`} replace />
  if (section)
    return (
      <div className="container-lg">
        <Blankslate
          icon={<RepoIcon size={32} />}
          title={`Publish ${repo.name} to use ${section === 'pulls' ? 'pull requests' : 'Actions'}`}
          action={
            <Button variant="primary" onClick={() => setPublishing(true)}>
              Publish repository
            </Button>
          }
        >
          This repository lives only on your Mac, so Branches works as usual. Publish it to GitHub when you want to collaborate.
        </Blankslate>
        {publishing && <PublishDialog repo={repo} onClose={() => setPublishing(false)} />}
      </div>
    )
  return <BranchesWorkspace key={id} repo={repo} />
}

export function LocalReposPage() {
  const { id, section } = useParams()
  if (!native) {
    return (
      <div className="container-lg">
        <Blankslate icon={<DeviceDesktopIcon size={32} />} title="Local repositories need the desktop app">
          Cloning, committing and pushing local repositories works in the gh-ui desktop app (npm run electron:dev or a packaged build). Everything else works here in the browser.
        </Blankslate>
      </div>
    )
  }
  return id ? <LocalWorkspace id={id} section={section} /> : <LocalShell />
}

function useLocalRepos() {
  return useQuery({ queryKey: ['local-repos'], queryFn: () => native!.repos.list() })
}

function LocalShell() {
  const repos = useLocalRepos()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const cloneTarget = params.get('clone')
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    setError(null)
    const dir = await native!.pickDirectory('Choose a local git repository')
    if (!dir) return
    try {
      const repo = await native!.repos.add(dir)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
      navigate(`/local/${repo.id}`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const remove = async (repo: LocalRepo) => {
    if (await confirm({ title: `Remove ${repo.name}?`, content: 'It is removed from gh-ui only; the folder stays on disk.', confirmButtonContent: 'Remove' })) {
      await native!.repos.remove(repo.id)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
    }
  }

  return (
    <div className="container-lg">
      <div className="flex-center gap-2 mb-3">
        <h1 className="flex-1" style={{ fontSize: 20, margin: 0 }}>Folders on this Mac</h1>
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={PlusIcon} aria-label="Add repository" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              <ActionList.Item onSelect={() => setParams({ clone: '' })}>Clone repository…</ActionList.Item>
              <ActionList.Item onSelect={() => void add()}>Add existing repository…</ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
      {error && <ErrorBox error={new Error(error)} title="Could not add that folder" />}
      {repos.isLoading ? (
        <Loading />
      ) : repos.data?.length ? (
        <NavList aria-label="Local repositories">
          {repos.data.map((r) => (
            <NavList.Item key={r.id} as={Link} to={`/local/${r.id}`}>
              <NavList.LeadingVisual>
                <RepoIcon />
              </NavList.LeadingVisual>
              {r.name}
              <NavList.Description variant="block">{r.path}</NavList.Description>
              <NavList.TrailingAction
                icon={TrashIcon}
                label={`Remove ${r.name} from gh-ui`}
                onClick={(e: MouseEvent) => {
                  e.preventDefault()
                  void remove(r)
                }}
              />
            </NavList.Item>
          ))}
        </NavList>
      ) : (
        <Blankslate
          icon={<DeviceDesktopIcon size={32} />}
          title="Work on your code locally"
          action={
            <span className="flex-center gap-2" style={{ justifyContent: 'center' }}>
              <Button variant="primary" onClick={() => setParams({ clone: '' })}>
                Clone a repository
              </Button>
              <Button onClick={() => void add()}>Add an existing repository</Button>
            </span>
          }
        >
          Review and commit changes, switch branches and push.
        </Blankslate>
      )}
      {cloneTarget !== null && <CloneDialog initial={cloneTarget} onClose={() => setParams({})} onCloned={(r) => navigate(`/local/${r.id}`)} />}
    </div>
  )
}

export function CloneDialog({ initial, onClose, onCloned }: { initial: string; onClose(): void; onCloned(r: LocalRepo): void }) {
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const [filter, setFilter] = useState(initial)
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(() => readPref('cloneParent', ''))
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mine = useQuery({
    queryKey: [key, 'clone-repos'],
    queryFn: async () => (await octokit.rest.repos.listForAuthenticatedUser({ sort: 'pushed', per_page: 100 })).data,
  })
  useEffectOnChange(() => {
    if (initial && /^[\w.-]+\/[\w.-]+$/.test(initial)) {
      setUrl(`https://${account.host}/${initial}.git`)
      setName(initial.split('/')[1])
    }
  }, [initial, account.host])

  const clone = useMutation({
    mutationFn: async () => native!.repos.clone(url, parent, name, { token: account.token, host: account.host }),
    onSuccess: async (r) => {
      writePref('cloneParent', parent)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
      onCloned(r)
      onClose()
    },
    onError: (e) => setError(errorMessage(e)),
  })
  const sshUrl = !!toHttpsRemote(url)
  const shown = (mine.data ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase())).slice(0, 50)
  return (
    <Dialog
      title="Clone a repository"
      width="xlarge"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: clone.isPending ? 'Cloning…' : 'Clone', buttonType: 'primary', onClick: () => clone.mutate(), disabled: !url || !parent || !name || clone.isPending },
      ]}
    >
      <TextInput block placeholder="Filter your repositories" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
      <div className="Box mt-2" style={{ maxHeight: 240, overflow: 'auto' }}>
        {mine.isLoading ? (
          <Loading />
        ) : (
          shown.map((r) => (
            <div
              key={r.id}
              className={`Box-row hoverable ${url === r.clone_url ? 'selected' : ''}`}
              style={{ cursor: 'pointer', alignItems: 'center' }}
              onClick={() => {
                setUrl(r.clone_url)
                setName(r.name)
              }}
            >
              <RepoIcon /> <span className="flex-1">{r.full_name}</span>
            </div>
          ))
        )}
      </div>
      <FormControl className="mt-3">
        <FormControl.Label>Repository URL</FormControl.Label>
        <TextInput block value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" />
        {sshUrl && (
          <FormControl.Caption>
            SSH URLs use your SSH keys, not your sign-in.{' '}
            <button type="button" className="linkish" onClick={() => setUrl(toHttpsRemote(url)!)}>
              Use HTTPS with your sign-in
            </button>
          </FormControl.Caption>
        )}
      </FormControl>
      <FormControl className="mt-2">
        <FormControl.Label>Local path</FormControl.Label>
        <div className="flex gap-2 w-100">
          <TextInput className="flex-1" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Choose a parent folder" />
          <Button
            leadingVisual={FileDirectoryIcon}
            onClick={async () => {
              const dir = await native!.pickDirectory('Choose where to clone')
              if (dir) setParent(dir)
            }}
          >
            Choose…
          </Button>
        </div>
      </FormControl>
      <FormControl className="mt-2">
        <FormControl.Label>Folder name</FormControl.Label>
        <TextInput block value={name} onChange={(e) => setName(e.target.value)} />
      </FormControl>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
