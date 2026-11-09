import { useMemo, useState, type ReactNode } from 'react'
import { AgentOnly } from '../lib/agent/AgentProvider'
import { Link } from 'react-router-dom'
import { ActionList, ActionMenu, Button, IconButton, Label, RelativeTime, Tooltip, useConfirm } from '@primer/react'
import {
  KebabHorizontalIcon,
  SparkleFillIcon,
  GitCommitIcon,
  TagIcon,
  PersonIcon,
  EyeIcon,
  IssueClosedIcon,
  IssueReopenedIcon,
  GitMergeIcon,
  PencilIcon,
  RepoPushIcon,
  CrossReferenceIcon,
  CheckIcon,
  FileDiffIcon,
  MilestoneIcon,
  GitBranchIcon,
  EyeClosedIcon,
  GitPullRequestDraftIcon,
  DotFillIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ReplyIcon,
  LockIcon,
  PinIcon,
  CheckCircleIcon,
  CircleSlashIcon,
  LinkExternalIcon,
  UnlockIcon,
  IssueOpenedIcon,
  SkipIcon,
  GitPullRequestIcon,
  GitPullRequestClosedIcon,
  ArrowRightIcon,
  CommentDiscussionIcon,
  IssueTracksIcon,
  TrashIcon,
} from '@primer/octicons-react'
import { Markdown, type SuggestionContext } from './Markdown'
import { Composer } from './Composer'
import { contentElementById, cssId } from '../lib/scroll'
import { SuggestionActions } from './Suggestions'
import { IssueLabel, InlineTitle, UserAvatar, UserLink, isBot, botName } from './Bits'
import { hunkSlice, hunkTail, sideLabel, type DiffLine, type DiffSide } from '../lib/diff'
import { hunkRange, parseSuggestions } from '../lib/suggestions'
import { highlightLine, languageFor } from '../lib/highlight'
import { firstLine, shortSha, copyText } from '../lib/format'
import type { PendingReviewComment, ReviewComment, ReviewThreadInfo } from '../lib/github'

const ASSOCIATION_LABEL: Record<string, string> = { OWNER: 'Owner', MEMBER: 'Member', COLLABORATOR: 'Collaborator', CONTRIBUTOR: 'Contributor', FIRST_TIME_CONTRIBUTOR: 'First-time contributor' }

export interface Reactions {
  '+1'?: number
  '-1'?: number
  laugh?: number
  hooray?: number
  confused?: number
  heart?: number
  rocket?: number
  eyes?: number
  total_count?: number
}

const REACTION_EMOJI: Array<[keyof Reactions, string]> = [
  ['+1', '👍'], ['-1', '👎'], ['laugh', '😄'], ['hooray', '🎉'], ['confused', '😕'], ['heart', '❤️'], ['rocket', '🚀'], ['eyes', '👀'],
]

export function ReactionSummary({ reactions }: { reactions?: Reactions | null }) {
  if (!reactions?.total_count) return null
  return (
    <div className="flex gap-1 wrap mt-2">
      {REACTION_EMOJI.filter(([k]) => (reactions[k] ?? 0) > 0).map(([k, e]) => (
        <span key={k} className="counter" style={{ background: 'var(--bgColor-muted)', border: '1px solid var(--borderColor-default)', padding: '0 8px' }}>
          {e} {reactions[k]}
        </span>
      ))}
    </div>
  )
}

interface CommentCardProps {
  author?: string | null
  authorType?: string | null
  avatar?: string | null
  association?: string | null
  createdAt: string
  updatedAt?: string | null
  bodyHtml?: string | null
  body?: string | null
  context: string
  isIssueAuthor?: boolean
  canEdit?: boolean
  htmlUrl?: string
  reactions?: Reactions | null
  /** Text after the author's name; defaults to "commented", null shows none (github.com's issue page). */
  verb?: ReactNode
  /** Highlights the header in blue; defaults to `isIssueAuthor`. github.com highlights the viewer's own comments. */
  viewerDidAuthor?: boolean
  /** Puts a 24px avatar inside the header instead of a 40px one in a left gutter, as github.com's issue page does. */
  inlineAvatar?: boolean
  onEdit?(body: string): Promise<unknown>
  onDelete?(): Promise<unknown>
  onQuote?(text: string): void
  agentPrompt?: string
  onAskAgent?(prompt: string): void
  headerExtra?: ReactNode
  footer?: ReactNode
}

