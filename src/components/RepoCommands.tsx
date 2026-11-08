import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, Banner, Button, Dialog, FormControl, TextInput, useConfirm } from '@primer/react'
import { copyText, plural } from '../lib/format'
import { isUnmerged, type BranchState } from '../lib/git'
import { useGitHub } from '../lib/github'
import { webUrl } from '../lib/links'
import { native, openExternal } from '../lib/platform'
import { confirmDialogOpen } from '../lib/scroll'
import { useIsActiveTab } from '../lib/TabsProvider'
import { useLocalRepo } from '../lib/useLocalRepo'
import { hostName, workspacePath, type WorkspaceRepo } from '../lib/workspace'
import { RepoSettingsDialog } from './RepoSettingsDialog'
import { encodePath } from '../lib/repo'

type LocalRepoState = ReturnType<typeof useLocalRepo>
type Integration = 'merge' | 'squash' | 'rebase'

function NameDialog({ title, action, initial, taken, note, onSubmit, onClose }: { title: string; action: string; initial: string; taken: string[]; note?: ReactNode; onSubmit(name: string): void; onClose(): void }) {
  const [value, setValue] = useState(initial)
  const name = value.trim().replace(/\s+/g, '-')
  const ok = !!name && name !== initial && !taken.includes(name)
  const submit = () => {
    if (!ok) return
    onSubmit(name)
    onClose()
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: action, buttonType: 'primary', disabled: !ok, onClick: submit },
      ]}
    >
      <FormControl>
        <FormControl.Label>Name</FormControl.Label>
        <TextInput block autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {taken.includes(name) && name !== initial && <FormControl.Validation variant="error">A branch with this name already exists.</FormControl.Validation>}
      </FormControl>
      {note && <p className="ws-note mt-2">{note}</p>}
    </Dialog>
  )
}

function BranchPickDialog({ title, branches, onPick, onClose }: { title: string; branches: BranchState[]; onPick(branch: BranchState): void; onClose(): void }) {
  const [filter, setFilter] = useState('')
  const shown = branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Dialog title={title} onClose={onClose} footerButtons={[{ content: 'Cancel', onClick: onClose }]}>
      <TextInput block autoFocus aria-label="Filter branches" placeholder="Filter branches" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ActionList className="ws-pick-list">
        {shown.map((b) => (
          <ActionList.Item
            key={b.name}
            onSelect={() => {
              onClose()
              onPick(b)
            }}
          >
            {b.name}
          </ActionList.Item>
        ))}
      </ActionList>
      {!shown.length && <p className="ws-note">No branches match.</p>}
    </Dialog>
  )
}

/** What can be done to a branch, shared by its right-click menu and the app's Branch menu. */
export function useBranchActions(repo: WorkspaceRepo, local: LocalRepoState) {
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { account } = useGitHub()
  const qc = useQueryClient()
  const [renaming, setRenaming] = useState<BranchState | null>(null)
  const all = local.branches.data ?? []

  const showBranchTab = () => {
    const home = workspacePath(repo, account.host)
    if (home && home !== pathname) navigate(home)
  }
  const refFor = (b: BranchState) => (b.location === 'remote' ? `${repo.remote?.name ?? 'origin'}/${b.name}` : b.name)

  /** Conflicts aren't a failure: the repository stays mid-merge, and the bar under the toolbar takes it from there. */
  const integrate = (b: BranchState, how: Integration) =>
    local.op.mutate(async () => {
      const git = local.git!
      await (how === 'rebase' ? git.rebase(refFor(b)) : git.merge(refFor(b), { squash: how === 'squash' }))
      showBranchTab()
    })

  const worktree = async (b: BranchState) => {
    const parent = await native!.pickDirectory('Choose where to put the worktree')
    if (!parent) return
    local.op.mutate(async () => {
      const added = await native!.repos.addWorktree(repo.local!.id, parent, b.name)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
      navigate(`/local/${added.id}`)
    })
  }

  /** The checked-out branch can't be deleted, so `moveTo` says where to go first. */
  const remove = async (b: BranchState, moveTo?: string) => {
    const where = b.location === 'both' ? `This removes it from this Mac. The branch on ${hostName(repo)} stays.` : 'It’s only on this Mac, so any commits no other branch has will be lost.'
    const ok = await confirm({
      title: `Delete ${b.name}?`,
      content: moveTo ? `${where} You’ll be moved to ${moveTo}.` : where,
      confirmButtonContent: 'Delete',
      confirmButtonType: 'danger',
    })
    if (!ok) return
    local.op.mutate(async () => {
      if (moveTo) await local.git!.switchTo(moveTo)
      await local.git!.deleteBranch(b.name)
    })
  }

  const dialogs = renaming && (
    <NameDialog
      title={`Rename ${renaming.name}`}
      action="Rename"
      initial={renaming.name}
      taken={all.map((b) => b.name)}
      note={renaming.location === 'both' ? `This only renames it on this Mac. The branch on ${hostName(repo)} keeps its name.` : undefined}
      onSubmit={(to) => local.op.mutate(() => local.git!.renameBranch(renaming.name, to))}
      onClose={() => setRenaming(null)}
    />
  )
  return { rename: setRenaming, copyName: (b: BranchState) => void copyText(b.name), worktree, remove, integrate, refFor, showBranchTab, dialogs }
}

