import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActionList, ActionMenu, Banner, Button, Checkbox, CounterLabel, Dialog, FormControl, IconButton, Label, ProgressBar, Radio, RadioGroup, TextInput, Textarea, TreeView, useConfirm } from '@primer/react'
import {
  DiffAddedIcon,
  DiffModifiedIcon,
  DiffRemovedIcon,
  DiffRenamedIcon,
  FileIcon,
  SearchIcon,
  SparkleFillIcon,
  TrashIcon,
  FileDirectoryFillIcon,
  GearIcon,
  KebabHorizontalIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  TriangleDownIcon,
} from '@primer/octicons-react'
import {
  useGitHub,
  errorMessage,
  setThreadResolved,
  addPendingThread,
  addPendingReply,
  updatePendingComment,
  deletePendingComment,
  submitPendingReview,
  deletePendingReview,
  type PendingReview,
  type PendingReviewComment,
  type PullFile,
  type PullRequest,
} from '../../../lib/github'
import { useRepo, encodePath } from '../../../lib/repo'
import { useAgent } from '../../../lib/agent/AgentProvider'
import { readPref, useSharedPref, writePref } from '../../../lib/storage'
import { plural } from '../../../lib/format'
import { contentElementById } from '../../../lib/scroll'
import type { DiffLine, LineSelection } from '../../../lib/diff'
import { parseSuggestions } from '../../../lib/suggestions'
import { FileDiffBox, lineAnchor, anchorKey, type DiffSide } from '../../../components/DiffView'
import { Composer } from '../../../components/Composer'
import type { SuggestionContext } from '../../../components/Markdown'
import { SuggestionActions, SuggestionProvider } from '../../../components/Suggestions'
import { CommentRangeBar, PendingComment, ReviewThread, buildThreads, type CommentRange, type ThreadModel } from '../../../components/Timeline'
import { ErrorBox, Loading } from '../../../components/Bits'
import { usePullFiles, useReviewComments, useReviewThreads, usePullReviewState, useInvalidatePull, diffLineMap } from './data'
import { threadPrompt } from './Conversation'

/** A review comment kept in this app until the review is submitted (no pending review exists on GitHub yet). */
interface LocalComment {
  id: string
  path: string
  side: DiffSide
  line: number
  /** First line of a multi-line comment (same side). */
  startLine?: number
  body: string
  /** Head SHA the comment was written against (missing on comments saved before it was recorded). */
  commitId?: string
}

interface Draft {
  path: string
  side: DiffSide
  line: number
  startLine?: number
}

const rangeOf = (c: { side: DiffSide; line: number; startLine?: number | null }): CommentRange | null =>
  c.startLine && c.startLine < c.line ? { startSide: c.side, start: c.startLine, side: c.side, end: c.line } : null

/** Review fields for a comment on lines startLine..line of one side. */
const threadFields = (c: { path: string; side: DiffSide; line: number; startLine?: number; body: string }) => ({
  path: c.path,
  line: c.line,
  side: c.side,
  ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine, start_side: c.side } : {}),
  body: c.body,
})