export function CommentCard(p: CommentCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.body ?? '')
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()
  const edited = p.updatedAt && new Date(p.updatedAt).getTime() - new Date(p.createdAt).getTime() > 60_000
  const bot = isBot(p.author, p.authorType)
  const verb = p.verb === undefined ? 'commented' : p.verb
  return (
    <div className={`timeline-comment-group ${p.inlineAvatar ? 'inline-avatar' : ''} ${p.viewerDidAuthor ? 'is-mine' : ''}`}>
      {!p.inlineAvatar && (
        <div className="avatar-col">
          <UserAvatar login={p.author} src={p.avatar} size={40} square={bot} />
        </div>
      )}
      <div className={`timeline-comment ${(p.viewerDidAuthor ?? p.isIssueAuthor) ? 'author' : ''}`}>
        <div className="timeline-comment-header">
          {p.inlineAvatar && (
            <span className="comment-inline-avatar">
              <UserAvatar login={p.author} src={p.avatar} size={24} square={bot} />
            </span>
          )}
          <UserLink login={p.author} type={p.authorType} />
          {verb && <span>{verb}</span>}
          {p.htmlUrl ? (
            <a href={p.htmlUrl} className="link-muted" onClick={(e) => e.preventDefault()}>
              <RelativeTime date={new Date(p.createdAt)} />
            </a>
          ) : (
            <RelativeTime date={new Date(p.createdAt)} />
          )}
          {edited && <span className="text-small">· edited</span>}
          {p.headerExtra}
          <span className="timeline-comment-actions">
            {/* github.com lists the association before "Author", on issues and pull requests alike. */}
            {p.association && ASSOCIATION_LABEL[p.association] && !bot && <Label size="small">{ASSOCIATION_LABEL[p.association]}</Label>}
            {p.isIssueAuthor && <Label size="small">Author</Label>}
            {bot && p.onAskAgent && p.agentPrompt && (
              <AgentOnly><Tooltip text={`Have the agent verify and address this ${botName(p.author ?? '')} comment`}>
                <Button size="small" variant="invisible" leadingVisual={SparkleFillIcon} onClick={() => p.onAskAgent!(p.agentPrompt!)}>
                  Address
                </Button>
              </Tooltip></AgentOnly>
            )}
            <ActionMenu>
              <ActionMenu.Anchor>
                <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="Comment actions" />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay align="end">
                <ActionList>
                  {p.htmlUrl && <ActionList.Item onSelect={() => void copyText(p.htmlUrl!)}>Copy link</ActionList.Item>}
                  {p.onQuote && p.body && <ActionList.Item onSelect={() => p.onQuote!(p.body!.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n')}>Quote reply</ActionList.Item>}
                  {p.onAskAgent && (
                    <ActionList.Item onSelect={() => p.onAskAgent!(p.agentPrompt ?? `Explain this comment by ${p.author} and what, if anything, should be done about it:\n\n${p.body ?? ''}`)}>
                      Ask agent about this
                    </ActionList.Item>
                  )}
                  {p.canEdit && p.onEdit && (
                    <>
                      <ActionList.Divider />
                      <ActionList.Item onSelect={() => (setDraft(p.body ?? ''), setEditing(true))}>Edit</ActionList.Item>
                    </>
                  )}
                  {p.canEdit && p.onDelete && (
                    <ActionList.Item
                      variant="danger"
                      onSelect={async () => {
                        if (await confirm({ title: 'Delete comment?', content: 'This cannot be undone.', confirmButtonType: 'danger', confirmButtonContent: 'Delete' })) await p.onDelete!()
                      }}
                    >
                      Delete
                    </ActionList.Item>
                  )}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          </span>
        </div>
        <div className="timeline-comment-body">
          {editing ? (
            <Composer
              rows={12}
              value={draft}
              onChange={setDraft}
              context={p.context}
              autoFocus
              actions={
                <>
                  <Button onClick={() => setEditing(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={saving}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        await p.onEdit!(draft)
                        setEditing(false)
                      } catch {
                        // the page shows the error; keep the editor open with the text
                      } finally {
                        setSaving(false)
                      }
                    }}
                  >
                    Update comment
                  </Button>
                </>
              }
            />
          ) : (
            <>
              <Markdown html={p.bodyHtml} text={p.bodyHtml ? undefined : p.body} context={p.context} />
              <ReactionSummary reactions={p.reactions} />
            </>
          )}
        </div>
        {p.footer}
      </div>
    </div>
  )
}

/** A small row in the timeline (labels, commits, state changes). */
export function EventRow({ icon, tone, children, below }: { icon: ReactNode; tone?: 'success' | 'danger' | 'done' | 'accent' | 'neutral'; children: ReactNode; below?: ReactNode }) {
  return (
    <div className={`timeline-event ${below ? 'has-below' : ''}`}>
      <span className={`timeline-badge ${tone ?? ''}`}>{icon}</span>
      {below ? (
        <div className="flex-1">
          <span className="flex-center gap-1 wrap">{children}</span>
          <div className="timeline-event-below">{below}</div>
        </div>
      ) : (
        <span className="flex-center gap-1 wrap flex-1">{children}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Review threads

export interface ThreadModel {
  root: ReviewComment
  replies: ReviewComment[]
  info?: ReviewThreadInfo
}

/** Groups flat review comments into threads (root + replies), attaching GraphQL thread state. */
export function buildThreads(comments: ReviewComment[], infos: Map<number, ReviewThreadInfo> | undefined): ThreadModel[] {
  const byRoot = new Map<number, ThreadModel>()
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const c of sorted) if (!c.in_reply_to_id) byRoot.set(c.id, { root: c, replies: [], info: infos?.get(c.id) })
  for (const c of sorted) if (c.in_reply_to_id) byRoot.get(c.in_reply_to_id)?.replies.push(c)
  return [...byRoot.values()]
}

export interface CommentRange {
  startSide: DiffSide
  start: number
  side: DiffSide
  end: number
}

/** The lines of a multi-line review comment (current ones, or the original ones once outdated), or null for one line. */
export function commentRange(c: Pick<ReviewComment, 'line' | 'start_line' | 'original_line' | 'original_start_line' | 'side' | 'start_side'>): CommentRange | null {
  const end = c.line ?? c.original_line
  const start = c.line != null ? c.start_line : c.original_start_line
  const side = c.side ?? 'RIGHT'
  const startSide = c.start_side ?? side
  if (!end || !start || (start === end && startSide === side)) return null
  return { startSide, start, side, end }
}

/** github.com's "Comment on lines +12 to +15" bar on multi-line threads ("Commenting on" in the comment form). */
export function CommentRangeBar({ range, verb = 'Comment on' }: { range: CommentRange; verb?: string }) {
  const tone = (side: DiffSide) => (side === 'LEFT' ? 'fg-danger' : 'fg-success')
  return (
    <div className="comment-range-bar">
      {verb} lines <span className={tone(range.startSide)}>{sideLabel(range.startSide, range.start)}</span> to <span className={tone(range.side)}>{sideLabel(range.side, range.end)}</span>
    </div>
  )
}

/** The code a review thread is about, shown above its comments in the conversation. */
function HunkSnippet({ lines, lang }: { lines: DiffLine[]; lang: string | null }) {
  if (!lines.length) return null
  return (
    <table className="diff-table">
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className={`diff-line ${l.type}`}>
            <td className="diff-num">{l.oldNo ?? ''}</td>
            <td className="diff-num">{l.newNo ?? ''}</td>
            <td className="diff-marker">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</td>
            <td className="diff-code" dangerouslySetInnerHTML={{ __html: highlightLine(l.content, lang) }} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The code lines a comment's suggestion replaces, read from its diff hunk (original line numbers). */
function suggestionBase(c: ReviewComment): Pick<SuggestionContext, 'base' | 'startLine'> {
  const end = c.original_line
  const start = c.original_start_line ?? end
  const side = c.side ?? 'RIGHT'
  return { base: end && start ? hunkRange(c.diff_hunk, side, start, end) : null, startLine: (c.line != null ? (c.start_line ?? c.line) : start) ?? null }
}

interface ReviewThreadProps {
  thread: ThreadModel
  context: string
  showHunk?: boolean
  viewerLogin: string
  /** Label of the reply button: "Add review comment" while the viewer has a pending review. */
  replyLabel?: string
  /** The viewer's pending replies in this thread, shown after its comments. */
  pendingReplies?: ReactNode
  onReply(body: string): Promise<unknown>
  onResolve?(resolved: boolean): Promise<unknown>
  onAskAgent?(prompt: string): void
  agentPrompt?: string
  onEditComment?(id: number, body: string): Promise<unknown>
  onDeleteComment?(id: number): Promise<unknown>
}

export function ReviewThread({ thread, context, showHunk, viewerLogin, replyLabel = 'Reply', pendingReplies, onReply, onResolve, onAskAgent, agentPrompt, onEditComment, onDeleteComment }: ReviewThreadProps) {
  const resolved = thread.info?.isResolved ?? false
  const outdated = thread.info?.isOutdated ?? false
  // Follows `resolved` until the viewer toggles: thread status loads separately, usually after this mounts.
  const [toggled, setCollapsed] = useState<boolean | null>(null)
  const collapsed = toggled ?? resolved
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const lang = useMemo(() => languageFor(thread.root.path), [thread.root.path])
  const range = commentRange(thread.root)
  // A multi-line thread shows exactly its lines (hunk numbering is the comment's original lines); others the hunk's last four.
  const tail = useMemo(() => {
    if (!showHunk) return []
    const r = thread.root
    const sliced = commentRange(r) && r.original_start_line && r.original_line ? hunkSlice(r.diff_hunk, r.start_side ?? r.side ?? 'RIGHT', r.original_start_line, r.side ?? 'RIGHT', r.original_line) : null
    return sliced ?? hunkTail(r.diff_hunk, 4)
  }, [showHunk, thread.root])
  const bot = isBot(thread.root.user?.login, thread.root.user?.type)
  const all = [thread.root, ...thread.replies]

  return (
    <div className={`diff-thread ${resolved ? 'resolved' : ''}`}>
      {showHunk && (
        <div style={{ borderBottom: collapsed ? undefined : '1px solid var(--borderColor-muted)' }}>
          <div className="flex-center gap-2 text-small" style={{ padding: '8px 16px', background: 'var(--bgColor-muted)', borderRadius: collapsed ? 6 : '6px 6px 0 0' }}>
            <button type="button" onClick={() => setCollapsed(!collapsed)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }} aria-label={collapsed ? 'Expand thread' : 'Collapse thread'}>
              {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
            </button>
            <button type="button" className="linkish text-mono text-bold text-break" title="Show this file in the diff" onClick={() => contentElementById(`diff-${cssId(thread.root.path)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              {thread.root.path}
            </button>
            {outdated && <Label variant="attention" size="small">Outdated</Label>}
            {resolved && <Label variant="done" size="small">Resolved</Label>}
          </div>
          {!collapsed && range && <CommentRangeBar range={range} />}
          {!collapsed && <HunkSnippet lines={tail} lang={lang} />}
        </div>
      )}
      {!showHunk && resolved && (
        <div className="flex-center gap-2 text-small fg-muted" style={{ padding: '8px 16px' }}>
          <button type="button" onClick={() => setCollapsed(!collapsed)} className="link-muted flex-center gap-1" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
            {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />} {collapsed ? 'Show resolved conversation' : 'Hide resolved conversation'}
          </button>
        </div>
      )}
      {!collapsed && (
        <>
          {!showHunk && range && <CommentRangeBar range={range} />}
          {all.map((c) => (
            <ThreadComment
              key={c.id}
              c={c}
              context={context}
              canEdit={c.user?.login === viewerLogin}
              outdated={outdated || c.line == null}
              resolved={resolved}
              threadId={thread.info?.id}
              onEdit={onEditComment ? (body) => onEditComment(c.id, body) : undefined}
              onDelete={onDeleteComment ? () => onDeleteComment(c.id) : undefined}
            />
          ))}
          {pendingReplies}
          <div className="diff-thread-footer">
            {replying ? (
              <div className="w-100">
                <Composer
                  value={draft}
                  onChange={setDraft}
                  context={context}
                  rows={3}
                  autoFocus
                  placeholder="Reply…"
                  onSubmitShortcut={() => draft.trim() && void submit()}
                  actions={
                    <>
                      <Button onClick={() => setReplying(false)}>Cancel</Button>
                      <Button variant="primary" loading={busy} disabled={!draft.trim()} onClick={() => void submit()}>
                        {replyLabel}
                      </Button>
                    </>
                  }
                />
              </div>
            ) : (
              <>
                <Button size="small" leadingVisual={ReplyIcon} onClick={() => setReplying(true)}>
                  Reply
                </Button>
                {onAskAgent && (
                  <AgentOnly><Button size="small" leadingVisual={SparkleFillIcon} onClick={() => onAskAgent(agentPrompt ?? '')}>
                    {bot ? `Address ${botName(thread.root.user?.login ?? '')} comment` : 'Ask agent'}
                  </Button></AgentOnly>
                )}
                {onResolve && thread.info && (resolved ? thread.info.viewerCanUnresolve : thread.info.viewerCanResolve) && (
                  <Button
                    size="small"
                    className="ml-auto"
                    leadingVisual={resolved ? undefined : CheckIcon}
                    loading={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await onResolve(!resolved)
                        setCollapsed(!resolved)
                      } catch {
                        // the page shows the error
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {resolved ? 'Unresolve conversation' : 'Resolve conversation'}
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )

  async function submit() {
    setBusy(true)
    try {
      await onReply(draft)
      setDraft('')
      setReplying(false)
    } catch {
      // the page shows the error; keep the reply text
    } finally {
      setBusy(false)
    }
  }
}

interface ThreadCommentProps {
  c: ReviewComment
  context: string
  canEdit: boolean
  outdated: boolean
  resolved: boolean
  threadId?: string
  onEdit?(b: string): Promise<unknown>
  onDelete?(): Promise<unknown>
}

function ThreadComment({ c, context, canEdit, outdated, resolved, threadId, onEdit, onDelete }: ThreadCommentProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body)
  const confirm = useConfirm()
  const html = (c as ReviewComment & { body_html?: string }).body_html
  const suggestions: SuggestionContext | undefined = parseSuggestions(c.body).length
    ? {
        path: c.path,
        ...suggestionBase(c),
        renderActions: (i) =>
          i === 0 && c.user ? (
            <SuggestionActions
              source={{
                body: c.body,
                path: c.path,
                side: c.side ?? 'RIGHT',
                startSide: c.start_side,
                line: c.line ?? null,
                startLine: c.start_line,
                originalLine: c.original_line ?? null,
                originalStartLine: c.original_start_line,
                diffHunk: c.diff_hunk,
              }}
              commentId={c.id}
              threadId={threadId}
              author={{ login: c.user.login, id: c.user.id }}
              outdated={outdated}
              resolved={resolved}
            />
          ) : null,
      }
    : undefined
  return (
    <div className="diff-thread-comment">
      <div className="flex-center gap-1 mb-1 text-small">
        <UserAvatar login={c.user?.login} src={c.user?.avatar_url} size={20} square={isBot(c.user?.login, c.user?.type)} />
        <UserLink login={c.user?.login} type={c.user?.type} className="text-bold fg-default" />
        <span className="fg-muted">
          <RelativeTime date={new Date(c.created_at)} />
        </span>
        {canEdit && (
          <span className="ml-auto flex-center gap-1">
            {onEdit && <IconButton size="small" variant="invisible" icon={PencilIcon} aria-label="Edit comment" onClick={() => (setDraft(c.body), setEditing(true))} />}
            {onDelete && (
              <Button
                size="small"
                variant="invisible"
                onClick={async () => {
                  if (await confirm({ title: 'Delete comment?', content: 'This cannot be undone.', confirmButtonType: 'danger', confirmButtonContent: 'Delete' })) await onDelete()
                }}
              >
                Delete
              </Button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          value={draft}
          onChange={setDraft}
          context={context}
          rows={3}
          actions={
            <>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await onEdit?.(draft)
                    setEditing(false)
                  } catch {
                    // the page shows the error; keep the editor open
                  }
                }}
              >
                Update
              </Button>
            </>
          }
        />
      ) : (
        <>
          <Markdown html={html} text={html ? undefined : c.body} context={context} suggestions={suggestions} />
          <ReactionSummary reactions={c.reactions as Reactions | undefined} />
        </>
      )}
    </div>
  )
}

/** A thread of the viewer's pending review in the conversation: the file, the commented code, then the comment. */
export function PendingThread({ comment: c, children }: { comment: PendingReviewComment; children: ReactNode }) {
  const lang = useMemo(() => languageFor(c.path), [c.path])
  const end = c.line ?? c.originalLine
  const start = c.line !== null ? c.startLine : c.originalStartLine
  const range: CommentRange | null = end && start && start < end ? { startSide: c.side, start, side: c.side, end } : null
  const lines = useMemo(
    () => (c.originalLine && c.originalStartLine ? hunkSlice(c.diffHunk, c.side, c.originalStartLine, c.side, c.originalLine) : null) ?? hunkTail(c.diffHunk, 4),
    [c.diffHunk, c.side, c.originalLine, c.originalStartLine],
  )
  return (
    <div className="diff-thread">
      <div style={{ borderBottom: '1px solid var(--borderColor-muted)' }}>
        <div className="flex-center gap-2 text-small" style={{ padding: '8px 16px', background: 'var(--bgColor-muted)', borderRadius: '6px 6px 0 0' }}>
          <span className="text-mono text-bold text-break">{c.path}</span>
          {c.outdated && (
            <Label variant="attention" size="small">
              Outdated
            </Label>
          )}
        </div>
        {range && <CommentRangeBar range={range} />}
        <HunkSnippet lines={lines} lang={lang} />
      </div>
      {children}
    </div>
  )
}

interface PendingCommentProps {
  login: string
  avatarUrl?: string | null
  body: string
  bodyHtml?: string | null
  context: string
  suggestions?: SuggestionContext
  onEdit?(body: string): Promise<unknown>
  onDelete?(): Promise<unknown>
  /** Ask before deleting (a comment saved on GitHub; local drafts go at once). */
  confirmDelete?: boolean
}

/** One of the viewer's own unsubmitted review comments, with github.com's "Pending" label. */
export function PendingComment({ login, avatarUrl, body, bodyHtml, context, suggestions, onEdit, onDelete, confirmDelete }: PendingCommentProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body)
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()
  return (
    <div className="diff-thread-comment">
      <div className="flex-center gap-1 mb-1 text-small">
        <UserAvatar login={login} src={avatarUrl} size={20} />
        <strong>{login}</strong>
        <Label variant="attention" size="small">
          Pending
        </Label>
        <span className="ml-auto flex-center gap-1">
          {onEdit && <IconButton size="small" variant="invisible" icon={PencilIcon} aria-label="Edit pending comment" onClick={() => (setDraft(body), setEditing(true))} />}
          {onDelete && (
            <IconButton
              size="small"
              variant="invisible"
              icon={TrashIcon}
              aria-label="Delete pending comment"
              onClick={async () => {
                if (!confirmDelete || (await confirm({ title: 'Delete comment?', content: 'This cannot be undone.', confirmButtonType: 'danger', confirmButtonContent: 'Delete' }))) await onDelete()
              }}
            />
          )}
        </span>
      </div>
      {editing ? (
        <Composer
          value={draft}
          onChange={setDraft}
          context={context}
          rows={3}
          autoFocus
          actions={
            <>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={saving}
                disabled={!draft.trim()}
                onClick={async () => {
                  setSaving(true)
                  try {
                    await onEdit?.(draft)
                    setEditing(false)
                  } catch {
                    // the page shows the error; keep the editor open
                  } finally {
                    setSaving(false)
                  }
                }}
              >
                Update comment
              </Button>
            </>
          }
        />
      ) : (
        <Markdown html={bodyHtml || undefined} text={bodyHtml ? undefined : body} context={context} suggestions={suggestions} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline events

// The REST timeline is a loose union; read the fields each event type carries.
export type LooseEvent = {
  event?: string
  id?: number
  node_id?: string
  created_at?: string
  submitted_at?: string
  updated_at?: string
  actor?: { login: string; avatar_url?: string; type?: string } | null
  user?: { login: string; avatar_url?: string; type?: string } | null
  author?: { name?: string; email?: string; date?: string } | null
  committer?: { date?: string } | null
  label?: { name: string; color: string }
  assignee?: { login: string } | null
  requested_reviewer?: { login: string } | null
  requested_team?: { name: string } | null
  rename?: { from: string; to: string }
  milestone?: { title: string }
  sha?: string
  message?: string
  commit_id?: string | null
  commit_url?: string | null
  state?: string
  state_reason?: string | null
  body?: string | null
  body_html?: string | null
  html_url?: string
  author_association?: string
  reactions?: Reactions
  source?: {
    type?: string
    issue?: { number: number; title: string; html_url: string; state?: string; state_reason?: string | null; draft?: boolean; pull_request?: { merged_at?: string | null } | null; repository?: { full_name: string } }
  }
  lock_reason?: string | null
  /** What closed the issue (a pull request or commit), filled in from GraphQL by the issue page. */
  closer?: { number?: number; oid?: string; repo: string } | null
  /** The commit headline of a `referenced` event, filled in from GraphQL by the issue page. */
  commit_message?: string | null
  /** A cross-reference from a pull request that will close the issue (GraphQL willCloseTarget). */
  will_close?: boolean
  /** Consecutive events folded into this one by rollupEvents (this event first). */
  rollup?: LooseEvent[]
}

export function eventTime(e: LooseEvent): string {
  return e.created_at ?? e.submitted_at ?? e.committer?.date ?? e.author?.date ?? ''
}

/** Events the timeline never shows; they must not break up a rollup. */
function isHiddenEvent(e: LooseEvent) {
  return ['mentioned', 'subscribed', 'unsubscribed', 'comment_deleted'].includes(e.event ?? '') || (e.event === 'referenced' && !e.commit_id) || (e.event === 'cross-referenced' && !e.source?.issue)
}

// github.com folds consecutive events of these kinds by the same actor, within a week, into one row (at most 20).
const ROLLUP_WITH: Record<string, string[]> = {
  labeled: ['labeled', 'unlabeled'],
  unlabeled: ['labeled', 'unlabeled'],
  assigned: ['assigned', 'unassigned'],
  unassigned: ['assigned', 'unassigned'],
  milestoned: ['milestoned', 'demilestoned'],
  demilestoned: ['milestoned', 'demilestoned'],
  'cross-referenced': ['cross-referenced'],
  referenced: ['referenced'],
  review_requested: ['review_requested', 'review_request_removed'],
  review_request_removed: ['review_requested', 'review_request_removed'],
}

/** Kinds the pull request variant of SimpleEvent renders one at a time, so they are never folded there. */
const PULL_NO_ROLLUP = ['cross-referenced', 'referenced']

/** Drops events the timeline never shows and folds runs of related events into one, as github.com's issue and pull request pages do. */
export function rollupEvents(events: LooseEvent[], opts?: { pull?: boolean }): LooseEvent[] {
  const out: LooseEvent[] = []
  for (const e of events) {
    if (isHiddenEvent(e)) continue
    if (opts?.pull && PULL_NO_ROLLUP.includes(e.event ?? '')) {
      out.push(e)
      continue
    }
    const head = out[out.length - 1]
    const group = head?.rollup ?? (head ? [head] : [])
    const last = group[group.length - 1]
    const actor = (x?: LooseEvent) => (x?.actor ?? x?.user)?.login
    if (
      head &&
      last?.event &&
      e.event &&
      ROLLUP_WITH[last.event]?.includes(e.event) &&
      !last.will_close &&
      !e.will_close &&
      actor(last) &&
      actor(last) === actor(e) &&
      Math.abs(new Date(eventTime(e)).getTime() - new Date(eventTime(last)).getTime()) <= 7 * 24 * 3600_000 &&
      group.length < 20
    ) {
      out[out.length - 1] = { ...group[0], rollup: [...group, e] }
    } else {
      out.push(e)
    }
  }
  return out
}

/** "#12" in the same repository, "owner/repo#12" elsewhere. */
function refText(fullName: string | undefined, number: number, owner: string, repo: string) {
  return !fullName || fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase() ? `#${number}` : `${fullName}#${number}`
}

function repoOfCommitUrl(url: string | null | undefined, owner: string, repo: string) {
  const m = url?.match(/\/repos\/([^/]+\/[^/]+)\/commits\//)
  return m ? m[1] : `${owner}/${repo}`
}

function SourceIcon({ src }: { src: NonNullable<NonNullable<LooseEvent['source']>['issue']> }) {
  if (src.pull_request) {
    if (src.pull_request.merged_at) return <GitMergeIcon size={16} className="fg-done" aria-label="Merged" />
    if (src.state === 'closed') return <GitPullRequestClosedIcon size={16} className="fg-danger" aria-label="Closed" />
    if (src.draft) return <GitPullRequestDraftIcon size={16} className="fg-muted" aria-label="Draft" />
    return <GitPullRequestIcon size={16} className="fg-success" aria-label="Open" />
  }
  if (src.state === 'open') return <IssueOpenedIcon size={16} className="fg-success" aria-label="Open" />
  if (src.state_reason === 'not_planned') return <SkipIcon size={16} className="fg-muted" aria-label="Closed as not planned" />
  return <IssueClosedIcon size={16} className="fg-done" aria-label="Closed" />
}

/**
 * One timeline event. `variant="issue"` renders it as github.com's issue page does (its wording,
 * 16px avatars, rolled-up runs, referenced items listed under the line); the default is the
 * pull request conversation's.
 */
export function SimpleEvent({ e, owner, repo, variant }: { e: LooseEvent; owner: string; repo: string; variant?: 'issue' }) {
  const issue = variant === 'issue'
  const group = e.rollup ?? [e]
  const actor = e.actor ?? e.user
  const who = (
    <>
      <UserAvatar login={actor?.login} src={actor?.avatar_url} size={issue ? 16 : 20} />
      <UserLink login={actor?.login} type={actor?.type} className="actor" />
    </>
  )
  const when = e.created_at ? (
    <span className="link-muted">
      <RelativeTime date={new Date(e.created_at)} />
    </span>
  ) : null
  const reasonLink = (reason: string, text: string) => (
    <Link to={`/${owner}/${repo}/issues?q=${encodeURIComponent(`is:issue state:closed archived:false reason:${reason}`)}`} className="fg-default">
      {text}
    </Link>
  )
  switch (e.event) {
    case 'committed':
      return (
        <EventRow icon={<GitCommitIcon size={16} />}>
          <span className="fg-default text-truncate" style={{ maxWidth: 520 }}>
            <Link to={`/${owner}/${repo}/commit/${e.sha}`} className="link-plain">
              <InlineTitle text={firstLine(e.message ?? '')} />
            </Link>
          </span>
          <Link to={`/${owner}/${repo}/commit/${e.sha}`} className="commit-sha ml-auto">
            {shortSha(e.sha ?? '')}
          </Link>
        </EventRow>
      )
    case 'labeled':
    case 'unlabeled': {
      const labels = (kind: string) =>
        group
          .filter((g) => g.event === kind && g.label)
          .map((g, i) =>
            issue ? (
              <Link key={`${g.label!.name}-${i}`} to={`/${owner}/${repo}/issues?q=${encodeURIComponent(`state:open label:"${g.label!.name}"`)}`} className="link-plain">
                <IssueLabel name={g.label!.name} color={g.label!.color} />
              </Link>
            ) : (
              <IssueLabel key={`${g.label!.name}-${i}`} name={g.label!.name} color={g.label!.color} />
            ),
          )
      const added = labels('labeled')
      const removed = labels('unlabeled')
      return (
        <EventRow icon={<TagIcon size={16} />}>
          {who} {added.length > 0 && <>added {added}</>} {added.length > 0 && removed.length > 0 && 'and'} {removed.length > 0 && <>removed {removed}</>} {when}
        </EventRow>
      )
    }
    case 'assigned':
    case 'unassigned': {
      const names = (kind: string) => [...new Set(group.filter((g) => g.event === kind && g.assignee).map((g) => g.assignee!.login))]
      const list = (logins: string[]) =>
        logins.map((l, i) => (
          <span key={l}>
            {i > 0 && (i === logins.length - 1 ? ' and ' : ', ')}
            <Link to={`/${l}`} className="fg-default text-bold">
              {l}
            </Link>
          </span>
        ))
      const added = names('assigned')
      const removed = names('unassigned')
      const self = (logins: string[]) => logins.length === 1 && logins[0] === actor?.login
      return (
        <EventRow icon={<PersonIcon size={16} />}>
          {who}{' '}
          {added.length > 0 && (self(added) ? 'self-assigned this' : <>assigned {list(added)}</>)} {added.length > 0 && removed.length > 0 && 'and'}{' '}
          {removed.length > 0 && (self(removed) ? 'removed their assignment' : <>unassigned {list(removed)}</>)} {when}
        </EventRow>
      )
    }
    case 'review_requested':
    case 'review_request_removed': {
      const names = (kind: string) => [...new Set(group.filter((g) => g.event === kind).map((g) => g.requested_reviewer?.login ?? g.requested_team?.name).filter((n): n is string => !!n))]
      const list = (items: string[]) =>
        items.map((n, i) => (
          <span key={n}>
            {i > 0 && (i === items.length - 1 ? ' and ' : ', ')}
            <strong className="fg-default">{n}</strong>
          </span>
        ))
      const added = names('review_requested')
      const removed = names('review_request_removed')
      return (
        <EventRow icon={<EyeIcon size={16} />}>
          {who} {added.length > 0 && <>requested review from {list(added)}</>} {added.length > 0 && removed.length > 0 && 'and'} {removed.length > 0 && <>removed request for {list(removed)}</>} {when}
        </EventRow>
      )
    }
    case 'closed': {
      if (!issue)
        return (
          <EventRow icon={<IssueClosedIcon size={16} />} tone={e.state_reason === 'not_planned' ? undefined : 'done'}>
            {who} closed this {e.state_reason === 'not_planned' ? 'as not planned' : e.state_reason === 'completed' ? 'as completed' : ''} {when}
          </EventRow>
        )
      const notPlanned = e.state_reason === 'not_planned' || e.state_reason === 'duplicate'
      const closerRepo = e.closer?.repo ?? repoOfCommitUrl(e.commit_url, owner, repo)
      const closer = e.closer?.number ? (
        <Link to={`/${closerRepo}/pull/${e.closer.number}`} className="fg-default text-bold">
          {refText(closerRepo, e.closer.number, owner, repo)}
        </Link>
      ) : e.closer?.oid || e.commit_id ? (
        <Link to={`/${closerRepo}/commit/${e.closer?.oid ?? e.commit_id}`} className="text-mono fg-default">
          {shortSha(e.closer?.oid ?? e.commit_id ?? '')}
        </Link>
      ) : null
      return (
        <EventRow icon={notPlanned ? <CircleSlashIcon size={16} /> : <CheckCircleIcon size={16} />} tone={notPlanned ? 'neutral' : 'done'}>
          {who} closed this{' '}
          {e.state_reason === 'not_planned' ? (
            <>as {reasonLink('not-planned', 'not planned')}</>
          ) : e.state_reason === 'duplicate' ? (
            <>as {reasonLink('duplicate', 'duplicate')}</>
          ) : (
            <>as {reasonLink('completed', 'completed')}</>
          )}
          {closer && <> in {closer}</>} {when}
        </EventRow>
      )
    }
    case 'reopened':
      return (
        <EventRow icon={<IssueReopenedIcon size={16} />} tone="success">
          {who} reopened this {when}
        </EventRow>
      )
    case 'merged':
      return (
        <EventRow icon={<GitMergeIcon size={16} />} tone="done">
          {who} merged commit{' '}
          <Link to={`/${owner}/${repo}/commit/${e.commit_id}`} className="text-mono">
            {shortSha(e.commit_id ?? '')}
          </Link>{' '}
          {when}
        </EventRow>
      )
    case 'renamed':
      return (
        <EventRow icon={<PencilIcon size={16} />}>
          {who} changed the title <del className={issue ? 'fg-default' : undefined}>{e.rename?.from}</del> <span className="fg-default">{e.rename?.to}</span> {when}
        </EventRow>
      )
    case 'head_ref_force_pushed':
      return (
        <EventRow icon={<RepoPushIcon size={16} />}>
          {who} force-pushed the branch {when}
        </EventRow>
      )
    case 'head_ref_deleted':
      return (
        <EventRow icon={<GitBranchIcon size={16} />}>
          {who} deleted the head branch {when}
        </EventRow>
      )
    case 'head_ref_restored':
      return (
        <EventRow icon={<GitBranchIcon size={16} />}>
          {who} restored the head branch {when}
        </EventRow>
      )
    case 'base_ref_changed':
      return (
        <EventRow icon={<GitBranchIcon size={16} />}>
          {who} changed the base branch {when}
        </EventRow>
      )
    case 'cross-referenced': {
      const src = e.source?.issue
      if (!src) return null
      const path = (s: typeof src) => `/${s.repository?.full_name ?? `${owner}/${repo}`}/${s.pull_request ? 'pull' : 'issues'}/${s.number}`
      if (!issue) {
        const sameRepo = src.repository?.full_name === `${owner}/${repo}`
        return (
          <EventRow icon={<CrossReferenceIcon size={16} />}>
            {who} mentioned this in{' '}
            <Link to={path(src)} className="fg-default text-bold">
              {src.title}
            </Link>{' '}
            <span className="fg-muted">
              {sameRepo ? '' : src.repository?.full_name}#{src.number}
            </span>{' '}
            {when}
          </EventRow>
        )
      }
      const sources = group.map((g) => g.source?.issue).filter((s): s is typeof src => !!s)
      const pulls = sources.filter((s) => s.pull_request).length
      const text = e.will_close
        ? 'linked a pull request that will close this issue'
        : sources.length < 2 || (pulls > 0 && pulls < sources.length)
          ? 'mentioned this'
          : `mentioned this in ${sources.length} ${pulls ? 'pull requests' : 'issues'}`
      return (
        <EventRow
          icon={<LinkExternalIcon size={16} />}
          below={
            <ul className="timeline-event-refs">
              {sources.map((s, i) => (
                <li key={`${s.html_url}-${i}`}>
                  <SourceIcon src={s} />
                  <Link to={path(s)} className="fg-default">
                    {s.title} <span className="fg-muted">{refText(s.repository?.full_name, s.number, owner, repo)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          }
        >
          {who} {text} {when}
        </EventRow>
      )
    }
    case 'referenced': {
      if (!e.commit_id) return null
      if (!issue) {
        const commitRepo = repoOfCommitUrl(e.commit_url, owner, repo)
        const elsewhere = commitRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
        return (
          <EventRow icon={<GitCommitIcon size={16} />}>
            {who} added a commit{' '}
            {elsewhere && (
              <>
                to{' '}
                <Link to={`/${commitRepo}`} className="fg-default text-bold">
                  {commitRepo}
                </Link>{' '}
              </>
            )}
            that referenced this pull request{' '}
            {e.commit_message && (
              <Link to={`/${commitRepo}/commit/${e.commit_id}`} className="fg-default">
                <InlineTitle text={e.commit_message} />
              </Link>
            )}{' '}
            <Link to={`/${commitRepo}/commit/${e.commit_id}`} className="text-mono">
              {shortSha(e.commit_id)}
            </Link>{' '}
            {when}
          </EventRow>
        )
      }
      const commits = group.filter((g) => g.commit_id)
      const n = commits.length
      return (
        <EventRow
          icon={<GitCommitIcon size={16} />}
          below={
            <ul className="timeline-event-refs">
              {commits.map((c, i) => {
                const to = `/${repoOfCommitUrl(c.commit_url, owner, repo)}/commit/${c.commit_id}`
                return (
                  <li key={`${c.commit_id}-${i}`}>
                    {c.commit_message && (
                      <Link to={to} className="fg-default text-truncate flex-1">
                        <InlineTitle text={c.commit_message} />
                      </Link>
                    )}
                    <Link to={to} className="commit-sha ml-auto">
                      {shortSha(c.commit_id ?? '')}
                    </Link>
                  </li>
                )
              })}
            </ul>
          }
        >
          {who} {`added ${n === 1 ? 'a' : n} commit${n === 1 ? '' : 's'} that reference${n === 1 ? 's' : ''} this issue`} {when}
        </EventRow>
      )
    }
    case 'ready_for_review':
      return (
        <EventRow icon={<EyeIcon size={16} />} tone="accent">
          {who} marked this pull request as ready for review {when}
        </EventRow>
      )
    case 'convert_to_draft':
      return (
        <EventRow icon={<GitPullRequestDraftIcon size={16} />}>
          {who} marked this pull request as draft {when}
        </EventRow>
      )
    case 'milestoned':
    case 'demilestoned':
      if (group.length > 1)
        return (
          <EventRow icon={<MilestoneIcon size={16} />}>
            {who} modified the milestones: <strong className="fg-default">{[...new Set(group.map((g) => g.milestone?.title).filter(Boolean))].join(', ')}</strong> {when}
          </EventRow>
        )
      return (
        <EventRow icon={<MilestoneIcon size={16} />}>
          {who} {e.event === 'milestoned' ? 'added this to the' : 'removed this from the'} <strong className="fg-default">{e.milestone?.title}</strong> milestone {when}
        </EventRow>
      )
    case 'locked':
      return (
        <EventRow icon={<LockIcon size={16} />}>
          {issue ? (
            <>
              {who} locked{e.lock_reason ? ` as ${e.lock_reason.replace(/[-_]/g, ' ')}` : ''} and limited conversation to collaborators {when}
            </>
          ) : (
            <>
              {who} locked this conversation {when}
            </>
          )}
        </EventRow>
      )
    case 'unlocked':
      return (
        <EventRow icon={<UnlockIcon size={16} />}>
          {who} unlocked this conversation {when}
        </EventRow>
      )
    case 'pinned':
    case 'unpinned':
      return (
        <EventRow icon={<PinIcon size={16} />}>
          {who} {e.event === 'pinned' ? 'pinned' : 'unpinned'} this {issue ? 'issue' : 'pull request'} {when}
        </EventRow>
      )
    case 'connected':
    case 'disconnected':
      return (
        <EventRow icon={<CrossReferenceIcon size={16} />}>
          {who}{' '}
          {issue
            ? e.event === 'connected'
              ? 'linked a pull request that will close this issue'
              : 'removed a link to a pull request'
            : e.event === 'connected'
              ? 'linked an issue that may be closed by this pull request'
              : 'removed a link to an issue'}{' '}
          {when}
        </EventRow>
      )
    case 'marked_as_duplicate':
    case 'unmarked_as_duplicate':
      return (
        <EventRow icon={<CircleSlashIcon size={16} />}>
          {who} {e.event === 'marked_as_duplicate' ? 'marked this as a duplicate' : 'unmarked this as a duplicate'} {when}
        </EventRow>
      )
    case 'transferred':
      return (
        <EventRow icon={<ArrowRightIcon size={16} />}>
          {who} transferred this issue {when}
        </EventRow>
      )
    case 'converted_to_discussion':
      return (
        <EventRow icon={<CommentDiscussionIcon size={16} />}>
          {who} converted this issue into a discussion {when}
        </EventRow>
      )
    case 'sub_issue_added':
    case 'sub_issue_removed':
    case 'parent_issue_added':
    case 'parent_issue_removed':
      return (
        <EventRow icon={<IssueTracksIcon size={16} />}>
          {who} {e.event.startsWith('sub_issue') ? (e.event.endsWith('added') ? 'added a sub-issue' : 'removed a sub-issue') : e.event.endsWith('added') ? 'added a parent issue' : 'removed a parent issue'} {when}
        </EventRow>
      )
    case 'auto_merge_enabled':
    case 'auto_squash_enabled':
    case 'auto_rebase_enabled':
      return (
        <EventRow icon={<GitMergeIcon size={16} />}>
          {who} enabled auto-merge {when}
        </EventRow>
      )
    case 'auto_merge_disabled':
      return (
        <EventRow icon={<GitMergeIcon size={16} />}>
          {who} disabled auto-merge {when}
        </EventRow>
      )
    case 'review_dismissed':
      return (
        <EventRow icon={<EyeClosedIcon size={16} />}>
          {who} dismissed a review {when}
        </EventRow>
      )
    case 'deployed':
    case 'deployment_environment_changed':
      return (
        <EventRow icon={<RepoPushIcon size={16} />}>
          {who} deployed {when}
        </EventRow>
      )
    case 'mentioned':
    case 'subscribed':
    case 'unsubscribed':
    case 'comment_deleted':
    case 'commented':
    case 'reviewed':
    case 'line-commented':
    case 'commit-commented':
      return null
    default:
      return e.event ? (
        <EventRow icon={<DotFillIcon size={16} />}>
          {who} {e.event.replace(/_/g, ' ')} {when}
        </EventRow>
      ) : null
  }
}

export function ReviewStateBadge({ state }: { state: string }) {
  if (state === 'APPROVED')
    return (
      <span className="timeline-badge success">
        <CheckIcon size={16} />
      </span>
    )
  if (state === 'CHANGES_REQUESTED')
    return (
      <span className="timeline-badge danger">
        <FileDiffIcon size={16} />
      </span>
    )
  if (state === 'DISMISSED')
    return (
      <span className="timeline-badge">
        <EyeClosedIcon size={16} />
      </span>
    )
  return (
    <span className="timeline-badge">
      <EyeIcon size={16} />
    </span>
  )
}

export function reviewVerb(state: string) {
  if (state === 'APPROVED') return 'approved these changes'
  if (state === 'CHANGES_REQUESTED') return 'requested changes'
  if (state === 'DISMISSED') return 'reviewed (dismissed)'
  if (state === 'PENDING') return 'started a review'
  return 'reviewed'
}