/** Says a merge or rebase has stopped, and offers the ways out of it. */
function OperationBar({ local }: { local: LocalRepoState }) {
  const confirm = useConfirm()
  const operation = local.operation.data
  if (!operation) return null
  const conflicts = (local.status.data?.entries ?? []).filter(isUnmerged).length
  const isMerge = operation === 'merge'
  const word = isMerge ? 'Merge' : 'Rebase'
  const abort = async () => {
    const ok = await confirm({
      title: `Abort this ${word.toLowerCase()}?`,
      content: 'Your branch goes back to how it was before it started, and any conflicts you’ve resolved are lost.',
      confirmButtonContent: `Abort ${word.toLowerCase()}`,
      confirmButtonType: 'danger',
    })
    if (ok) local.op.mutate(() => (isMerge ? local.git!.abortMerge() : local.git!.abortRebase()))
  }
  return (
    <div className="ws-operation" role="status">
      <span className="flex-1">
        <strong>{word} in progress.</strong> {conflicts ? `${plural(conflicts, 'file')} with conflicts: fix them in your editor, then tick them in Changes.` : 'All conflicts are resolved.'}
      </span>
      <Button size="small" onClick={() => void abort()}>
        Abort {word.toLowerCase()}
      </Button>
      <Button size="small" variant="primary" disabled={conflicts > 0 || local.op.isPending} onClick={() => local.op.mutate(() => (isMerge ? local.git!.finishMerge() : local.git!.continueRebase()))}>
        {isMerge ? 'Finish merge' : 'Continue rebase'}
      </Button>
    </div>
  )
}

type Picking = Integration | 'worktree'

const PICK_TITLE = (branch: string): Record<Picking, string> => ({
  merge: `Merge into ${branch}`,
  squash: `Squash and merge into ${branch}`,
  rebase: `Rebase ${branch} onto`,
  worktree: 'Check out in a new worktree',
})

