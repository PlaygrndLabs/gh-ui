import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Banner, Button, Checkbox, IconButton, RelativeTime, TextInput, Textarea, useConfirm } from '@primer/react'
import { CheckIcon, SparkleFillIcon, UndoIcon, XIcon } from '@primer/octicons-react'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { generateCommitMessage } from '../../lib/agent/oneshot'
import type { FileDiff } from '../../lib/diff'
import { changePaths, isStaged, isUnmerged, type BranchState, type LogEntry, type StatusEntry } from '../../lib/git'
import { errorMessage, useGitHub } from '../../lib/github'
import { webUrl } from '../../lib/links'
import { openExternal } from '../../lib/platform'
import { firstLine, shortSha } from '../../lib/format'
import { readPref } from '../../lib/storage'
import { useLocalRepo } from '../../lib/useLocalRepo'
import { useRemoteBranches, type WorkspaceRepo } from '../../lib/workspace'
import { CopyButton, Loading } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { SplitPane } from '../../components/SplitPane'
import { PublishDialog } from '../../components/WorkspaceHeader'
import { useTabBranch } from '../../lib/TabsProvider'
import { CloneDialog } from '../Local'

const PLACE: Record<BranchState['location'], string> = { both: 'On this Mac and GitHub', local: 'Only on this Mac', remote: 'Only on GitHub' }

type Selection = { kind: 'file'; path: string } | { kind: 'commit'; sha: string } | null