export function FilesChanged({ pr }: { pr: PullRequest }) {
  const { owner, repo, fullName } = useRepo()
  const { octokit, account } = useGitHub()
  const agent = useAgent()
  const files = usePullFiles(owner, repo, pr.number)
  const comments = useReviewComments(owner, repo, pr.number)
  const threadInfo = useReviewThreads(owner, repo, pr.number)
  const reviewState = usePullReviewState(owner, repo, pr.number)
  const invalidate = useInvalidatePull(owner, repo, pr.number)
  const storeKey = `${owner}/${repo}#${pr.number}`

  const [split, setSplit] = useState(() => readPref('diffSplit', false))
  const [showTree, setShowTree] = useState(() => readPref('diffFileTree', true))
  const [filter, setFilter] = useState('')
  const [viewed, setViewed] = useSharedPref<Record<string, string>>(`viewed:${storeKey}`, {})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useSharedPref<LocalComment[]>(`pendingReview:${storeKey}`, [])
  const [selection, setSelection] = useState<{ path: string; range: LineSelection } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftText, setDraftText] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Switching to a cached PR keeps this component mounted, so reset the per-PR state during render.
  const [loadedKey, setLoadedKey] = useState(storeKey)
  if (loadedKey !== storeKey) {
    setLoadedKey(storeKey)
    setFilter('')
    setCollapsed({})
    setSelection(null)
    setDraft(null)
    setDraftText('')
    setReviewOpen(false)
    setError(null)
  }

  // The viewer's pending review on GitHub (started here, on github.com or anywhere): while it exists, new
  // comments and replies go straight into it, and the local comments join it when the review is submitted.
  const serverReview = reviewState.data?.pending ?? null
  const serverComments = serverReview?.comments ?? []
  const pendingCount = pending.length + serverComments.length
  const reviewing = pendingCount > 0 || !!serverReview

  const threads = useMemo(() => buildThreads(comments.data ?? [], threadInfo.data), [comments.data, threadInfo.data])
  const threadsByAnchor = useMemo(() => {
    const m = new Map<string, ThreadModel[]>()
    for (const t of threads) {
      if (t.root.line === null || t.root.line === undefined) continue // outdated: shown in Conversation
      const k = `${t.root.path}|${anchorKey((t.root.side as DiffSide) ?? 'RIGHT', t.root.line)}`
      m.set(k, [...(m.get(k) ?? []), t])
    }
    return m
  }, [threads])
  // Code at each commentable line of the current diff, keyed like threadsByAnchor.
  const diffLines = useMemo(() => diffLineMap(files.data), [files.data])
  const currentLine = useCallback((path: string, n: number) => diffLines.get(`${path}|${anchorKey('RIGHT', n)}`), [diffLines])
  /** New-file code of lines start..end, which "Add a suggestion" puts in the block. */
  const rightLines = (path: string, start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => currentLine(path, start + i) ?? '')

  // A pending comment written against an older head, or whose line left the diff, can't be sent with
  // pr.head.sha as-is: GitHub rejects the whole review (422) or attaches it to whatever code is there now.
  const lineAt = (p: LocalComment) => diffLines.get(`${p.path}|${anchorKey(p.side, p.line)}`)
  const isStale = (p: LocalComment) =>
    (!!p.commitId && p.commitId !== pr.head.sha) || lineAt(p) === undefined || (!!p.startLine && !diffLines.has(`${p.path}|${anchorKey(p.side, p.startLine)}`))
  const staleCount = pending.filter(isStale).length

  const all = files.data ?? []
  const shown = all.filter((f) => f.filename.toLowerCase().includes(filter.toLowerCase()))
  const viewedCount = all.filter((f) => viewed[f.filename] === f.sha).length
  const isAuthor = pr.user?.login === account.login

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      invalidate()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  // For ReviewThread callbacks: reject on failure so the reply/edit draft stays open (the error shows above).
  const runStrict = async (fn: () => Promise<unknown>) => {
    if (!(await run(fn))) throw new Error('Request failed')
  }

  const closeDraft = () => {
    setDraft(null)
    setDraftText('')
  }

  /** "Suggested change" boxes in the viewer's pending comments: github.com can't apply those until the review is submitted. */
  const pendingSuggestions = (c: { path: string; side: DiffSide; line: number | null; startLine?: number | null; body: string }): SuggestionContext | undefined => {
    if (!parseSuggestions(c.body).length || c.line === null) return undefined
    const start = c.startLine ?? c.line
    return {
      path: c.path,
      base: c.side === 'RIGHT' ? rightLines(c.path, start, c.line) : null,
      startLine: start,
      renderActions: (i) =>
        i === 0 ? (
          <SuggestionActions
            source={{ body: c.body, path: c.path, side: c.side, line: c.line, startLine: c.startLine, originalLine: c.line, diffHunk: '' }}
            commentId={0}
            author={{ login: account.login, id: 0 }}
            outdated={false}
            pending
          />
        ) : null,
    }
  }

  const serverPendingComment = (c: PendingReviewComment) => (
    <PendingComment
      key={c.id}
      login={account.login}
      avatarUrl={account.avatarUrl}
      body={c.body}
      bodyHtml={c.bodyHTML}
      context={fullName}
      suggestions={pendingSuggestions(c)}
      onEdit={(body) => runStrict(() => updatePendingComment(octokit, c.id, body))}
      onDelete={() => run(() => deletePendingComment(octokit, c.id))}
      confirmDelete
    />
  )

  const renderAfter = (path: string) => (line: DiffLine) => {
    const anchor = lineAnchor(line)
    if (!anchor) return null
    const keys = [anchorKey(anchor.side, anchor.line)]
    // A comment on the LEFT side of an unchanged line (GitHub's split view allows it) belongs on this row too.
    if (line.type === 'context' && line.oldNo !== null) keys.push(anchorKey('LEFT', line.oldNo))
    const at = (side: DiffSide, n: number | null) => n !== null && keys.includes(anchorKey(side, n))
    const lineThreads = keys.flatMap((k) => threadsByAnchor.get(`${path}|${k}`) ?? [])
    const linePending = pending.filter((p) => p.path === path && at(p.side, p.line))
    const lineServer = serverComments.filter((c) => c.replyTo === null && c.path === path && at(c.side, c.line))
    const isDraft = !!draft && draft.path === path && at(draft.side, draft.line)
    if (!lineThreads.length && !linePending.length && !lineServer.length && !isDraft) return null
    return (
      <div>
        {lineThreads.map((t) => {
          const replies = serverComments.filter((c) => c.replyTo === t.root.id)
          return (
            <ReviewThread
              key={t.root.id}
              thread={t}
              context={fullName}
              viewerLogin={account.login}
              replyLabel={serverReview ? 'Add review comment' : undefined}
              pendingReplies={replies.length > 0 && replies.map(serverPendingComment)}
              onReply={(body) =>
                runStrict(() =>
                  // REST replies fail while the viewer has a pending review; github.com adds them to it.
                  serverReview && t.info
                    ? addPendingReply(octokit, serverReview.id, t.info.id, body)
                    : octokit.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: pr.number, comment_id: t.root.id, body }),
                )
              }
              onResolve={(resolved) => runStrict(() => setThreadResolved(octokit, t.info!.id, resolved))}
              onAskAgent={(p) => agent.ask(p)}
              agentPrompt={threadPrompt(owner, repo, pr, t)}
              onEditComment={(id, body) => runStrict(() => octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: id, body }))}
              onDeleteComment={(id) => run(() => octokit.rest.pulls.deleteReviewComment({ owner, repo, comment_id: id }))}
            />
          )
        })}
        {lineServer.map((c) => {
          const range = c.line !== null ? rangeOf({ side: c.side, line: c.line, startLine: c.startLine }) : null
          return (
            <div key={c.id} className="diff-thread">
              {range && <CommentRangeBar range={range} />}
              {serverPendingComment(c)}
            </div>
          )
        })}
        {linePending.map((p) => {
          const range = rangeOf(p)
          return (
            <div key={p.id} className="diff-thread">
              {range && <CommentRangeBar range={range} />}
              <PendingComment
                login={account.login}
                avatarUrl={account.avatarUrl}
                body={p.body}
                context={fullName}
                suggestions={pendingSuggestions(p)}
                onEdit={async (body) => setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, body } : x)))}
                onDelete={async () => setPending((ps) => ps.filter((x) => x.id !== p.id))}
              />
            </div>
          )
        })}
        {isDraft && draft && (
          <div className="diff-thread">
            {rangeOf(draft) && <CommentRangeBar verb="Commenting on" range={rangeOf(draft)!} />}
            <div style={{ padding: 8 }}>
              <Composer
                value={draftText}
                onChange={setDraftText}
                context={fullName}
                rows={4}
                autoFocus
                suggestion={draft.side === 'RIGHT' ? { path, startLine: draft.startLine ?? draft.line, lines: rightLines(path, draft.startLine ?? draft.line, draft.line) } : undefined}
                actions={
                  <>
                    <Button onClick={closeDraft}>Cancel</Button>
                    {/* github.com drops "Add single comment" once a review is under way (REST can't post one beside a pending review). */}
                    {!reviewing && (
                      <Button
                        disabled={!draftText.trim()}
                        loading={busy}
                        onClick={async () => {
                          const ok = await run(() => octokit.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: pr.head.sha, ...threadFields({ ...draft, path, body: draftText }) }))
                          if (ok) closeDraft()
                        }}
                      >
                        Add single comment
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      disabled={!draftText.trim()}
                      loading={busy && !!serverReview}
                      onClick={async () => {
                        if (serverReview) {
                          const ok = await run(() => addPendingThread(octokit, serverReview.id, { path, body: draftText, line: draft.line, side: draft.side, startLine: draft.startLine }))
                          if (ok) closeDraft()
                          return
                        }
                        setPending((ps) => [...ps, { id: crypto.randomUUID(), path, side: draft.side, line: draft.line, startLine: draft.startLine, body: draftText, commitId: pr.head.sha }])
                        closeDraft()
                      }}
                    >
                      {reviewing ? 'Add review comment' : 'Start a review'}
                    </Button>
                  </>
                }
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  if (files.isLoading) return <Loading label="Loading files" />
  if (files.error) return <ErrorBox error={files.error} />

  return (
    <SuggestionProvider pr={pr} canApply={!!reviewState.data?.viewerCanApplySuggestion} currentLine={currentLine} onCommitted={invalidate}>
      {/* A collapsed file takes its comment box with it, but not the text in it (src/lib/TabsProvider.tsx). */}
      {draft && draftText.trim() && <span hidden data-tab-draft />}
      <div className="flex-center gap-2 wrap mb-3 files-toolbar">
        <IconButton
          className="files-tree-toggle"
          size="small"
          variant="invisible"
          icon={showTree ? SidebarExpandIcon : SidebarCollapseIcon}
          aria-label={showTree ? 'Hide file tree' : 'Show file tree'}
          onClick={() => {
            // The filter box lives in the tree's column, so don't leave a hidden filter applied.
            if (showTree) setFilter('')
            setShowTree(!showTree)
            writePref('diffFileTree', !showTree)
          }}
        />
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton size="small" variant="invisible" icon={GearIcon} aria-label="Diff settings" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="small">
            <ActionList>
              <ActionList.Group selectionVariant="single">
                <ActionList.GroupHeading>Diff view</ActionList.GroupHeading>
                {(['Unified', 'Split'] as const).map((label) => (
                  <ActionList.Item key={label} selected={split === (label === 'Split')} onSelect={() => (setSplit(label === 'Split'), writePref('diffSplit', label === 'Split'))}>
                    {label}
                  </ActionList.Item>
                ))}
              </ActionList.Group>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <span className="ml-auto flex-center gap-2 text-small fg-muted">
          <span style={{ width: 80 }}>
            <ProgressBar progress={all.length ? (viewedCount / all.length) * 100 : 0} aria-label="Files viewed" barSize="small" />
          </span>
          {viewedCount} / {all.length} files viewed
        </span>
        <Button size="small" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Review the changed files in ${owner}/${repo}#${pr.number}. Report findings with file:line; I may ask you to post them as a review.`)}>
          Agent review
        </Button>
        <Button variant="primary" size="small" trailingAction={TriangleDownIcon} onClick={() => setReviewOpen(true)}>
          {reviewing ? 'Finish your review' : 'Review changes'} {pendingCount > 0 && <CounterLabel>{pendingCount}</CounterLabel>}
        </Button>
      </div>
      {error && <div className="error-box mb-3">{error}</div>}
      {staleCount > 0 && (
        <Banner
          className="mb-3"
          variant="warning"
          title="Pending comments are out of date"
          description={`${plural(staleCount, 'pending comment')} ${staleCount === 1 ? 'was' : 'were'} written against an older version of this diff. Keep or remove them before submitting your review.`}
          primaryAction={<Banner.PrimaryAction onClick={() => setReviewOpen(true)}>Review pending comments</Banner.PrimaryAction>}
        />
      )}
      <div className={`files-layout ${showTree ? '' : 'no-tree'}`}>
        <div className="files-tree">
          <TextInput block leadingVisual={SearchIcon} placeholder="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter changed files" className="mb-2" />
          <FileTree
            files={shown}
            onSelect={(path) => {
              setCollapsed((c) => ({ ...c, [path]: false }))
              requestAnimationFrame(() => contentElementById(`diff-${cssId(path)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
            }}
            viewed={viewed}
          />
        </div>
        <div style={{ minWidth: 0 }}>
          {shown.map((f) => {
            const isViewed = viewed[f.filename] === f.sha
            const draftHere = draft?.path === f.filename ? draft : null
            return (
              <FileDiffBox
                key={f.filename}
                id={`diff-${cssId(f.filename)}`}
                file={{ path: f.filename, previousPath: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch, sha: f.sha }}
                split={split}
                collapsed={collapsed[f.filename] ?? isViewed}
                onToggle={() => setCollapsed((c) => ({ ...c, [f.filename]: !(c[f.filename] ?? isViewed) }))}
                renderAfterLine={renderAfter(f.filename)}
                // While a form is open on several lines they stay selected, as on github.com.
                selection={
                  draftHere?.startLine
                    ? { side: draftHere.side, start: draftHere.startLine, end: draftHere.line, anchor: draftHere.startLine }
                    : !draftHere && selection?.path === f.filename
                      ? selection.range
                      : null
                }
                commenting={!!draftHere?.startLine}
                onSelectLines={(range) => setSelection({ path: f.filename, range })}
                onAddComment={(range) => {
                  setDraft({ path: f.filename, side: range.side, line: range.end, startLine: range.start < range.end ? range.start : undefined })
                  setDraftText('')
                  setSelection(null)
                }}
                actions={
                  <>
                    <IconButton description="Ask the agent about this file’s changes"
                        size="small"
                        variant="invisible"
                        icon={SparkleFillIcon}
                        aria-label="Ask agent about this file"
                        onClick={() => agent.ask(`Review the changes to ${f.filename} in ${owner}/${repo}#${pr.number}. Point out problems with line numbers.`)}
                      />
                    <label className="flex-center gap-1 text-small" style={{ cursor: 'pointer', padding: '0 6px', border: '1px solid var(--borderColor-default)', borderRadius: 6, lineHeight: '26px' }}>
                      <Checkbox
                        checked={isViewed}
                        onChange={() =>
                          setViewed((v) => {
                            const next = { ...v }
                            if (isViewed) delete next[f.filename]
                            else next[f.filename] = f.sha ?? ''
                            return next
                          })
                        }
                      />
                      Viewed
                    </label>
                    <ActionMenu>
                      <ActionMenu.Anchor>
                        <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="Show options" />
                      </ActionMenu.Anchor>
                      <ActionMenu.Overlay align="end">
                        <ActionList>
                          {/* A deleted file only exists at the base commit. */}
                          <ActionList.LinkItem as={Link} to={`/${owner}/${repo}/blob/${encodePath(f.status === 'removed' ? pr.base.sha : pr.head.sha)}/${encodePath(f.filename)}`}>
                            View file
                          </ActionList.LinkItem>
                        </ActionList>
                      </ActionMenu.Overlay>
                    </ActionMenu>
                  </>
                }
              />
            )
          })}
          {shown.length === 0 && <div className="Box Box-body fg-muted">No files match.</div>}
        </div>
      </div>
      {reviewOpen && (
        <ReviewDialog
          pr={pr}
          pending={pending}
          review={serverReview}
          isStale={isStale}
          lineAt={lineAt}
          onKeep={(id) => setPending((ps) => ps.map((x) => (x.id === id ? { ...x, commitId: pr.head.sha } : x)))}
          onRemove={(id) => setPending((ps) => ps.filter((x) => x.id !== id))}
          isAuthor={isAuthor}
          onClose={() => setReviewOpen(false)}
          onChanged={invalidate}
          onDone={() => {
            setPending([])
            setReviewOpen(false)
            invalidate()
          }}
        />
      )}
    </SuggestionProvider>
  )
}

