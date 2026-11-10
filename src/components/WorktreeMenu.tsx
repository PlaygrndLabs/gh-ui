import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, TextInput, useConfirm } from '@primer/react'
import { AlertIcon, FileDirectoryIcon, TriangleDownIcon } from '@primer/octicons-react'
import type { Worktree } from '../lib/git'
import { native, type LocalRepo } from '../lib/platform'
import { useLocalRepo } from '../lib/useLocalRepo'
import type { WorkspaceRepo } from '../lib/workspace'
import { BranchPickDialog, GitErrorBanner, useBranchActions } from './RepoCommands'
import { useToolbarPanel } from './toolbarPanel'

/** Every checkout of this repository, one click from the others. Each is a folder of its own in the app. */
export function WorktreeMenu({ repo, folder, errorSlot }: { repo: WorkspaceRepo; folder: LocalRepo; errorSlot: HTMLElement | null }) {
  const local = useLocalRepo(folder)
  const actions = useBranchActions(repo, local)
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [picking, setPicking] = useState(false)
  const { anchor, frame } = useToolbarPanel(open)
  const query = useQuery({ queryKey: ['local-worktrees', folder.id], enabled: !!local.git, queryFn: () => local.git!.worktrees(), refetchInterval: 15_000 })
  const worktrees = query.data ?? []
  const { refetch } = query
  // One made in a terminal a moment ago should be here when you look.
  useEffect(() => {
    if (open) void refetch()
  }, [open, refetch])

  const isHere = (w: Worktree) => w.path === folder.path
  const needle = filter.trim().toLowerCase()
  const shown = worktrees.filter((w) => !needle || `${w.name} ${w.branch ?? ''}`.toLowerCase().includes(needle))
  const main = shown.filter((w) => w.main)
  const linked = shown.filter((w) => !w.main)

  const remove = async (w: Worktree) => {
    const frees = w.branch ? `frees ${w.branch} and ` : ''
    const ok = await confirm({
      title: `Remove ${w.name}?`,
      content: w.missing ? `Its folder, ${w.path}, isn’t on this Mac. Removing it ${frees}forgets the folder here. If another machine or a VM still uses it, it stops working there.` : `This deletes ${w.path} and its files. Commits stay in the repository. Git won’t remove it if it has uncommitted changes.`,
      confirmButtonContent: 'Remove',
      confirmButtonType: 'danger',
    })
    if (!ok) return
    local.op.mutate(async () => {
      await native!.repos.removeWorktree(folder.id, w.path)
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
      await qc.invalidateQueries({ queryKey: ['workspace-folders'] })
    })
  }

  const row = (w: Worktree) => (
    <ActionList.Item
      key={w.path}
      selected={isHere(w)}
      onContextMenu={(e) => {
        if (w.main || isHere(w)) return
        e.preventDefault()
        void native!.contextMenu([{ id: 'remove', label: 'Remove…' }]).then((action) => {
          if (action !== 'remove') return
          setOpen(false)
          void remove(w)
        })
      }}
      onSelect={() => {
        setFilter('')
        // There's nothing to open, and removing it is what gets its branch back.
        if (w.missing) void remove(w)
        else if (!isHere(w)) actions.openWorktree(w.path)
      }}
    >
      {w.missing && (
        <ActionList.LeadingVisual>
          <AlertIcon />
        </ActionList.LeadingVisual>
      )}
      {w.name}
      {w.missing && <span className="ws-worktree-missing"> (missing)</span>}
      <ActionList.TrailingVisual>
        <span className="ws-worktree-branch" title={w.branch ?? w.sha}>
          {w.branch ?? w.sha.slice(0, 7)}
        </span>
      </ActionList.TrailingVisual>
    </ActionList.Item>
  )

  return (
    <>
      <ActionMenu open={open} onOpenChange={setOpen} anchorRef={anchor}>
        <ActionMenu.Anchor>
          <button type="button" className="ws-seg ws-seg-worktree" aria-label={`Current worktree: ${folder.name}`}>
            <FileDirectoryIcon />
            <span className="ws-seg-text">
              <span className="ws-seg-key">Current worktree</span>
              <span className="ws-seg-value">{folder.name}</span>
            </span>
            <TriangleDownIcon />
          </button>
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium" className="ws-toolbar-panel" style={frame}>
          <div className="ws-toolbar-panel-body">
            <div className="ws-menu-filter ws-worktree-filter">
              <TextInput block autoFocus aria-label="Filter worktrees" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <Button
                onClick={() => {
                  setOpen(false)
                  setPicking(true)
                }}
              >
                New worktree
              </Button>
            </div>
            <ActionList selectionVariant="single" className="ws-menu-list">
              {main.length > 0 && (
                <ActionList.Group>
                  <ActionList.GroupHeading>Main worktree</ActionList.GroupHeading>
                  {main.map(row)}
                </ActionList.Group>
              )}
              {linked.length > 0 && (
                <ActionList.Group>
                  <ActionList.GroupHeading>Linked worktrees</ActionList.GroupHeading>
                  {linked.map(row)}
                </ActionList.Group>
              )}
            </ActionList>
            {!shown.length && <p className="ws-note p-3">No worktrees match.</p>}
          </div>
        </ActionMenu.Overlay>
      </ActionMenu>
      {picking && (
        <BranchPickDialog
          title="Check out in a new worktree"
          branches={(local.branches.data ?? []).filter((b) => !b.current && !b.worktree)}
          onClose={() => setPicking(false)}
          onPick={(b) => void actions.worktree(b)}
        />
      )}
      <GitErrorBanner local={local} slot={errorSlot} />
    </>
  )
}