function ChangeBadge({ e }: { e: StatusEntry }) {
  const code = isUnmerged(e) ? '!' : e.index === '?' ? 'U' : e.index !== ' ' ? e.index : e.worktree
  const color = code === 'A' || code === 'U' ? 'fg-success' : code === 'D' || code === '!' ? 'fg-danger' : code === 'R' ? 'fg-accent' : 'fg-attention'
  return (
    <span className={`text-mono text-small text-bold ${color}`} title={{ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Copied', '!': 'Conflicted' }[code] ?? code}>
      {code}
    </span>
  )
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ws-section" aria-label={title}>
      <div className="ws-section-head">
        <h3 className="ws-section-title">{title}</h3>
        {count !== undefined && <span className="ws-pill">{count}</span>}
        {action && <span className="ws-section-action">{action}</span>}
      </div>
      {children}
    </section>
  )
}

function CommitRow({ commit, selected, mark, onSelect }: { commit: LogEntry; selected: boolean; mark?: string; onSelect(): void }) {
  return (
    <button type="button" className={`ws-row ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={onSelect}>
      {mark && <span className="ws-pill" title={mark === '↑' ? 'Not pushed yet' : 'Not pulled yet'}>{mark}</span>}
      <span className="ws-row-main">{firstLine(commit.subject)}</span>
      <span className="ws-row-sub text-mono">{shortSha(commit.sha)}</span>
    </button>
  )
}

/** A repository's front page in the desktop app: every branch, and everything about the one you pick, local or not. */
export function BranchesWorkspace({ repo }: { repo: WorkspaceRepo }) {
  const { octokit, key, account } = useGitHub()
  const local = useLocalRepo(repo.local)
  const confirm = useConfirm()
  const github = repo.github && repo.github.host.toLowerCase() === account.host.toLowerCase() ? repo.github : null
  const { picked } = useTabBranch()
  const [selection, setSelection] = useState<Selection>(null)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [dialog, setDialog] = useState<'clone' | 'publish' | null>(null)
  const [genError, setGenError] = useState<string | null>(null)
  const split = readPref('diffSplit', false)

  const remoteBranches = useRemoteBranches(repo)
  const branches = (repo.local ? local.branches.data : remoteBranches.data) ?? []
  const status = local.status.data
  // The top menu chooses: in a folder by checking out, without one by picking.
  const branch = (repo.local ? undefined : branches.find((b) => b.name === picked)) ?? branches.find((b) => b.current) ?? branches[0] ?? null
  const isCurrent = !!branch?.current

  const commits = useQuery({
    queryKey: repo.local ? ['local-log', repo.local.id, branch?.name, branch?.sha, branch?.upstream, branch?.behind] : [key, 'workspace-commits', github?.owner, github?.repo, branch?.name],
    enabled: !!branch,
    queryFn: async () => {
      if (local.git) return local.git.branchCommits(branch!)
      const { data } = await octokit.rest.repos.listCommits({ owner: github!.owner, repo: github!.repo, sha: branch!.name, per_page: 100 })
      return { local: [] as LogEntry[], incoming: [] as LogEntry[], remote: data.map((c): LogEntry => ({ sha: c.sha, author: c.commit.author?.name ?? c.author?.login ?? '', date: c.commit.author?.date ?? '', subject: c.commit.message })) }
    },
  })
  const pulls = useQuery({
    queryKey: [key, 'workspace-open-pulls', github?.owner, github?.repo],
    enabled: !!github,
    staleTime: 60_000,
    queryFn: async () => (await octokit.rest.pulls.list({ owner: github!.owner, repo: github!.repo, state: 'open', per_page: 100 })).data,
  })
  const pullFor = (name: string) => pulls.data?.find((p) => p.head.ref === name && p.head.repo?.full_name.toLowerCase() === `${github!.owner}/${github!.repo}`.toLowerCase())
  const pull = branch ? pullFor(branch.name) : undefined
  const runs = useQuery({
    queryKey: [key, 'workspace-branch-runs', github?.owner, github?.repo, branch?.name],
    enabled: !!github && !!branch && branch.location !== 'local',
    staleTime: 60_000,
    queryFn: async () => (await octokit.rest.actions.listWorkflowRunsForRepo({ owner: github!.owner, repo: github!.repo, branch: branch!.name, per_page: 5 })).data.workflow_runs,
  })
  const stashes = useQuery({
    queryKey: ['local-stash', repo.local?.id ?? ''],
    enabled: !!local.git,
    queryFn: () => local.git!.stashList(),
  })

  const entries = isCurrent ? (status?.entries ?? []) : []
  const stagedCount = entries.filter(isStaged).length
  const conflictCount = entries.filter(isUnmerged).length
  const data = commits.data
  const shown = [...(data?.local ?? []), ...(data?.incoming ?? []), ...(data?.remote ?? [])]
  const entry = selection?.kind !== 'commit' ? (entries.find((e) => selection?.kind === 'file' && e.path === selection.path) ?? entries[0] ?? null) : null
  const commit = entry ? null : (shown.find((c) => selection?.kind === 'commit' && c.sha === selection.sha) ?? shown[0] ?? null)

  const diff = useQuery({
    queryKey: ['local-diff', repo.local?.id ?? '', entry?.path, entry?.index, entry?.worktree],
    enabled: !!entry && !!local.git,
    queryFn: () => local.git!.fileDiff(entry!),
  })
  const shownCommit = useQuery({
    queryKey: repo.local ? ['local-show', repo.local.id, commit?.sha] : [key, 'workspace-commit', github?.owner, github?.repo, commit?.sha],
    enabled: !!commit,
    queryFn: async (): Promise<{ message: string; files: FileDiff[] }> => {
      if (local.git) return local.git.show(commit!.sha)
      const { data: c } = await octokit.rest.repos.getCommit({ owner: github!.owner, repo: github!.repo, ref: commit!.sha })
      return {
        message: c.commit.message,
        files: (c.files ?? []).map((f) => ({ oldPath: f.previous_filename ?? f.filename, newPath: f.filename, status: f.status as FileDiff['status'], binary: !f.patch && f.changes > 0, additions: f.additions, deletions: f.deletions, patch: f.patch ?? '' })),
      }
    },
  })

  const generate = useMutation({
    mutationFn: async () => {
      const staged = await local.git!.stagedDiff()
      if (!staged.trim()) throw new Error('Stage some changes first.')
      return generateCommitMessage(staged, account)
    },
    onSuccess: (m) => {
      setGenError(null)
      setSummary(m.summary)
      setDescription(m.description)
    },
    onError: (e) => setGenError(errorMessage(e)),
  })

  useAgentPageContext({
    tabTitle: repo.name,
    label: `the branches of ${github ? `${github.owner}/${github.repo}` : repo.name}${repo.local ? ` with a local folder at ${repo.local.path}` : ''}`,
    owner: github?.owner,
    repo: github?.repo,
    details: { branch: branch?.name, where: branch ? PLACE[branch.location] : undefined, ahead: branch?.ahead, behind: branch?.behind, changed_files: repo.local ? entries.length : undefined, note: repo.local ? 'Agent GitHub tools see only pushed code, not local changes.' : undefined },
  })

  const toggleAll = async () => {
    if (stagedCount === entries.length) return local.op.mutate(() => local.git!.unstageAll())
    if (
      conflictCount &&
      !(await confirm({
        title: 'Mark conflicts as resolved?',
        content: `Staging all changes also marks ${conflictCount} conflicted file${conflictCount === 1 ? '' : 's'} as resolved. Make sure no conflict markers are left.`,
        confirmButtonContent: 'Stage all',
      }))
    )
      return
    local.op.mutate(() => local.git!.stageAll())
  }
  const discard = async (e: StatusEntry) => {
    const paths = changePaths(e)
    const from = paths.length > 1 ? ` (renamed from ${paths[0]})` : ''
    if (await confirm({ title: 'Discard changes?', content: `Your changes to ${e.path}${from} will be lost.`, confirmButtonType: 'danger', confirmButtonContent: 'Discard' })) local.op.mutate(() => local.git!.discard(e))
  }
  const commitWork = () =>
    local.op.mutate(async () => {
      await local.git!.commit(summary, description)
      setSummary('')
      setDescription('')
      setSelection(null)
    })
  const undo = (subject: string) =>
    local.op.mutate(async () => {
      await local.git!.undoCommit()
      setSummary(firstLine(subject))
      setSelection(null)
    })

  const timeline = branch && (
    <div className="ws-scroll">
      <Section title="Uncommitted" count={entries.length}>
        {isCurrent && entries.length > 0 && (
          <>
            <label className="ws-row ws-row-check">
              <Checkbox checked={stagedCount === entries.length} indeterminate={stagedCount > 0 && stagedCount < entries.length} onChange={() => void toggleAll()} aria-label="Stage all" />
              <span className="ws-row-sub">
                {stagedCount} of {entries.length} staged{conflictCount ? `, ${conflictCount} with conflicts` : ''}
              </span>
            </label>
            {entries.map((e) => (
              <div key={e.path} className={`ws-row ws-row-file ${entry?.path === e.path ? 'is-selected' : ''}`}>
                <Checkbox checked={isStaged(e)} aria-label={isUnmerged(e) ? `Mark ${e.path} as resolved` : `Stage ${e.path}`} onChange={() => local.op.mutate(() => (isStaged(e) ? local.git!.unstage(e) : local.git!.stage(e)))} />
                <button type="button" className="ws-row-link text-mono" title={e.path} onClick={() => setSelection({ kind: 'file', path: e.path })}>
                  {e.path}
                </button>
                <ChangeBadge e={e} />
              </div>
            ))}
            <div className="ws-commit">
              <div className="ws-commit-line">
                <TextInput block placeholder="Summary (required)" aria-label="Commit summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
                <IconButton icon={SparkleFillIcon} aria-label="Write commit message with Claude" description={stagedCount ? 'Write it with Claude' : 'Stage some changes first'} loading={generate.isPending} disabled={!stagedCount} onClick={() => generate.mutate()} />
              </div>
              <Textarea block rows={2} placeholder="Description" aria-label="Commit description" value={description} onChange={(e) => setDescription(e.target.value)} />
              {genError && <div className="error-box">{genError}</div>}
              <Button variant="primary" block disabled={!summary.trim() || !stagedCount || conflictCount > 0} loading={local.op.isPending} onClick={commitWork}>
                Commit {stagedCount ? `${stagedCount} file${stagedCount === 1 ? '' : 's'} ` : ''}to {branch.name}
              </Button>
            </div>
          </>
        )}
        {isCurrent && !entries.length && <p className="ws-note">No uncommitted changes.</p>}
        {!repo.local && <p className="ws-note">This repository isn’t on your Mac yet.</p>}
        {!repo.local && (
          <Button size="small" onClick={() => setDialog('clone')}>
            Clone {repo.name}
          </Button>
        )}
        {!!stashes.data?.length && (
          <div className="ws-row">
            <span className="ws-row-main">
              {stashes.data.length} stashed change{stashes.data.length === 1 ? '' : 's'}: {stashes.data[0]}
            </span>
            <Button size="small" onClick={() => local.op.mutate(() => local.git!.stashPop())}>
              Restore
            </Button>
          </div>
        )}
      </Section>

      <Section
        title="Only on this Mac"
        count={isCurrent ? (data?.local.length ?? 0) : branch.ahead}
        action={
          isCurrent && data?.local.length ? (
            <Button size="small" leadingVisual={UndoIcon} onClick={() => undo(data.local[0].subject)}>
              Undo last commit
            </Button>
          ) : undefined
        }
      >
        {data?.local.map((c) => <CommitRow key={c.sha} commit={c} mark="↑" selected={commit?.sha === c.sha} onSelect={() => setSelection({ kind: 'commit', sha: c.sha })} />)}
        {!repo.local && <p className="ws-note">Nothing here until you clone.</p>}
        {repo.local && data && !data.local.length && <p className="ws-note">Everything on this branch is pushed.</p>}
      </Section>

      <Section title="On GitHub" count={(data?.remote.length ?? 0) + (data?.incoming.length ?? 0)}>
        {!github && (
          <>
            <p className="ws-note">This repository isn’t on GitHub yet.</p>
            <Button size="small" onClick={() => setDialog('publish')}>
              Publish {repo.name}
            </Button>
          </>
        )}
        {data?.incoming.map((c) => <CommitRow key={c.sha} commit={c} mark="↓" selected={commit?.sha === c.sha} onSelect={() => setSelection({ kind: 'commit', sha: c.sha })} />)}
        {data?.remote.map((c) => <CommitRow key={c.sha} commit={c} selected={commit?.sha === c.sha} onSelect={() => setSelection({ kind: 'commit', sha: c.sha })} />)}
        {github && branch.location === 'local' && <p className="ws-note">This branch isn’t on GitHub yet.</p>}
      </Section>

      {github && (
        <Section title="Pull request">
          {pull ? (
            <Link className="ws-row ws-row-link-block" to={`/${github.owner}/${github.repo}/pull/${pull.number}`}>
              <span className="ws-row-main">{pull.title}</span>
              <span className="ws-row-sub">#{pull.number}{pull.draft ? ' · Draft' : ''}</span>
            </Link>
          ) : (
            <>
              <p className="ws-note">No open pull request for this branch.</p>
              {branch.location !== 'local' && (
                <Button size="small" as={Link} to={`/${github.owner}/${github.repo}/compare/${encodeURIComponent(branch.name)}`}>
                  Create pull request
                </Button>
              )}
            </>
          )}
        </Section>
      )}

      {github && (
        <Section title="Checks">
          {runs.data?.map((run) => (
            <Link key={run.id} className="ws-row ws-row-link-block" to={`/${github.owner}/${github.repo}/actions/runs/${run.id}`}>
              <span className={`ws-mark ${run.status !== 'completed' ? 'ws-run' : run.conclusion === 'success' ? 'ws-ok' : run.conclusion === 'failure' ? 'ws-bad' : ''}`} title={run.conclusion ?? run.status ?? ''}>
                {run.status !== 'completed' ? '●' : run.conclusion === 'success' ? '✓' : run.conclusion === 'failure' ? '✕' : '–'}
              </span>
              <span className="ws-row-main">
                {run.name}: {firstLine(run.display_title)}
              </span>
              <span className="ws-row-sub">
                <RelativeTime date={new Date(run.created_at)} />
              </span>
            </Link>
          ))}
          {runs.data && !runs.data.length && <p className="ws-note">No workflow runs on this branch.</p>}
          {branch.location === 'local' && <p className="ws-note">No workflow runs on this branch.</p>}
        </Section>
      )}
    </div>
  )

  const details = entry ? (
    <div className="ws-details">
      <div className="ws-details-head">
        <span className="ws-details-title text-mono">{entry.path}</span>
        <CopyButton text={entry.path} label="Copy file path" />
        <Button size="small" variant="danger" onClick={() => void discard(entry)}>
          Discard
        </Button>
      </div>
      <div className="ws-scroll ws-diff">{diff.isLoading ? <Loading /> : diff.data ? <LocalFileDiff file={diff.data} split={split} /> : <p className="ws-note">No textual changes to show.</p>}</div>
    </div>
  ) : commit ? (
    <div className="ws-details">
      <div className="ws-details-head">
        <div className="ws-details-title">
          <div className="text-bold">{firstLine(commit.subject)}</div>
          <div className="ws-row-sub">
            <span className="text-mono">{shortSha(commit.sha)}</span> · {commit.author}
            {commit.date && (
              <>
                {' · '}
                <RelativeTime date={new Date(commit.date)} />
              </>
            )}
          </div>
        </div>
        {github && !data?.local.some((c) => c.sha === commit.sha) && (
          <>
            <CopyButton text={webUrl(account.host, `/${github.owner}/${github.repo}/commit/${commit.sha}`)} label="Copy link" />
            <Button size="small" onClick={() => openExternal(webUrl(account.host, `/${github.owner}/${github.repo}/commit/${commit.sha}`))}>
              Open on GitHub
            </Button>
          </>
        )}
      </div>
      <div className="ws-scroll ws-diff">
        {shownCommit.isLoading ? (
          <Loading />
        ) : (
          <>
            {shownCommit.data && shownCommit.data.message.includes('\n') && <pre className="ws-commit-message">{shownCommit.data.message.split('\n').slice(1).join('\n').trim()}</pre>}
            {shownCommit.data?.files.map((f) => <LocalFileDiff key={f.newPath} file={f} split={split} />)}
            {shownCommit.error ? <div className="error-box">{errorMessage(shownCommit.error)}</div> : null}
          </>
        )}
      </div>
    </div>
  ) : (
    <div className="ws-empty">Pick a file or commit to see it here.</div>
  )

  return (
    <div className="ws-page">
      {local.error && (
        <Banner
          className="ws-page-error"
          variant="critical"
          title="Git said"
          description={local.error}
          primaryAction={
            <IconButton icon={XIcon} aria-label="Dismiss" variant="invisible" onClick={local.clearError} />
          }
        />
      )}
      <div className="ws-pane">
          {branch ? (
            <>
              <div className="ws-branch-head">
                <div className="ws-branch-title">
                  <span className="text-mono text-bold">{branch.name}</span>
                  <span className="ws-tag">{PLACE[branch.location]}</span>
                  {isCurrent && (
                    <span className="ws-tag ws-tag-ok">
                      <CheckIcon size={12} /> Current branch
                    </span>
                  )}
                </div>
              </div>
              <div className="ws-branch-body">
                <SplitPane id="branch-timeline" firstLabel="Timeline" secondLabel="Details" defaultWidth={420} min={280} max={800} first={timeline} second={details} />
              </div>
            </>
          ) : (
            <div className="ws-empty">{commits.isLoading ? <Loading /> : 'No branches yet. Make the first commit to start one.'}</div>
          )}
      </div>
      {dialog === 'clone' && github && <CloneDialog initial={`${github.owner}/${github.repo}`} onClose={() => setDialog(null)} onCloned={() => setDialog(null)} />}
      {dialog === 'publish' && <PublishDialog repo={repo} onClose={() => setDialog(null)} />}
    </div>
  )
}

function LocalFileDiff({ file, split }: { file: FileDiff; split: boolean }) {
  return (
    <FileDiffBox
      file={{ path: file.newPath, previousPath: file.oldPath !== file.newPath ? file.oldPath : null, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.binary ? null : file.patch }}
      split={split}
    />
  )
}