function cssId(path: string) {
  return path.replace(/[^a-zA-Z0-9_-]/g, '_')
}

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  file?: PullFile
}

function FileTree({ files, onSelect, viewed }: { files: PullFile[]; onSelect(path: string): void; viewed: Record<string, string> }) {
  const root = useMemo(() => {
    const r: TreeNode = { name: '', path: '', children: new Map() }
    for (const f of files) {
      const parts = f.filename.split('/')
      let node = r
      parts.forEach((p, i) => {
        const path = parts.slice(0, i + 1).join('/')
        if (!node.children.has(p)) node.children.set(p, { name: p, path, children: new Map() })
        node = node.children.get(p)!
        if (i === parts.length - 1) node.file = f
      })
    }
    // Collapse single-child directory chains like GitHub (src/lib/foo).
    const compact = (n: TreeNode): TreeNode => {
      for (const [k, c] of n.children) n.children.set(k, compact(c))
      if (!n.file && n.children.size === 1 && n.name) {
        const only = [...n.children.values()][0]
        if (!only.file) return { ...only, name: `${n.name}/${only.name}` }
      }
      return n
    }
    return compact(r)
  }, [files])

  const render = (n: TreeNode): React.ReactNode => {
    const kids = [...n.children.values()].sort((a, b) => (!!a.file === !!b.file ? a.name.localeCompare(b.name) : a.file ? 1 : -1))
    return kids.map((c) =>
      c.file ? (
        <TreeView.Item key={c.path} id={c.path} onSelect={() => onSelect(c.path)}>
          <TreeView.LeadingVisual>
            <FileIcon />
          </TreeView.LeadingVisual>
          <span style={{ opacity: viewed[c.path] === c.file.sha ? 0.6 : 1 }}>{c.name}</span>
          <TreeView.TrailingVisual>
            <StatusIcon status={c.file.status} />
          </TreeView.TrailingVisual>
        </TreeView.Item>
      ) : (
        <TreeView.Item key={c.path} id={c.path} defaultExpanded>
          <TreeView.LeadingVisual>
            <FileDirectoryFillIcon className="fg-muted" />
          </TreeView.LeadingVisual>
          {c.name}
          <TreeView.SubTree>{render(c)}</TreeView.SubTree>
        </TreeView.Item>
      ),
    )
  }
  return (
    <TreeView aria-label="Changed files" truncate>
      {render(root)}
    </TreeView>
  )
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'added') return <DiffAddedIcon className="fg-success" aria-label="Added" />
  if (status === 'removed') return <DiffRemovedIcon className="fg-danger" aria-label="Removed" />
  if (status === 'renamed') return <DiffRenamedIcon className="fg-muted" aria-label="Renamed" />
  return <DiffModifiedIcon className="fg-attention" aria-label="Modified" />
}

