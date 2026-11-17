import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, RelativeTime, SegmentedControl, Spinner, TextInput } from '@primer/react'
import { AlertFillIcon, CheckCircleFillIcon, GitBranchIcon, InfoIcon } from '@primer/octicons-react'
import { errorMessage } from '../lib/github'
import { plural, shortSha } from '../lib/format'
import type { BranchState, MergePreview } from '../lib/git'
import type { useLocalRepo } from '../lib/useLocalRepo'
import { FileDiffBox } from './DiffView'

type LocalRepoState = ReturnType<typeof useLocalRepo>
export type MergeHow = 'merge' | 'squash'

interface MergeDialogProps {
  local: LocalRepoState
  how: MergeHow
  /** The checked-out branch, which the merge lands on. */
  into: string
  branches: BranchState[]
  initial: BranchState | null
  refFor(b: BranchState): string
  onMerge(b: BranchState): void
  onClose(): void
}

/**
 * Says what a merge will do before it happens, as GitHub Desktop does: pick a branch, see whether it merges cleanly or
 * which files will conflict, and look over the commits and changes it brings in. Nothing changes until the button.
 */
export function MergeDialog({ local, how, into, branches, initial, refFor, onMerge, onClose }: MergeDialogProps) {
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<BranchState | null>(initial)
  const shown = branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
  const ref = picked ? refFor(picked) : null
  const preview = useQuery({
    queryKey: ['merge-preview', local.git ? into : '', ref, picked?.sha],
    enabled: !!local.git && !!ref,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => local.git!.mergePreview(ref!),
  })
  const data = preview.data
  const canMerge = !!picked && !!data && data.kind !== 'up-to-date' && !local.op.isPending
  const action = how === 'squash' ? `Squash and merge ${picked ? picked.name : ''} into ${into}` : data?.kind === 'fast-forward' ? `Fast-forward ${into}` : 'Create a merge commit'

  return (
    <Dialog
      title={how === 'squash' ? `Squash and merge into ${into}` : `Merge into ${into}`}
      width="xlarge"
      height="large"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        {
          content: data?.kind === 'conflicts' ? `${action} with conflicts` : action,
          buttonType: data?.kind === 'conflicts' ? 'danger' : 'primary',
          disabled: !canMerge,
          onClick: () => {
            if (!picked) return
            onClose()
            onMerge(picked)
          },
        },
      ]}
    >
      <div className="ws-merge">
        <div className="ws-merge-branches">
          <TextInput block autoFocus aria-label="Filter branches" placeholder="Filter branches" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="ws-merge-list" role="listbox" aria-label="Branches">
            {shown.map((b) => (
              <button
                key={b.name}
                type="button"
                role="option"
                aria-selected={picked?.name === b.name}
                className={`ws-row ${picked?.name === b.name ? 'is-selected' : ''}`}
                onClick={() => setPicked(b)}
              >
                <GitBranchIcon className="fg-muted" />
                <span className="ws-merge-branch-name">{b.name}</span>
                {b.location === 'remote' && <span className="ws-merge-tag">remote</span>}
              </button>
            ))}
            {!shown.length && <p className="ws-note p-2">No branches match.</p>}
          </div>
        </div>
        <div className="ws-merge-review">
          {!picked ? (
            <div className="ws-merge-empty">Pick a branch to see what merging it into {into} will do.</div>
          ) : preview.isLoading ? (
            <MergeStatus icon={<Spinner size="small" />}>Checking for conflicts…</MergeStatus>
          ) : preview.isError ? (
            <MergeStatus tone="danger" icon={<AlertFillIcon />}>
              Couldn’t work out this merge: {errorMessage(preview.error)}
            </MergeStatus>
          ) : data ? (
            <MergeReview key={ref} preview={data} how={how} from={picked.name} into={into} />
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

function MergeStatus({ tone, icon, children }: { tone?: 'ok' | 'warn' | 'danger'; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`ws-merge-status ${tone ? `is-${tone}` : ''}`} role="status">
      <span className="ws-merge-status-icon">{icon}</span>
      <span>{children}</span>
    </div>
  )
}

function MergeReview({ preview, how, from, into }: { preview: MergePreview; how: MergeHow; from: string; into: string }) {
  const [tab, setTab] = useState<'files' | 'commits'>('files')
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const conflicted = useMemo(() => new Set(preview.kind === 'up-to-date' ? [] : preview.conflicts), [preview])
  // Conflicted files first, so they're what you see.
  const files = useMemo(() => (preview.kind === 'up-to-date' ? [] : [...preview.files].sort((a, b) => Number(conflicted.has(b.newPath)) - Number(conflicted.has(a.newPath)))), [preview, conflicted])

  if (preview.kind === 'up-to-date')
    return (
      <MergeStatus icon={<InfoIcon />}>
        <strong>{into}</strong> is already up to date with <strong>{from}</strong>. There’s nothing to merge.
      </MergeStatus>
    )

  const commits = plural(preview.commits.length, 'commit')
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <>
      {preview.kind === 'conflicts' ? (
        <MergeStatus tone="warn" icon={<AlertFillIcon />}>
          There will be <strong>{plural(preview.conflicts.length, 'conflicted file')}</strong> when merging <strong>{from}</strong> into <strong>{into}</strong>.
        </MergeStatus>
      ) : (
        <MergeStatus tone="ok" icon={<CheckCircleFillIcon />}>
          {how === 'squash' ? (
            <>
              This will squash <strong>{commits}</strong> from <strong>{from}</strong> into one change on <strong>{into}</strong>, staged for you to commit.
            </>
          ) : preview.kind === 'fast-forward' ? (
            <>
              This will bring <strong>{commits}</strong> from <strong>{from}</strong> into <strong>{into}</strong> by fast-forwarding, with no merge commit.
            </>
          ) : (
            <>
              This will merge <strong>{commits}</strong> from <strong>{from}</strong> into <strong>{into}</strong>.
            </>
          )}
        </MergeStatus>
      )}

      {preview.kind === 'conflicts' && (
        <div className="ws-merge-conflicts">
          <ul aria-label="Conflicted files">
            {preview.conflicts.map((path) => (
              <li key={path}>
                <AlertFillIcon className="fg-attention" />
                <span className="ws-merge-path">{path}</span>
              </li>
            ))}
          </ul>
          <p className="ws-note">The merge will stop with these files marked. Fix them in your editor, tick them in Changes, then finish the merge — or abort it to go back.</p>
        </div>
      )}

      <SegmentedControl aria-label="Review" size="small" className="ws-merge-tabs">
        <SegmentedControl.Button selected={tab === 'files'} onClick={() => setTab('files')}>
          {`Files changed (${files.length})`}
        </SegmentedControl.Button>
        <SegmentedControl.Button selected={tab === 'commits'} onClick={() => setTab('commits')}>
          {`Commits (${preview.commits.length})`}
        </SegmentedControl.Button>
      </SegmentedControl>

      {tab === 'files' ? (
        <div className="ws-merge-files">
          {files.map((f) => (
            <FileDiffBox
              key={f.newPath}
              eager
              collapsed={!open.has(f.newPath)}
              onToggle={() => toggle(f.newPath)}
              file={{
                path: f.newPath,
                previousPath: f.oldPath !== f.newPath ? f.oldPath : null,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                patch: f.binary ? null : f.patch,
              }}
              actions={conflicted.has(f.newPath) && <span className="ws-merge-tag is-conflict">Conflict</span>}
            />
          ))}
          {!files.length && <p className="ws-note">No file changes: the commits it brings in are already reflected here.</p>}
        </div>
      ) : (
        <ul className="ws-merge-commits" aria-label="Commits">
          {preview.commits.map((c) => (
            <li key={c.sha}>
              <span className="ws-merge-commit-subject">{c.subject}</span>
              <span className="ws-merge-commit-meta">
                {c.author} · <RelativeTime date={new Date(c.date)} /> · <code>{shortSha(c.sha)}</code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
