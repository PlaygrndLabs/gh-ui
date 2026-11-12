import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Banner, Button, Checkbox, IconButton, RelativeTime, TextInput, Textarea, useConfirm } from '@primer/react'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronRightIcon, FileDiffIcon, LinkExternalIcon, LinkIcon, SparkleFillIcon, StackIcon, UndoIcon, XIcon } from '@primer/octicons-react'
import { AgentOnly, useAgentPageContext } from '../../lib/agent/AgentProvider'
import type { FileDiff } from '../../lib/diff'
import { changePaths, COMPARE_LIMIT, isStaged, isUnmerged, reorderableCommits, type HistoryRow, type LogEntry, type StatusEntry } from '../../lib/git'
import { errorMessage, useGitHub } from '../../lib/github'
import { webUrl } from '../../lib/links'
import { native, openExternal } from '../../lib/platform'
import { firstLine, plural, shortSha } from '../../lib/format'
import { readPref } from '../../lib/storage'
import { useLocalRepo, useStageError, useStageIntents, useSwitchingTo } from '../../lib/useLocalRepo'
import { useRepoQuery } from '../../lib/repo'
import { hostName, useRemoteBranches, type WorkspaceRepo } from '../../lib/workspace'
import { CopyButton, Loading } from '../../components/Bits'
import { FileDiffBox } from '../../components/DiffView'
import { SplitPane } from '../../components/SplitPane'
import { PublishDialog } from '../../components/WorkspaceHeader'
import { useTabBranch } from '../../lib/TabsProvider'
import { useCommitMenu } from './CommitMenu'
import { useCommitReorder, type GrabRow } from './CommitReorder'
import { ComparePicker } from './ComparePicker'

type Selection = { kind: 'file'; path: string } | { kind: 'commit'; sha: string } | { kind: 'range'; anchor: string; focus: string } | { kind: 'stash' } | { kind: 'compare' } | null

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
      const { generateCommitMessage } = await import('../../lib/agent/oneshot')
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
function ChangesList({ local, draft, entries, selectedPath, branchName, onSelect, onCommitted, beforeCommit }: { local: LocalRepoState; draft: CommitDraft; entries: StatusEntry[]; selectedPath: string | undefined; branchName: string; onSelect(path: string): void; onCommitted(): void; beforeCommit: ReactNode }) {
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
      <div className="ws-commit-foot">
        {beforeCommit}
        <CommitBox local={local} draft={draft} branchName={branchName} stagedCount={stagedCount} conflictCount={conflictCount} onCommitted={onCommitted} />
      </div>
    </>
  )
}

type BranchTab = 'changes' | 'history' | 'pull' | 'checks'

interface GitHubFile {
  filename: string
  previous_filename?: string
  status: string
  changes: number
  additions: number
  deletions: number
  patch?: string
}

const toFileDiff = (f: GitHubFile): FileDiff => ({ oldPath: f.previous_filename ?? f.filename, newPath: f.filename, status: f.status as FileDiff['status'], binary: !f.patch && f.changes > 0, additions: f.additions, deletions: f.deletions, patch: f.patch ?? '' })

/** One tab's content. The tab names it, so a heading only appears when there's an action to hold. */
function Section({ title, action, flush, fill, children }: { title: string; action?: ReactNode; flush?: boolean; fill?: boolean; children: ReactNode }) {
  return (
    <section className={`ws-section ${flush ? 'ws-section-flush' : ''} ${fill ? 'ws-section-fill' : ''}`} aria-label={title}>
      {action && <div className="ws-section-head">{action}</div>}
      {children}
    </section>
  )
}

/** No commit menu while one is being reordered. */
const ignoreMenu = () => {}

/** A row while a commit is being reordered: the one picked up, one it can land among, or one that has to stay put. */
type ReorderRole = 'moving' | 'movable' | 'fixed'