interface ReviewDialogProps {
  pr: PullRequest
  /** Comments kept in the app. */
  pending: LocalComment[]
  /** The viewer's pending review on GitHub, if any. */
  review: PendingReview | null
  isStale(p: LocalComment): boolean
  /** Code now at the comment's line, or undefined when the line is no longer in the diff. */
  lineAt(p: LocalComment): string | undefined
  onKeep(id: string): void
  onRemove(id: string): void
  isAuthor: boolean
  onClose(): void
  /** Something changed on GitHub (local comments moved into the pending review) though the dialog stays open. */
  onChanged(): void
  /** Submitted or abandoned: every pending comment is gone. */
  onDone(): void
}

const lineLabel = (side: DiffSide, line: number | null, startLine?: number | null) => {
  const s = side === 'LEFT' ? 'L' : 'R'
  return line === null ? '' : startLine ? `${s}${startLine}-${s}${line}` : `${s}${line}`
}

function ReviewDialog({ pr, pending, review, isStale, lineAt, onKeep, onRemove, isAuthor, onClose, onChanged, onDone }: ReviewDialogProps) {
  const { owner, repo } = useRepo()
  const { octokit } = useGitHub()
  const confirm = useConfirm()
  const [body, setBody] = useState(review?.body ?? '')
  const [event, setEvent] = useState<'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'>('COMMENT')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const staleCount = pending.filter(isStale).length
  const total = pending.length + (review?.comments.length ?? 0)
  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const submit = () =>
    attempt(async () => {
      if (review) {
        // REST can't add to an existing pending review: move the local comments into it, then submit it.
        let moved = false
        try {
          for (const p of pending) {
            await addPendingThread(octokit, review.id, { path: p.path, body: p.body, line: p.line, side: p.side, startLine: p.startLine })
            onRemove(p.id)
            moved = true
          }
        } finally {
          if (moved) onChanged()
        }
        await submitPendingReview(octokit, review.id, event, body)
      } else {
        await octokit.rest.pulls.createReview({ owner, repo, pull_number: pr.number, commit_id: pr.head.sha, event, body, comments: pending.map(threadFields) })
      }
      onDone()
    })
  const abandon = async () => {
    const ok = await confirm({
      title: 'Abandon review?',
      content: `Your pending review${total ? ` and its ${plural(total, 'comment')}` : ''} will be deleted. This cannot be undone.`,
      confirmButtonType: 'danger',
      confirmButtonContent: 'Abandon review',
    })
    if (!ok) return
    await attempt(async () => {
      if (review) await deletePendingReview(octokit, review.id)
      onDone()
    })
  }
  return (
    <Dialog
      title="Finish your review"
      width="xlarge"
      onClose={onClose}
      footerButtons={[
        ...(review || pending.length ? [{ content: 'Abandon review', buttonType: 'danger' as const, onClick: () => void abandon(), disabled: busy }] : []),
        { content: 'Cancel', onClick: onClose },
        {
          content: 'Submit review',
          buttonType: 'primary',
          onClick: () => void submit(),
          disabled: busy || staleCount > 0 || (event !== 'APPROVE' && !body.trim() && total === 0),
        },
      ]}
    >
      <Textarea block rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a comment" aria-label="Review summary" />
      {total > 0 && <p className="fg-muted text-small">{plural(total, 'pending inline comment')} will be submitted with this review.</p>}
      {total > 0 && (
        <div className="Box">
          {review?.comments.map((c) => (
            <div key={c.id} className="Box-row gap-2">
              <div className="flex-1">
                <div className="flex-center gap-1 text-small">
                  <span className="text-mono text-truncate">
                    {c.path}
                    {c.line !== null && `:${lineLabel(c.side, c.line, c.startLine)}`}
                  </span>
                  {c.replyTo !== null && <span className="fg-muted">(reply)</span>}
                  {c.outdated && (
                    <Label variant="attention" size="small">
                      Outdated
                    </Label>
                  )}
                </div>
                <div className="text-small text-break" style={{ whiteSpace: 'pre-wrap' }}>
                  {c.body}
                </div>
              </div>
            </div>
          ))}
          {pending.map((p) => {
            const stale = isStale(p)
            const now = lineAt(p)
            return (
              <div key={p.id} className="Box-row gap-2">
                <div className="flex-1">
                  <div className="flex-center gap-1 text-small">
                    <span className="text-mono text-truncate">
                      {p.path}:{lineLabel(p.side, p.line, p.startLine)}
                    </span>
                    {stale && (
                      <Label variant="attention" size="small">
                        Outdated
                      </Label>
                    )}
                  </div>
                  <div className="text-small text-break" style={{ whiteSpace: 'pre-wrap' }}>
                    {p.body}
                  </div>
                  {stale && (
                    <div className="text-small fg-muted mt-1">
                      {now === undefined ? (
                        'This line is no longer in the diff.'
                      ) : (
                        <>
                          Written against an earlier commit. This line now reads: <code className="text-mono">{now}</code>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {stale && now !== undefined && (
                  <Button size="small" onClick={() => onKeep(p.id)}>
                    Keep
                  </Button>
                )}
                <IconButton size="small" variant="invisible" icon={TrashIcon} aria-label="Remove pending comment" onClick={() => onRemove(p.id)} />
              </div>
            )
          })}
        </div>
      )}
      {staleCount > 0 && <p className="fg-danger text-small">Keep or remove the outdated comments to submit this review.</p>}
      <RadioGroup name="review-event" className="mt-3" onChange={(v) => v && setEvent(v as typeof event)}>
        <RadioGroup.Label visuallyHidden>Review type</RadioGroup.Label>
        <FormControl>
          <Radio value="COMMENT" checked={event === 'COMMENT'} onChange={() => setEvent('COMMENT')} />
          <FormControl.Label>Comment</FormControl.Label>
          <FormControl.Caption>Submit general feedback without explicit approval.</FormControl.Caption>
        </FormControl>
        <FormControl disabled={isAuthor}>
          <Radio value="APPROVE" checked={event === 'APPROVE'} onChange={() => setEvent('APPROVE')} />
          <FormControl.Label>Approve</FormControl.Label>
          <FormControl.Caption>{isAuthor ? 'You can’t approve your own pull request.' : 'Submit feedback and approve merging these changes.'}</FormControl.Caption>
        </FormControl>
        <FormControl disabled={isAuthor}>
          <Radio value="REQUEST_CHANGES" checked={event === 'REQUEST_CHANGES'} onChange={() => setEvent('REQUEST_CHANGES')} />
          <FormControl.Label>Request changes</FormControl.Label>
          <FormControl.Caption>{isAuthor ? 'You can’t request changes on your own pull request.' : 'Submit feedback that must be addressed before merging.'}</FormControl.Caption>
        </FormControl>
      </RadioGroup>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
