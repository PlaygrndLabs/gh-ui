import { useCallback, useRef, useState } from 'react'
import { Dialog, FormControl, Textarea, TextInput, useConfirm } from '@primer/react'
import { BranchPickDialog, NameDialog } from '../../components/RepoCommands'
import { copyText, firstLine, shortSha } from '../../lib/format'
import type { HistoryRow } from '../../lib/git'
import { useGitHub } from '../../lib/github'
import { webUrl } from '../../lib/links'
import { native, openExternal, type ContextMenuItem } from '../../lib/platform'
import type { useLocalRepo } from '../../lib/useLocalRepo'

type LocalRepoState = ReturnType<typeof useLocalRepo>
type OpenDialog = { kind: 'branch' | 'tag' | 'cherry-pick'; commit: HistoryRow } | { kind: 'amend'; commit: HistoryRow; message: string } | null

function AmendDialog({ message, onSubmit, onClose }: { message: string; onSubmit(summary: string, description: string): void; onClose(): void }) {
  const [summary, setSummary] = useState(firstLine(message))
  const [description, setDescription] = useState(message.split('\n').slice(1).join('\n').trim())
  const submit = () => {
    if (!summary.trim()) return
    onSubmit(summary, description)
    onClose()
  }
  return (
    <Dialog
      title="Amend commit"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: 'Amend commit', buttonType: 'primary', disabled: !summary.trim(), onClick: submit },
      ]}
    >
      <FormControl>
        <FormControl.Label>Summary</FormControl.Label>
        <TextInput block autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} />
      </FormControl>
      <FormControl className="mt-2">
        <FormControl.Label>Description</FormControl.Label>
        <Textarea block rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormControl>
      <p className="ws-note mt-2">Anything staged in Changes goes into this commit too.</p>
    </Dialog>
  )
}

/** A commit's right-click menu in History, and the dialogs its items open. */
export function useCommitMenu({ local, github, isCurrent, rows, notOnRemote, undo }: { local: LocalRepoState; github: { owner: string; repo: string } | null; isCurrent: boolean; rows: HistoryRow[]; notOnRemote: string[]; undo(subject: string): void }) {
  const { account } = useGitHub()
  const confirm = useConfirm()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const close = () => setDialog(null)
  const git = local.git

  const open = async (sha: string) => {
    const commit = rows.find((r) => r.sha === sha)
    if (!commit) return
    // What's still to pull is listed too, but it isn't on this branch yet.
    const isHead = sha === rows.find((r) => r.mark !== '↓')?.sha
    const canChange = isCurrent && !!git && !local.operation.data
    const unpushed = commit.mark === '↑'
    const tags = git ? await git.tagsAt(sha).catch(() => [] as string[]) : []
    const url = github && !notOnRemote.includes(sha) ? webUrl(account.host, `/${github.owner}/${github.repo}/commit/${sha}`) : null
    const separator: ContextMenuItem = { type: 'separator' }
    const action = await native!.contextMenu([
      ...(git
        ? [
            ...(isHead
              ? [
                  { id: 'amend', label: 'Amend Commit…', enabled: canChange && unpushed },
                  { id: 'undo', label: 'Undo Commit', enabled: canChange && unpushed },
                ]
              : []),
            { id: 'reset', label: 'Reset to Commit…', enabled: canChange && unpushed && !isHead },
            { id: 'checkout', label: 'Checkout Commit', enabled: canChange && !isHead },
            { id: 'revert', label: 'Revert Changes in Commit', enabled: canChange && commit.mark !== '↓' },
            separator,
            { id: 'branch', label: 'Create Branch from Commit…', enabled: canChange },
            { id: 'tag', label: 'Create Tag…' },
            { id: 'cherry-pick', label: 'Cherry-pick Commit…', enabled: canChange },
            separator,
          ]
        : []),
      { id: 'copy-sha', label: 'Copy SHA' },
      ...(git ? [{ id: 'copy-tag', label: 'Copy Tag', enabled: tags.length > 0 }] : []),
      ...(github ? [{ id: 'view', label: 'View on GitHub', enabled: !!url }] : []),
    ])
    if (action === 'amend') setDialog({ kind: 'amend', commit, message: (await git!.show(sha)).message || commit.subject })
    if (action === 'undo') undo(commit.subject)
    if (action === 'reset') {
      const ok = await confirm({ title: `Reset to ${shortSha(sha)}?`, content: 'Commits after this one are taken off the branch. Their changes stay in your folder as uncommitted changes.', confirmButtonContent: 'Reset', confirmButtonType: 'danger' })
      if (ok) local.op.mutate(() => git!.resetTo(sha))
    }
    if (action === 'checkout') local.op.mutate(() => git!.checkoutCommit(sha))
    if (action === 'revert') local.op.mutate(() => git!.revertCommit(sha))
    if (action === 'branch' || action === 'tag' || action === 'cherry-pick') setDialog({ kind: action, commit })
    if (action === 'copy-sha') void copyText(sha)
    if (action === 'copy-tag') void copyText(tags.join(' '))
    if (action === 'view' && url) openExternal(url)
  }
  const latest = useRef(open)
  latest.current = open
  // The same function every time, so opening a menu doesn't redraw every row.
  const openMenu = useCallback((sha: string) => void latest.current(sha), [])

  const sha = dialog?.commit.sha ?? ''
  const allBranches = local.branches.data ?? []
  const dialogs = (
    <>
      {dialog?.kind === 'amend' && <AmendDialog message={dialog.message} onClose={close} onSubmit={(summary, description) => local.op.mutate(() => git!.amendCommit(summary, description))} />}
      {dialog?.kind === 'branch' && <NameDialog title={`Create a branch from ${shortSha(sha)}`} action="Create branch" initial="" taken={allBranches.map((b) => b.name)} onClose={close} onSubmit={(name) => local.op.mutate(() => git!.createBranchAt(name, sha))} />}
      {dialog?.kind === 'tag' && <NameDialog title={`Tag ${shortSha(sha)}`} action="Create tag" initial="" taken={[]} onClose={close} onSubmit={(name) => local.op.mutate(() => git!.createTag(name, sha))} />}
      {dialog?.kind === 'cherry-pick' && (
        <BranchPickDialog
          title={`Cherry-pick ${shortSha(sha)} onto`}
          branches={allBranches.filter((b) => !b.current && !b.worktree)}
          onClose={close}
          onPick={(b) =>
            local.op.mutate(async () => {
              await git!.switchTo(b.name)
              await git!.cherryPick(sha)
            })
          }
        />
      )}
    </>
  )
  return { openMenu, dialogs }
}