/** Answers the app's Repository and Branch menus for the repository in the focused tab, and tells them what applies. */
export function RepoCommands({ repo }: { repo: WorkspaceRepo }) {
  const local = useLocalRepo(repo.local)
  const actions = useBranchActions(repo, local)
  const confirm = useConfirm()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { account } = useGitHub()
  const active = useIsActiveTab()
  const [picking, setPicking] = useState<Picking | null>(null)
  const [creating, setCreating] = useState(false)
  const [settings, setSettings] = useState(false)

  const { git, ops } = local
  const status = local.status.data
  const all = local.branches.data ?? []
  const main = useQuery({ queryKey: ['local-main-branch', repo.local?.id ?? ''], enabled: !!git, staleTime: 60_000, queryFn: () => git!.mainBranch() }).data ?? null
  const branch = status?.branch && status.branch !== 'HEAD' ? status.branch : null
  const github = repo.github && repo.github.host.toLowerCase() === account.host.toLowerCase() ? `/${repo.github.owner}/${repo.github.repo}` : null
  const current = all.find((b) => b.name === branch)

  const menuState = { folder: !!git, github: !!github, remote: !!repo.remote, branch: !!branch, upstream: !!status?.upstream, changes: !!status?.entries.length, main: main ?? '', onMain: !!branch && branch === main, busy: !!local.operation.data }
  const stateKey = JSON.stringify(menuState)
  useEffect(() => {
    if (active) void native?.setMenuState(JSON.parse(stateKey))
  }, [active, stateKey])

  const run = (action: string) => {
    const web = (path: string) => openExternal(webUrl(account.host, path))
    const compare = branch && main ? `${github}/compare/${encodePath(main)}...${encodePath(branch)}` : null
    const id = repo.local?.id ?? ''
    const commands: Record<string, () => unknown> = {
      push: () => local.unqueued.mutate(() => (status?.upstream ? git!.push() : git!.publishBranch())),
      pull: () => local.op.mutate(() => git!.pull()),
      fetch: () => local.unqueued.mutate(() => git!.fetch()),
      remove: async () => {
        if (!(await confirm({ title: `Remove ${repo.name}?`, content: 'It’s removed from this app only. The folder stays on your Mac.', confirmButtonContent: 'Remove', confirmButtonType: 'danger' }))) return
        await native!.repos.remove(id)
        await qc.invalidateQueries({ queryKey: ['local-repos'] })
        await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
        navigate('/')
      },
      'view-github': () => web(github!),
      terminal: () => native!.openInTerminal(id),
      finder: () => native!.revealInFinder(id),
      editor: () => native!.openInEditor(id),
      'create-issue': () => navigate(`${github}/issues/new`),
      'new-worktree': () => setPicking('worktree'),
      settings: () => setSettings(true),
      'new-branch': () => setCreating(true),
      rename: () => current && actions.rename(current),
      delete: () => current && main && actions.remove(current, main),
      'discard-all': async () => {
        const entries = status?.entries ?? []
        const ok = await confirm({ title: `Discard ${plural(entries.length, 'change')}?`, content: 'This can’t be undone. Every uncommitted change in this folder is lost, new files too.', confirmButtonContent: 'Discard changes', confirmButtonType: 'danger' })
        if (ok)
          local.op.mutate(async () => {
            for (const entry of entries) await git!.discard(entry)
          })
      },
      'stash-all': () => local.op.mutate(() => git!.stash()),
      'update-from-main': () => {
        const target = all.find((b) => b.name === main)
        if (!target) return
        // The remote's copy, so this brings in what's newest even if the local main hasn't been pulled.
        const ref = target.location === 'local' ? target.name : `${repo.remote?.name ?? 'origin'}/${target.name}`
        local.unqueued.mutate(async () => {
          if (repo.remote) await git!.fetch()
          await ops!.run(() => git!.merge(ref))
          actions.showBranchTab()
        })
      },
      merge: () => setPicking('merge'),
      squash: () => setPicking('squash'),
      rebase: () => setPicking('rebase'),
      'compare-github': () => compare && web(compare),
      'view-branch': () => branch && web(`${github}/tree/${encodePath(branch)}`),
      'create-pull': () => compare && navigate(compare),
    }
    void commands[action]?.()
  }
  const latest = useRef(run)
  latest.current = run

  useEffect(() => {
    if (!native || !active) return
    return native.onMenu((action) => {
      if (!action.startsWith('repo:') || confirmDialogOpen() || document.querySelector('[role="dialog"]')) return
      latest.current(action.slice('repo:'.length))
    })
  }, [active])

  return (
    <>
      {git && <OperationBar local={local} />}
      {picking && branch && (
        <BranchPickDialog
          title={PICK_TITLE(branch)[picking]}
          branches={all.filter((b) => b.name !== branch)}
          onClose={() => setPicking(null)}
          onPick={(b) => (picking === 'worktree' ? void actions.worktree(b) : actions.integrate(b, picking))}
        />
      )}
      {creating && (
        <NameDialog
          title="New branch"
          action="Create branch"
          initial=""
          taken={all.map((b) => b.name)}
          onSubmit={(name) =>
            local.op.mutate(async () => {
              await git!.createBranch(name)
              actions.showBranchTab()
            })
          }
          onClose={() => setCreating(false)}
        />
      )}
      {settings && <RepoSettingsDialog repo={repo} onClose={() => setSettings(false)} />}
      {actions.dialogs}
      {local.error && <Banner className="ws-error" variant="critical" title="Git said" description={local.error} onDismiss={local.clearError} />}
    </>
  )
}

/** With no repository in the focused tab, the Repository and Branch menus have nothing to act on. */
export function useClearRepoMenu(clear: boolean) {
  const active = useIsActiveTab()
  useEffect(() => {
    if (clear && active) void native?.setMenuState(null)
  }, [clear, active])
}
