import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Banner, Button, Checkbox, IconButton, RelativeTime, TextInput, Textarea, useConfirm } from '@primer/react'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, LinkExternalIcon, LinkIcon, SparkleFillIcon, UndoIcon, XIcon } from '@primer/octicons-react'
import { AgentOnly, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { generateCommitMessage } from '../../lib/agent/oneshot'
import type { FileDiff } from '../../lib/diff'
import { changePaths, isStaged, isUnmerged, type LogEntry, type StatusEntry } from '../../lib/git'
import { errorMessage, useGitHub } from '../../lib/github'
import { webUrl } from '../../lib/links'
import { openExternal } from '../../lib/platform'
import { firstLine, shortSha } from '../../lib/format'
import { readPref } from '../../lib/storage'
import { useLocalRepo, useStageError, useStageIntents } from '../../lib/useLocalRepo'
import { useRepoQuery } from '../../lib/repo'
import { hostName, useRemoteBranches, type WorkspaceRepo } from '../../lib/workspace'
import { CopyButton, Loading } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { SplitPane } from '../../components/SplitPane'
import { PublishDialog } from '../../components/WorkspaceHeader'
import { useTabBranch } from '../../lib/TabsProvider'

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

type LocalRepoState = ReturnType<typeof useLocalRepo>

interface DraftText {
  summary: string
  description: string
}

/** The commit message being written. It outlives the Changes tab, and typing in it redraws only the commit box. */
function createCommitDraft() {
  let text: DraftText = { summary: '', description: '' }
  const listeners = new Set<() => void>()
  return {
    get: () => text,
    set(change: Partial<DraftText>) {
      text = { ...text, ...change }
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

type CommitDraft = ReturnType<typeof createCommitDraft>

const ChangeRow = memo(function ChangeRow({ entry, staged, selected, onToggle, onSelect }: { entry: StatusEntry; staged: boolean; selected: boolean; onToggle(entry: StatusEntry, staged: boolean): void; onSelect(path: string): void }) {
  return (
    <div className={`ws-row ws-row-file ${selected ? 'is-selected' : ''}`}>
      <Checkbox checked={staged} aria-label={isUnmerged(entry) ? `Mark ${entry.path} as resolved` : `Stage ${entry.path}`} onChange={() => onToggle(entry, !staged)} />
      <button type="button" className="ws-row-link text-mono" title={entry.path} onClick={() => onSelect(entry.path)}>
        {entry.path}
      </button>
      <ChangeBadge e={entry} />
    </div>
  )
})

function CommitBox({ local, draft, branchName, stagedCount, conflictCount, onCommitted }: { local: LocalRepoState; draft: CommitDraft; branchName: string; stagedCount: number; conflictCount: number; onCommitted(): void }) {
  const { account } = useGitHub()
  const { summary, description } = useSyncExternalStore(draft.subscribe, draft.get)
  const [genError, setGenError] = useState<string | null>(null)
  const generate = useMutation({
    mutationFn: async () => {
      // In the queue, so it sees the boxes just ticked.
      const staged = await local.ops!.run(() => local.git!.stagedDiff())
      if (!staged.trim()) throw new Error('Stage some changes first.')
      return generateCommitMessage(staged, account)
    },
    onSuccess: (m) => {
      setGenError(null)
      draft.set({ summary: m.summary, description: m.description })
    },
    onError: (e) => setGenError(errorMessage(e)),
  })
  const commitWork = () =>
    local.op.mutate(async () => {
      await local.git!.commit(summary, description)
      draft.set({ summary: '', description: '' })
      onCommitted()
    })
  return (
    <div className="ws-commit">
      <div className="ws-commit-line">
        <TextInput block placeholder="Summary (required)" aria-label="Commit summary" value={summary} onChange={(e) => draft.set({ summary: e.target.value })} />
        <AgentOnly><IconButton icon={SparkleFillIcon} aria-label="Write commit message with Claude" description={stagedCount ? 'Write it with Claude' : 'Stage some changes first'} loading={generate.isPending} disabled={!stagedCount} onClick={() => generate.mutate()} /></AgentOnly>
      </div>
      <Textarea block rows={2} placeholder="Description" aria-label="Commit description" value={description} onChange={(e) => draft.set({ description: e.target.value })} />
      {genError && <div className="error-box">{genError}</div>}
      <Button variant="primary" block disabled={!summary.trim() || !stagedCount || conflictCount > 0} loading={local.op.isPending} onClick={commitWork}>
        Commit {stagedCount ? `${stagedCount} file${stagedCount === 1 ? '' : 's'} ` : ''}to {branchName}
      </Button>
    </div>
  )
}

/** The changed files and the commit box. A box shows the click at once; git catches up behind it (lib/repoOps.ts). */
function ChangesList({ local, draft, entries, selectedPath, branchName, onSelect, onCommitted }: { local: LocalRepoState; draft: CommitDraft; entries: StatusEntry[]; selectedPath: string | undefined; branchName: string; onSelect(path: string): void; onCommitted(): void }) {
  const confirm = useConfirm()
  const intents = useStageIntents(local.ops)
  const { setStaged } = local
  const stagedOf = (e: StatusEntry) => intents.get(e.path)?.staged ?? isStaged(e)
  const stagedCount = entries.filter(stagedOf).length
  const conflictCount = entries.filter(isUnmerged).length
  const onToggle = useCallback((entry: StatusEntry, staged: boolean) => setStaged([entry], staged), [setStaged])
  const toggleAll = async () => {
    if (stagedCount === entries.length) return setStaged(entries, false)
    if (
      conflictCount &&
      !(await confirm({
        title: 'Mark conflicts as resolved?',
        content: `Staging all changes also marks ${conflictCount} conflicted file${conflictCount === 1 ? '' : 's'} as resolved. Make sure no conflict markers are left.`,
        confirmButtonContent: 'Stage all',
      }))
    )
      return
    setStaged(entries, true)
  }
  return (
    <>
      <label className="ws-row ws-row-check">
        <Checkbox checked={stagedCount === entries.length} indeterminate={stagedCount > 0 && stagedCount < entries.length} onChange={() => void toggleAll()} aria-label="Stage all" />
        <span className="ws-row-sub">
          {stagedCount} of {entries.length} staged{conflictCount ? `, ${conflictCount} with conflicts` : ''}
        </span>
      </label>
      {entries.map((e) => (
        <ChangeRow key={e.path} entry={e} staged={stagedOf(e)} selected={selectedPath === e.path} onToggle={onToggle} onSelect={onSelect} />
      ))}
      <CommitBox local={local} draft={draft} branchName={branchName} stagedCount={stagedCount} conflictCount={conflictCount} onCommitted={onCommitted} />
    </>
  )
}

type BranchTab = 'changes' | 'history' | 'pull' | 'checks'

/** One tab's content. The tab names it, so a heading only appears when there's an action to hold. */
function Section({ title, action, flush, children }: { title: string; action?: ReactNode; flush?: boolean; children: ReactNode }) {
  return (
    <section className={`ws-section ${flush ? 'ws-section-flush' : ''}`} aria-label={title}>
      {action && <div className="ws-section-head">{action}</div>}
      {children}
    </section>
  )
}

function CommitRow({ commit, selected, mark, onSelect }: { commit: LogEntry; selected: boolean; mark?: '↑' | '↓'; onSelect(): void }) {
  return (
    <button type="button" className={`ws-row ws-commit-row ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={onSelect}>
      <span className="ws-commit-text">
        <span className="ws-commit-subject">{firstLine(commit.subject)}</span>
        <span className="ws-row-sub">
          {commit.author}
          {commit.date && (
            <>
              {' · '}
              <RelativeTime date={new Date(commit.date)} />
            </>
          )}
        </span>
      </span>
      {mark && (
        <span className={`ws-commit-mark ${mark === '↑' ? 'is-unpushed' : ''}`} title={mark === '↑' ? 'Not pushed yet' : 'Not pulled yet'}>
          {mark === '↑' ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
        </span>
      )}
    </button>
  )
}

/** A repository's front page in the desktop app: everything about the branch chosen in the top menu, a tab at a time. */
export function BranchesWorkspace({ repo }: { repo: WorkspaceRepo }) {
  const { octokit, key, account } = useGitHub()
  const local = useLocalRepo(repo.local)
  const confirm = useConfirm()
  const github = repo.github && repo.github.host.toLowerCase() === account.host.toLowerCase() ? repo.github : null
  const { picked } = useTabBranch()
  const [selection, setSelection] = useState<Selection>(null)
  const [draft] = useState(createCommitDraft)
  const [dialog, setDialog] = useState<'publish' | null>(null)
  const [chosenTab, setChosenTab] = useState<{ branch: string; tab: BranchTab } | null>(null)
  const [notPushedOn, setNotPushedOn] = useState<string | null>(null)
  const stageError = useStageError(local.ops)
  const split = readPref('diffSplit', false)
  const selectFile = useCallback((path: string) => setSelection({ kind: 'file', path }), [])
  const clearSelection = useCallback(() => setSelection(null), [])

  const remoteBranches = useRemoteBranches(repo)
  const host = hostName(repo)
  const branches = (repo.local ? local.branches.data : remoteBranches.data) ?? []
  const status = local.status.data
  // The top menu chooses: in a folder by checking out, without one by picking.
  const branch = (repo.local ? undefined : branches.find((b) => b.name === picked)) ?? branches.find((b) => b.current) ?? branches[0] ?? null
  const isCurrent = !!branch?.current
  const info = useRepoQuery(github?.owner ?? '', github?.repo ?? '', !!github)
  // Pull requests merge into the default branch, so it never has one of its own.
  const isDefault = !!branch && branch.name === info.data?.default_branch

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
  const data = commits.data
  const shown = [...(data?.local ?? []), ...(data?.incoming ?? []), ...(data?.remote ?? [])]
  // Until you choose a tab, this branch opens on whichever has something to do.
  const tab: BranchTab = chosenTab && chosenTab.branch === branch?.name && !(chosenTab.tab === 'pull' && isDefault) ? chosenTab.tab : !repo.local ? 'history' : entries.length || stashes.data?.length ? 'changes' : data?.local.length || github || repo.remote ? 'history' : 'changes'
  // The pull request and checks tabs link elsewhere, so they leave the commit pane out.
  const commitTab = tab === 'changes' || tab === 'history'
  // With nowhere to push to, every commit is "not pushed", so saying so tells you nothing.
  const canPush = !!(github || repo.remote)
  const unpushed = canPush ? (data?.local ?? []) : []
  // Pushing the last one empties the filter, so it lets go by itself.
  const onlyNotPushed = notPushedOn === branch?.name && unpushed.length > 0
  const tabCommits = tab === 'history' && onlyNotPushed ? unpushed : commitTab ? shown : []
  const entry = tab === 'changes' ? (entries.find((e) => selection?.kind === 'file' && e.path === selection.path) ?? entries[0] ?? null) : null
  const commit = entry ? null : (tabCommits.find((c) => selection?.kind === 'commit' && c.sha === selection.sha) ?? tabCommits[0] ?? null)

  const diff = useQuery({
    // The path alone: staging a file doesn't change what it differs by, so a click has no reason to reload this.
    queryKey: ['local-diff', repo.local?.id ?? '', entry?.path],
    enabled: !!entry && !!local.git,
    queryFn: () => local.git!.fileDiff(entry!),
    // What's on screen is what Discard would throw away, so edits made in another program show up here.
    staleTime: 0,
    refetchInterval: 4000,
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

  useAgentPageContext({
    tabTitle: repo.name,
    label: `the branches of ${github ? `${github.owner}/${github.repo}` : repo.name}${repo.local ? ` with a local folder at ${repo.local.path}` : ''}`,
    owner: github?.owner,
    repo: github?.repo,
    details: { branch: branch?.name, where: branch ? { both: `On this Mac and ${host}`, local: 'Only on this Mac', remote: `Only on ${host}` }[branch.location] : undefined, ahead: branch?.ahead, behind: branch?.behind, changed_files: repo.local ? entries.length : undefined, note: repo.local ? 'Agent GitHub tools see only pushed code, not local changes.' : undefined },
  })

  const discard = async (e: StatusEntry) => {
    const paths = changePaths(e)
    const from = paths.length > 1 ? ` (renamed from ${paths[0]})` : ''
    if (await confirm({ title: 'Discard changes?', content: `Your changes to ${e.path}${from} will be lost.`, confirmButtonType: 'danger', confirmButtonContent: 'Discard' })) local.op.mutate(() => local.git!.discard(e))
  }
  const undo = (subject: string) =>
    local.op.mutate(async () => {
      await local.git!.undoCommit()
      draft.set({ summary: firstLine(subject) })
      setSelection(null)
      // The commit's files and message are back in Changes, so show them there.
      if (branch) setChosenTab({ branch: branch.name, tab: 'changes' })
    })

  const tabs: Array<{ id: BranchTab; label: string; count?: number; show: boolean }> = [
    { id: 'changes', label: 'Changes', count: entries.length, show: !!repo.local },
    { id: 'history', label: 'History', show: true },
    { id: 'pull', label: 'Pull request', show: !!github && !isDefault },
    { id: 'checks', label: 'Checks', show: !!github },
  ]

  const timeline = branch && (
    <div className="ws-branch-timeline">
      <div className="ws-subtabs ws-branch-tabs" role="tablist" aria-label={`About ${branch.name}`}>
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="ws-tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setChosenTab({ branch: branch.name, tab: t.id })
                setSelection(null)
              }}
            >
              {t.label}
              {!!t.count && <span className="ws-pill">{t.count}</span>}
            </button>
          ))}
      </div>
      <div className="ws-scroll" role="tabpanel">
        {tab === 'changes' && (
          <Section title="Changes" flush>
            {isCurrent && entries.length > 0 && <ChangesList local={local} draft={draft} entries={entries} selectedPath={entry?.path} branchName={branch.name} onSelect={selectFile} onCommitted={clearSelection} />}
            {isCurrent && !entries.length && <p className="ws-note">No uncommitted changes.</p>}
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
        )}

        {tab === 'history' && (
          <Section
            title="History"
            flush
            action={
              unpushed.length > 0 || (isCurrent && !!data?.local.length) ? (
                <>
                  {unpushed.length > 0 && (
                    <button
                      type="button"
                      className="ws-history-filter"
                      aria-pressed={onlyNotPushed}
                      onClick={() => {
                        setNotPushedOn(onlyNotPushed ? null : branch.name)
                        setSelection(null)
                      }}
                    >
                      <ArrowUpIcon size={12} />
                      Not pushed
                      <span className="ws-pill">{unpushed.length}</span>
                    </button>
                  )}
                  {isCurrent && !!data?.local.length && (
                    <Button size="small" variant="invisible" leadingVisual={UndoIcon} className="ws-history-end" onClick={() => undo(data.local[0].subject)}>
                      Undo last commit
                    </Button>
                  )}
                </>
              ) : undefined
            }
          >
            {data?.local.map((c) => <CommitRow key={c.sha} commit={c} mark={canPush ? '↑' : undefined} selected={commit?.sha === c.sha} onSelect={() => setSelection({ kind: 'commit', sha: c.sha })} />)}
            {!onlyNotPushed && data?.incoming.map((c) => <CommitRow key={c.sha} commit={c} mark="↓" selected={commit?.sha === c.sha} onSelect={() => setSelection({ kind: 'commit', sha: c.sha })} />)}
            {!onlyNotPushed && data?.remote.map((c) => <CommitRow key={c.sha} commit={c} selected={commit?.sha === c.sha} onSelect={() => setSelection({ kind: 'commit', sha: c.sha })} />)}
            {data && !shown.length && <p className="ws-note">No commits on this branch yet.</p>}
            {canPush && branch.location === 'local' && <p className="ws-note">This branch isn’t on {host} yet.</p>}
          </Section>
        )}

        {github && tab === 'pull' && (
          <Section title="Pull request" flush>
            {pull ? (
              <Link className="ws-row ws-row-link-block" to={`/${github.owner}/${github.repo}/pull/${pull.number}`}>
                <span className="ws-row-main">{pull.title}</span>
                <span className="ws-row-sub">#{pull.number}{pull.draft ? ' · Draft' : ''}</span>
              </Link>
            ) : (
              <>
                <p className="ws-note">No open pull request for this branch.</p>
                {branch.location !== 'local' && (
                  <div className="ws-section-pad">
                    <Button size="small" as={Link} to={`/${github.owner}/${github.repo}/compare/${encodeURIComponent(branch.name)}`}>
                      Create pull request
                    </Button>
                  </div>
                )}
              </>
            )}
          </Section>
        )}

        {github && tab === 'checks' && (
          <Section title="Checks" flush>
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
            {/* The same icons as the tab row, which has none of its own on this tab. */}
            <CopyButton text={webUrl(account.host, `/${github.owner}/${github.repo}/commit/${commit.sha}`)} icon={LinkIcon} label="Copy link to commit" />
            <IconButton size="small" variant="invisible" icon={LinkExternalIcon} aria-label="Open commit in browser" onClick={() => openExternal(webUrl(account.host, `/${github.owner}/${github.repo}/commit/${commit.sha}`))} />
          </>
        )}
      </div>
      {shownCommit.isLoading ? (
        <div className="ws-scroll ws-diff">
          <Loading />
        </div>
      ) : shownCommit.data?.files.length ? (
        <CommitFiles key={commit.sha} files={shownCommit.data.files} split={split} message={shownCommit.data.message} />
      ) : (
        <div className="ws-scroll ws-diff">
          {shownCommit.data && shownCommit.data.message.includes('\n') && <pre className="ws-commit-message">{shownCommit.data.message.split('\n').slice(1).join('\n').trim()}</pre>}
          {shownCommit.data && <p className="ws-note">No file changes in this commit.</p>}
          {shownCommit.error ? <div className="error-box">{errorMessage(shownCommit.error)}</div> : null}
        </div>
      )}
    </div>
  ) : (
    <div className="ws-empty">Pick a file or commit to see it here.</div>
  )

  return (
    <div className="ws-page">
      {(local.error ?? stageError) && (
        <Banner
          className="ws-page-error"
          variant="critical"
          title="Git said"
          description={local.error ?? stageError}
          primaryAction={
            <IconButton
              icon={XIcon}
              aria-label="Dismiss"
              variant="invisible"
              onClick={() => {
                local.clearError()
                local.ops?.clearError()
              }}
            />
          }
        />
      )}
      <div className="ws-pane">
          {branch ? (
            <>
              <div className="ws-branch-head">
                <div className="ws-branch-title">
                  <span className="text-mono text-bold">{branch.name}</span>
                  {isCurrent && (
                    <span className="ws-tag ws-tag-ok">
                      <CheckIcon size={12} /> Current branch
                    </span>
                  )}
                </div>
                {repo.location === 'local' && (
                  <Button size="small" variant="primary" onClick={() => setDialog('publish')}>
                    Publish repository
                  </Button>
                )}
              </div>
              <div className="ws-branch-body">
                {commitTab ? <SplitPane id="branch-timeline" firstLabel="Timeline" secondLabel="Details" defaultWidth={420} min={280} max={800} first={timeline} second={details} /> : timeline}
              </div>
            </>
          ) : (
            <div className="ws-empty">{commits.isLoading ? <Loading /> : 'No branches yet. Make the first commit to start one.'}</div>
          )}
      </div>
      {dialog === 'publish' && <PublishDialog repo={repo} onClose={() => setDialog(null)} />}
    </div>
  )
}

// A diff can be thousands of table rows. It only redraws when the diff itself changes.
const LocalFileDiff = memo(function LocalFileDiff({ file, split }: { file: FileDiff; split: boolean }) {
  return (
    <FileDiffBox
      file={{ path: file.newPath, previousPath: file.oldPath !== file.newPath ? file.oldPath : null, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.binary ? null : file.patch }}
      split={split}
    />
  )
})

const STATUS_MARK: Partial<Record<FileDiff['status'], { code: string; color: string; title: string }>> = {
  added: { code: 'A', color: 'fg-success', title: 'Added' },
  removed: { code: 'D', color: 'fg-danger', title: 'Deleted' },
  renamed: { code: 'R', color: 'fg-accent', title: 'Renamed' },
  copied: { code: 'C', color: 'fg-accent', title: 'Copied' },
}

/** A commit's changed files beside all of their diffs, as in GitHub Desktop: picking a file scrolls to it, and scrolling marks the file in view. */
function CommitFiles({ files, split, message }: { files: FileDiff[]; split: boolean; message: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [current, setCurrent] = useState(0)
  // Where a click scrolled to: until you scroll away from it, the clicked file stays marked, even one too short to reach the top.
  const jumpedTo = useRef<number | null>(null)
  const body = message.includes('\n') ? message.split('\n').slice(1).join('\n').trim() : ''

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      if (jumpedTo.current !== null && Math.abs(el.scrollTop - jumpedTo.current) < 2) return
      jumpedTo.current = null
      const top = el.getBoundingClientRect().top + 24
      const boxes = [...el.querySelectorAll<HTMLElement>('[data-file-index]')]
      let at = 0
      for (const b of boxes) if (b.getBoundingClientRect().top <= top) at = Number(b.dataset.fileIndex)
      setCurrent(at)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const show = (i: number) => {
    const el = scroller.current
    const box = el?.querySelector<HTMLElement>(`[data-file-index="${i}"]`)
    if (!el || !box) return
    el.scrollTop += box.getBoundingClientRect().top - el.getBoundingClientRect().top - 12
    jumpedTo.current = el.scrollTop
    setCurrent(i)
  }

  const list = (
    <div className="ws-commit-files">
      <div className="ws-commit-files-head">
        {files.length} changed {files.length === 1 ? 'file' : 'files'}
      </div>
      <div className="ws-scroll">
        {files.map((f, i) => {
          const mark = STATUS_MARK[f.status] ?? { code: 'M', color: 'fg-attention', title: 'Modified' }
          const slash = f.newPath.lastIndexOf('/')
          return (
            <button key={f.newPath} type="button" className={`ws-row ws-file-row ${i === current ? 'is-selected' : ''}`} aria-pressed={i === current} title={f.newPath} onClick={() => show(i)}>
              <span className="ws-file-path">
                {slash > 0 && <span className="ws-file-dir">{f.newPath.slice(0, slash + 1)}</span>}
                <span className="ws-file-name">{f.newPath.slice(slash + 1)}</span>
              </span>
              <span className={`text-mono text-small text-bold ${mark.color}`} title={mark.title}>
                {mark.code}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const diffs = (
    <div className="ws-scroll ws-diff" ref={scroller}>
      {body && <pre className="ws-commit-message">{body}</pre>}
      {files.map((f, i) => (
        <div key={f.newPath} data-file-index={i}>
          <LocalFileDiff file={f} split={split} />
        </div>
      ))}
    </div>
  )

  return <SplitPane id="commit-files" firstLabel="Changed files" secondLabel="Diff" defaultWidth={260} min={160} max={520} first={list} second={diffs} />
}