const CommitRow = memo(function CommitRow({ commit, selected, mark, elsewhere, role, dropLine, onSelect, onMenu, onGrab }: { commit: LogEntry; selected: boolean; mark?: '↑' | '↓'; elsewhere?: boolean; role?: ReorderRole; dropLine?: 'above' | 'below'; onSelect(sha: string, extend: boolean): void; onMenu(sha: string): void; onGrab: GrabRow }) {
  return (
    <button type="button" className={`ws-row ws-commit-row ${selected ? 'is-selected' : ''} ${role ? `is-${role}` : ''} ${dropLine ? `is-drop-${dropLine}` : ''}`} aria-pressed={selected} data-reorder={role && role !== 'fixed' ? '' : undefined} onPointerDown={role === 'moving' ? onGrab : undefined} onClick={(e) => onSelect(commit.sha, e.shiftKey || e.metaKey || e.ctrlKey)}
      onContextMenu={(e) => {
        if (!native) return
        e.preventDefault()
        onMenu(commit.sha)
      }}
    >
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
        <span className={`ws-commit-mark ${mark === '↑' ? 'is-unpushed' : ''} ${mark === '↑' && elsewhere ? 'is-elsewhere' : ''}`} title={mark === '↓' ? 'Not pulled yet' : elsewhere ? 'Not pushed to this branch yet. It came from another branch, such as main, that the remote already has.' : 'Not pushed yet'}>
          {mark === '↑' ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
        </span>
      )}
    </button>
  )
})

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
  // The tab you chose, kept as you switch branches so the view doesn't jump.
  const [chosenTab, setChosenTab] = useState<BranchTab | null>(null)
  const [notPushedOn, setNotPushedOn] = useState<string | null>(null)
  // The branch History compares with, kept as you switch branches, and which side of the difference is listed.
  const [compareWith, setCompareWith] = useState<string | null>(null)
  const [compareSide, setCompareSide] = useState<'ahead' | 'behind'>('ahead')
  const stageError = useStageError(local.ops)
  const split = readPref('diffSplit', false)
  const selectFile = useCallback((path: string) => setSelection({ kind: 'file', path }), [])
  // With nothing clicked yet, the commit on show is the newest, so that's where a range starts.
  const newestShown = useRef<string | undefined>(undefined)
  const selectCommit = useCallback((sha: string, extend: boolean) => {
    setSelection((s) => {
      if (!extend) return { kind: 'commit', sha }
      const anchor = s?.kind === 'range' ? s.anchor : s?.kind === 'commit' ? s.sha : newestShown.current
      return anchor ? { kind: 'range', anchor, focus: sha } : { kind: 'commit', sha }
    })
  }, [])
  const clearSelection = useCallback(() => setSelection(null), [])

  const remoteBranches = useRemoteBranches(repo)
  const host = hostName(repo)
  const branches = (repo.local ? local.branches.data : remoteBranches.data) ?? []
  const status = local.status.data
  // The top menu chooses: in a folder by checking out, without one by picking.
  // A branch being switched to is shown from the click: its history and the uncommitted changes are all on this Mac.
  const switchingTo = useSwitchingTo(repo.local?.id)
  const target = switchingTo ? branches.find((b) => b.name === switchingTo) : undefined
  const branch = target ?? (repo.local ? undefined : branches.find((b) => b.name === picked)) ?? branches.find((b) => b.current) ?? branches[0] ?? null
  const isCurrent = !!target || !!branch?.current
  const info = useRepoQuery(github?.owner ?? '', github?.repo ?? '', !!github)
  // Pull requests merge into the default branch, so it never has one of its own.
  const isDefault = !!branch && branch.name === info.data?.default_branch

  const commits = useQuery({
    queryKey: repo.local ? ['local-log', repo.local.id, branch?.name, branch?.sha, branch?.upstream, branch?.behind] : [key, 'workspace-commits', github?.owner, github?.repo, branch?.name],
    enabled: !!branch,
    queryFn: async () => {
      if (local.git) return local.git.branchCommits(branch!)
      const { data } = await octokit.rest.repos.listCommits({ owner: github!.owner, repo: github!.repo, sha: branch!.name, per_page: 100 })
      const remote = data.map((c): LogEntry => ({ sha: c.sha, author: c.commit.author?.name ?? c.author?.login ?? '', date: c.commit.author?.date ?? '', subject: c.commit.message, parents: c.parents.map((p) => p.sha) }))
      return { local: [] as LogEntry[], incoming: [] as LogEntry[], remote, notOnRemote: [] as string[], history: remote as HistoryRow[] }
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
    queryFn: () => local.git!.stashes(),
  })

  const mainBranch = useQuery({
    queryKey: ['local-main-branch', repo.local?.id ?? ''],
    enabled: !!local.git,
    staleTime: 300_000,
    queryFn: () => local.git!.mainBranch(),
  })
  const defaultBranch = info.data?.default_branch ?? mainBranch.data ?? null
  const base = (compareWith !== branch?.name && branches.find((b) => b.name === compareWith)) || null
  const compared = useQuery({
    queryKey: repo.local ? ['local-compare', repo.local.id, branch?.name, branch?.sha, base?.name, base?.sha] : [key, 'workspace-compare', github?.owner, github?.repo, branch?.name, base?.name],
    enabled: !!branch && !!base,
    queryFn: async () => {
      if (local.git) {
        const [ref, baseRef] = await Promise.all([local.git.compareRef(branch!), local.git.compareRef(base!, true)])
        const { ahead, behind } = await local.git.compareCommits(ref, baseRef)
        return { ref, baseRef, ahead, behind, aheadBy: ahead.length, behindBy: behind.length, files: null }
      }
      const compare = async (from: string, to: string) => (await octokit.rest.repos.compareCommitsWithBasehead({ owner: github!.owner, repo: github!.repo, basehead: `${from}...${to}` })).data
      const [a, b] = await Promise.all([compare(base!.name, branch!.name), compare(branch!.name, base!.name)])
      // GitHub lists them oldest first.
      const commitsOf = (c: typeof a) => c.commits.map((x): LogEntry => ({ sha: x.sha, author: x.commit.author?.name ?? x.author?.login ?? '', date: x.commit.author?.date ?? '', subject: x.commit.message, parents: x.parents.map((p) => p.sha) })).reverse()
      return { ref: branch!.name, baseRef: base!.name, ahead: commitsOf(a), behind: commitsOf(b), aheadBy: a.ahead_by, behindBy: a.behind_by, files: { ahead: (a.files ?? []).map(toFileDiff), behind: (b.files ?? []).map(toFileDiff) } }
    },
  })

  const entries = isCurrent ? (status?.entries ?? []) : []
  // As in GitHub Desktop, a stash belongs to the branch it was made on, and shows only there: the newest one.
  const branchStash = (isCurrent && stashes.data?.find((s) => s.branch === branch?.name)) || null
  const data = commits.data
  const shown = data?.history ?? []
  const tabShown: Record<BranchTab, boolean> = { changes: !!repo.local, history: true, pull: !!github && !isDefault, checks: !!github }
  // Until you choose a tab, or when this branch lacks the one you chose, it opens on whichever has something to do.
  const tab: BranchTab = chosenTab && tabShown[chosenTab] ? chosenTab : !repo.local ? 'history' : entries.length || branchStash ? 'changes' : data?.local.length || github || repo.remote ? 'history' : 'changes'
  // The pull request and checks tabs link elsewhere, so they leave the commit pane out.
  const commitTab = tab === 'changes' || tab === 'history'
  // With nowhere to push to, every commit is "not pushed", so saying so tells you nothing.
  const canPush = !!(github || repo.remote)
  const unpushed = canPush ? (data?.local ?? []) : []
  // Pushing the last one empties the filter, so it lets go by itself.
  const comparing = tab === 'history' && !!base
  const onlyNotPushed = !comparing && notPushedOn === branch?.name && unpushed.length > 0
  // In a comparison the commits keep their push marks on this branch's side; the other side's aren't this branch's to push or pull.
  const marks = useMemo(() => new Map(shown.map((c) => [c.sha, c])), [shown])
  const marked = useCallback((c: LogEntry): HistoryRow => ({ ...c, mark: marks.get(c.sha)?.mark, elsewhere: marks.get(c.sha)?.elsewhere }), [marks])
  const compareRows = useMemo((): HistoryRow[] => (compareSide === 'ahead' ? (compared.data?.ahead ?? []).map(marked) : (compared.data?.behind ?? [])), [compared.data, compareSide, marked])
  // Undo takes back your own newest commit, not one of main's that a fast-forward put on top.
  const undoable = isCurrent && !!data?.local.length && !!data.notOnRemote.includes(data.local[0].sha)
  const tabCommits = comparing ? compareRows : tab === 'history' && onlyNotPushed ? unpushed : commitTab ? shown : []
  const listRows = comparing ? compareRows : shown.filter((c) => !onlyNotPushed || c.mark === '↑')
  const showCompare = comparing && (selection === null || selection.kind === 'compare')
  const showStash = tab === 'changes' && selection?.kind === 'stash' && !!branchStash
  const entry = tab === 'changes' && !showStash ? (entries.find((e) => selection?.kind === 'file' && e.path === selection.path) ?? entries[0] ?? null) : null
  newestShown.current = tabCommits[0]?.sha
  // Always the commits between the two clicks, so the combined change never has gaps in it.
  const rangeEnds = selection?.kind === 'range' && tab === 'history' ? [tabCommits.findIndex((c) => c.sha === selection.anchor), tabCommits.findIndex((c) => c.sha === selection.focus)] : []
  const inRange = rangeEnds.length && Math.min(...rangeEnds) >= 0 && rangeEnds[0] !== rangeEnds[1] ? tabCommits.slice(Math.min(...rangeEnds), Math.max(...rangeEnds) + 1) : null
  const rangeShas = useMemo(() => new Set(inRange?.map((c) => c.sha)), [inRange?.[0]?.sha, inRange?.length])
  const newest = inRange?.[0]
  const oldest = inRange?.[inRange.length - 1]
  const onlyCommit = selection?.kind === 'commit' ? selection.sha : selection?.kind === 'range' ? selection.focus : null
  const commit = entry || inRange || showStash || showCompare ? null : (tabCommits.find((c) => c.sha === onlyCommit) ?? tabCommits[0] ?? null)

  const diff = useQuery({
    // The path alone: staging a file doesn't change what it differs by, so a click has no reason to reload this.
    queryKey: ['local-diff', repo.local?.id ?? '', entry?.path],
    enabled: !!entry && !!local.git,
    queryFn: () => local.git!.fileDiff(entry!),
    // What's on screen is what Discard would throw away, so edits made in another program show up here.
    staleTime: 0,
    refetchInterval: 4000,
  })
  const stashFiles = useQuery({
    queryKey: ['local-stash', repo.local?.id ?? '', 'files', branchStash?.sha],
    enabled: showStash && !!local.git,
    queryFn: () => local.git!.stashFiles(branchStash!.sha),
  })
  const shownCommit = useQuery({
    queryKey: repo.local ? ['local-show', repo.local.id, commit?.sha] : [key, 'workspace-commit', github?.owner, github?.repo, commit?.sha],
    enabled: !!commit,
    queryFn: async (): Promise<{ message: string; files: FileDiff[] }> => {
      if (local.git) return local.git.show(commit!.sha)
      const { data: c } = await octokit.rest.repos.getCommit({ owner: github!.owner, repo: github!.repo, ref: commit!.sha })
      return {
        message: c.commit.message,
        files: (c.files ?? []).map(toFileDiff),
      }
    },
  })

  const combined = useQuery({
    queryKey: repo.local ? ['local-show', repo.local.id, 'combined', oldest?.sha, newest?.sha, inRange?.length] : [key, 'workspace-combined', github?.owner, github?.repo, oldest?.sha, newest?.sha, inRange?.length],
    enabled: !!inRange,
    queryFn: async (): Promise<{ related: boolean; others: number; files: FileDiff[] }> => {
      if (local.git) return local.git.combinedDiff(inRange!.map((c) => c.sha))
      const { data: first } = await octokit.rest.repos.getCommit({ owner: github!.owner, repo: github!.repo, ref: oldest!.sha })
      const base = first.parents[0]?.sha
      if (!base) throw new Error('GitHub can’t compare from before a repository’s first commit. Leave that commit out of the selection.')
      const { data: c } = await octokit.rest.repos.compareCommitsWithBasehead({ owner: github!.owner, repo: github!.repo, basehead: `${base}...${newest!.sha}` })
      return { related: c.status === 'ahead', others: Math.max(0, c.total_commits - inRange!.length), files: (c.files ?? []).map(toFileDiff) }
    },
  })

  const compareFiles = useQuery({
    queryKey: ['local-compare-diff', repo.local?.id ?? github?.repo, compared.data?.ref, compared.data?.baseRef, compareSide, compared.dataUpdatedAt],
    enabled: showCompare && !!compared.data,
    queryFn: async (): Promise<FileDiff[]> => {
      const { ref, baseRef, files } = compared.data!
      if (files) return files[compareSide]
      return compareSide === 'ahead' ? local.git!.compareDiff(baseRef, ref) : local.git!.compareDiff(ref, baseRef)
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
      setChosenTab('changes')
    })

  // A detached HEAD has no branch to rewrite. Empty off the History tab, which ends a reorder on the way out.
  const movable = useMemo(() => (isCurrent && branch?.name !== 'HEAD' && tab === 'history' && !comparing && !local.operation.data ? reorderableCommits(shown) : []), [isCurrent, branch?.name, tab, comparing, local.operation.data, shown])
  const reorder = useCommitReorder(movable, (order) => {
    setSelection(null)
    local.op.mutate(() => local.git!.reorderCommits(order))
  })
  // The other branch's commits aren't on this one, so the menu treats them as it does commits still to pull.
  const menuRows = useMemo(() => (comparing ? [...(compared.data?.ahead ?? []).map(marked), ...(compared.data?.behind ?? []).map((c): HistoryRow => ({ ...c, mark: '↓' }))] : shown), [comparing, compared.data, shown, marked])
  const { openMenu: openCommitMenu, dialogs: commitDialogs } = useCommitMenu({ local, github, isCurrent, rows: menuRows, notOnRemote: data?.notOnRemote ?? [], undo, movable, reorder: reorder.start })

  const notPulled = data?.incoming.length ?? 0
  const tabs: Array<{ id: BranchTab; label: string; count?: number; show: boolean }> = [
    { id: 'changes', label: 'Changes', count: entries.length, show: tabShown.changes },
    { id: 'history', label: 'History', show: tabShown.history },
    { id: 'pull', label: 'Pull request', show: tabShown.pull },
    { id: 'checks', label: 'Checks', show: tabShown.checks },
  ]

  const hasChanges = isCurrent && entries.length > 0
  const stashRow = branchStash && (
    <button type="button" className={`ws-row ws-stash-row ${showStash ? 'is-selected' : ''}`} aria-pressed={showStash} onClick={() => setSelection(showStash ? null : { kind: 'stash' })}>
      <StackIcon className="ws-stash-icon" />
      <span className="ws-row-main">Stashed Changes</span>
      <ChevronRightIcon />
    </button>
  )
  const restoreStash = (sha: string) =>
    local.op.mutate(async () => {
      await local.git!.restoreStash(sha)
      setSelection(null)
    })
  const discardStash = async (sha: string) => {
    if (await confirm({ title: 'Discard stashed changes?', content: 'The changes in this stash will be lost. This can’t be undone.', confirmButtonType: 'danger', confirmButtonContent: 'Discard' }))
      local.op.mutate(async () => {
        await local.git!.dropStash(sha)
        setSelection(null)
      })
  }

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
                setChosenTab(t.id)
                setSelection(null)
              }}
            >
              {t.label}
              {!!t.count && <span className="ws-pill">{t.count}</span>}
              {t.id === 'history' && unpushed.length > 0 && (
                <span className="ws-pill ws-sync-count is-unpushed" title={plural(unpushed.length, 'commit') + ' not pushed'}>
                  <ArrowUpIcon size={12} />
                  {unpushed.length}
                </span>
              )}
              {t.id === 'history' && notPulled > 0 && (
                <span className="ws-pill ws-sync-count" title={plural(notPulled, 'commit') + ' not pulled'}>
                  <ArrowDownIcon size={12} />
                  {notPulled}
                </span>
              )}
            </button>
          ))}
      </div>
      <div className="ws-scroll" role="tabpanel">
        {tab === 'changes' && (
          <Section title="Changes" flush fill>
            {hasChanges ? (
              <ChangesList local={local} draft={draft} entries={entries} selectedPath={entry?.path} branchName={branch.name} onSelect={selectFile} onCommitted={clearSelection} beforeCommit={stashRow} />
            ) : (
              <>
                {isCurrent && <p className="ws-note">No uncommitted changes.</p>}
                {stashRow}
              </>
            )}
          </Section>
        )}

        {tab === 'history' && (
          <Section
            title="History"
            flush
            action={
              reorder.moving ? (
                <>
                  <span className="ws-reorder-hint">Drag this commit to its new place</span>
                  <Button size="small" className="ws-history-end" onClick={reorder.cancel}>
                    Cancel
                  </Button>
                </>
              ) : unpushed.length > 0 || undoable || branches.length > 1 ? (
                <>
                  {unpushed.length > 0 && !comparing && (
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
                  {branches.length > 1 && (
                    <ComparePicker
                      branches={branches.filter((b) => b.name !== branch.name)}
                      value={base?.name ?? null}
                      defaultBranch={defaultBranch}
                      onChange={(name) => {
                        setCompareWith(name)
                        setCompareSide('ahead')
                        setSelection(null)
                      }}
                    />
                  )}
                  {comparing && (
                    <IconButton
                      size="small"
                      variant="invisible"
                      icon={XIcon}
                      className="ws-compare-stop"
                      aria-label="Stop comparing"
                      onClick={() => {
                        setCompareWith(null)
                        setSelection(null)
                      }}
                    />
                  )}
                  {/* While comparing, the branch name needs the room, so Undo keeps only its icon. */}
                  {undoable &&
                    (comparing ? (
                      <IconButton size="small" variant="invisible" icon={UndoIcon} className="ws-history-end" aria-label="Undo last commit" onClick={() => undo(data.local[0].subject)} />
                    ) : (
                      <Button size="small" variant="invisible" leadingVisual={UndoIcon} className="ws-history-end" onClick={() => undo(data.local[0].subject)}>
                        Undo last commit
                      </Button>
                    ))}
                </>
              ) : undefined
            }
          >
            {comparing && base && (
              <>
                <div className="ws-compare-bar" role="group" aria-label={`Compare ${branch.name} with ${base.name}`}>
                  {(['ahead', 'behind'] as const).map((side) => {
                    const name = side === 'ahead' ? branch.name : base.name
                    const count = compared.data ? (side === 'ahead' ? compared.data.aheadBy : compared.data.behindBy) : null
                    const capped = count !== null && !compared.data?.files && count >= COMPARE_LIMIT
                    return (
                      <button
                        key={side}
                        type="button"
                        className="ws-history-filter ws-compare-side"
                        aria-pressed={compareSide === side}
                        title={`${count === null ? 'Commits' : `${plural(count, 'commit')}${capped ? ' or more' : ''}`} on ${name} that ${side === 'ahead' ? base.name : branch.name} doesn’t have`}
                        aria-label={`Only on ${name}`}
                        onClick={() => {
                          setCompareSide(side)
                          setSelection(null)
                        }}
                      >
                        {side === 'ahead' ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
                        <span className="ws-compare-name">{name}</span>
                        {count !== null && <span className="ws-pill">{capped ? `${count}+` : count}</span>}
                      </button>
                    )
                  })}
                </div>
                {compared.isLoading && <Loading />}
                {compared.error ? <div className="error-box ws-section-pad">{errorMessage(compared.error)}</div> : null}
                {compared.data && !!compareRows.length && (
                  <button type="button" className={`ws-row ws-compare-row ${showCompare ? 'is-selected' : ''}`} aria-pressed={showCompare} onClick={() => setSelection({ kind: 'compare' })}>
                    <FileDiffIcon className="ws-compare-icon" />
                    <span className="ws-row-main">All changes</span>
                    <span className="ws-row-sub">{compareSide === 'ahead' ? `${branch.name} since it left ${base.name}` : `${base.name} since ${branch.name} left it`}</span>
                  </button>
                )}
                {compared.data && !compareRows.length && <p className="ws-note">{compareSide === 'ahead' ? `${branch.name} has no commits that ${base.name} doesn’t have.` : `${branch.name} is up to date with ${base.name}.`}</p>}
              </>
            )}
            {listRows.map((c, i) => (
              <CommitRow key={c.sha} commit={c} mark={c.mark === '↑' && !canPush ? undefined : c.mark} elsewhere={c.elsewhere} selected={inRange ? rangeShas.has(c.sha) : commit?.sha === c.sha} role={!reorder.moving ? undefined : c.sha === reorder.moving ? 'moving' : i < movable.length ? 'movable' : 'fixed'} dropLine={i >= movable.length ? undefined : reorder.dropGap === i ? 'above' : reorder.dropGap === i + 1 && i === movable.length - 1 ? 'below' : undefined} onSelect={selectCommit} onMenu={reorder.moving ? ignoreMenu : openCommitMenu} onGrab={reorder.grab} />
            ))}
            {comparing && compared.data && compareRows.length < (compareSide === 'ahead' ? compared.data.aheadBy : compared.data.behindBy) && <p className="ws-note">Showing the newest {compareRows.length}.</p>}
            {!comparing && data && !shown.length && <p className="ws-note">No commits on this branch yet.</p>}
            {!comparing && canPush && branch.location === 'local' && <p className="ws-note">This branch isn’t on {host} yet.</p>}
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

  const details = showStash && branchStash ? (
    <div className="ws-details">
      <div className="ws-details-head ws-stash-head">
        <div className="ws-details-title">
          <div className="ws-stash-title">Stashed changes</div>
          <div className="ws-stash-actions">
            <Button size="small" disabled={local.op.isPending} onClick={() => void discardStash(branchStash.sha)}>
              Discard
            </Button>
            <Button size="small" variant="primary" loading={local.op.isPending} onClick={() => restoreStash(branchStash.sha)}>
              Restore
            </Button>
            <span className="ws-row-sub">
              <strong>Restore</strong> will move your stashed files to the Changes list.
            </span>
          </div>
        </div>
      </div>
      {stashFiles.isLoading ? (
        <div className="ws-scroll ws-diff">
          <Loading />
        </div>
      ) : stashFiles.data?.length ? (
        <CommitFiles key={branchStash.sha} files={stashFiles.data} split={split} message="" />
      ) : (
        <div className="ws-scroll ws-diff">
          {stashFiles.data && <p className="ws-note">This stash has no file changes.</p>}
          {stashFiles.error ? <div className="error-box">{errorMessage(stashFiles.error)}</div> : null}
        </div>
      )}
    </div>
  ) : entry ? (
    <div className="ws-details">
      <div className="ws-details-head">
        <span className="ws-details-title text-mono">{entry.path}</span>
        <CopyButton text={entry.path} label="Copy file path" />
        <Button size="small" variant="danger" onClick={() => void discard(entry)}>
          Discard
        </Button>
      </div>
      <div className="ws-scroll ws-diff">{diff.isLoading ? <Loading /> : diff.data ? <LocalFileDiff file={diff.data} split={split} eager /> : <p className="ws-note">No textual changes to show.</p>}</div>
    </div>
  ) : showCompare && base && branch ? (
    <div className="ws-details">
      <div className="ws-details-head">
        <div className="ws-details-title">
          <div className="text-bold">{compareSide === 'ahead' ? `What ${branch.name} changes` : `What ${base.name} changed`}</div>
          <div className="ws-row-sub">
            {compareSide === 'ahead' ? `Since it left ${base.name}, as a pull request into ${base.name} shows it` : `Since ${branch.name} left it`}
            {compared.data && (
              <>
                {' · '}
                <span className="text-mono">{compareSide === 'ahead' ? `${compared.data.baseRef}...${compared.data.ref}` : `${compared.data.ref}...${compared.data.baseRef}`}</span>
              </>
            )}
          </div>
        </div>
      </div>
      {compared.isLoading || compareFiles.isLoading ? (
        <div className="ws-scroll ws-diff">
          <Loading />
        </div>
      ) : compareFiles.data?.length ? (
        <CommitFiles key={`compare-${base.name}-${compareSide}`} files={compareFiles.data} split={split} message="" />
      ) : (
        <div className="ws-scroll ws-diff">
          {compareFiles.data && <p className="ws-note">No file changes.</p>}
          {compareFiles.error ? <div className="error-box">{errorMessage(compareFiles.error)}</div> : null}
        </div>
      )}
    </div>
  ) : inRange ? (
    <div className="ws-details">
      <div className="ws-details-head">
        <div className="ws-details-title">
          <div className="text-bold">{plural(inRange.length, 'commit')} selected</div>
          <div className="ws-row-sub">
            Combined changes, <span className="text-mono">{shortSha(oldest!.sha)}</span> to <span className="text-mono">{shortSha(newest!.sha)}</span>
            {!!combined.data?.others && ` · Includes ${plural(combined.data.others, 'more commit')} from merges`}
          </div>
        </div>
      </div>
      {combined.isLoading ? (
        <div className="ws-scroll ws-diff">
          <Loading />
        </div>
      ) : combined.data?.files.length ? (
        <CommitFiles key={`${oldest!.sha}-${newest!.sha}`} files={combined.data.files} split={split} message="" />
      ) : (
        <div className="ws-scroll ws-diff">
          {combined.data && <p className="ws-note">{combined.data.related ? 'These commits add up to no change.' : 'These commits aren’t on one line of history, so they have no combined change. Select commits from one side only.'}</p>}
          {combined.error ? <div className="error-box">{errorMessage(combined.error)}</div> : null}
        </div>
      )}
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
        {github && !data?.notOnRemote.includes(commit.sha) && (
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
                  <span className="text-mono text-bold">{branch.name === 'HEAD' ? `Detached at ${shortSha(branch.sha)}` : branch.name}</span>
                  {isCurrent && branch.name !== 'HEAD' && (
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
      {commitDialogs}
    </div>
  )
}

// A diff can be thousands of table rows. It only redraws when the diff itself changes.
const LocalFileDiff = memo(function LocalFileDiff({ file, split, eager }: { file: FileDiff; split: boolean; eager?: boolean }) {
  return (
    <FileDiffBox
      eager={eager}
      file={{ path: file.newPath, previousPath: file.oldPath !== file.newPath ? file.oldPath : null, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.binary ? null : file.patch }}
      split={split}
    />
  )
})

/** The ones you see first don't wait for the observer, which would leave them blank for a frame. */
const EAGER_FILES = 3

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
    let frame = 0
    const markFileInView = () => {
      frame = 0
      if (jumpedTo.current !== null && Math.abs(el.scrollTop - jumpedTo.current) < 2) return
      jumpedTo.current = null
      const top = el.getBoundingClientRect().top + 24
      const boxes = [...el.querySelectorAll<HTMLElement>('[data-file-index]')]
      let at = 0
      for (const b of boxes) if (b.getBoundingClientRect().top <= top) at = Number(b.dataset.fileIndex)
      setCurrent(at)
    }
    // At most once a frame: a trackpad sends several of these for each one.
    const onScroll = () => {
      frame ||= requestAnimationFrame(markFileInView)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
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

  // The file in view changes on every scroll; what's drawn doesn't.
  const diffs = useMemo(
    () => (
      <div className="ws-scroll ws-diff" ref={scroller}>
        {body && <pre className="ws-commit-message">{body}</pre>}
        {files.map((f, i) => (
          <div key={f.newPath} data-file-index={i}>
            <LocalFileDiff file={f} split={split} eager={i < EAGER_FILES} />
          </div>
        ))}
      </div>
    ),
    [files, split, body],
  )

  return <SplitPane id="commit-files" firstLabel="Changed files" secondLabel="Diff" defaultWidth={260} min={160} max={520} first={list} second={diffs} />
}
