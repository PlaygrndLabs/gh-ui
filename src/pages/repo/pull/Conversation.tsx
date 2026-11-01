import { useCallback, useMemo, useState } from 'react'
import { Banner, Button, Label, RelativeTime } from '@primer/react'
import { GitCommitIcon, SparkleFillIcon } from '@primer/octicons-react'
import { useGitHub, setThreadResolved, addPendingReply, updatePendingComment, deletePendingComment, type PendingReviewComment, type PullRequest } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { useAgent } from '../../../lib/agent/AgentProvider'
import { botName, ErrorBox, Loading, UserAvatar, UserLink, isBot } from '../../../components/Bits'
import { Composer } from '../../../components/Composer'
import { Markdown } from '../../../components/Markdown'
import { CommentCard, EventRow, PendingComment, PendingThread, ReviewThread, ReviewStateBadge, SimpleEvent, buildThreads, reviewVerb, rollupEvents, type LooseEvent, type ThreadModel } from '../../../components/Timeline'
import { SuggestionProvider } from '../../../components/Suggestions'
import { IssueSidebar, usePullExtra } from '../../../components/IssueSidebar'
import { useTimeline, useReviewComments, useReviewThreads, usePullFiles, usePullReviewState, useInvalidatePull, botThreadsSummary, diffLineMap, prPrompts } from './data'
import { MergeBox } from './MergeBox'

export function threadPrompt(owner: string, repo: string, pr: PullRequest, t: ThreadModel) {
  const who = t.root.user?.login ?? 'a reviewer'
  return `Address the review thread on ${owner}/${repo}#${pr.number} started by ${who} on ${t.root.path}${t.root.line ? `:${t.root.line}` : ''} (comment id ${t.root.id}${t.info ? `, thread id ${t.info.id}` : ''}). Verify the concern against the code at head ${pr.head.sha} on branch ${pr.head.ref}. If it is valid, fix it with commit_files (expected_head_sha ${pr.head.sha}), reply in the thread with what changed and the commit SHA, and resolve the thread. If it is not valid, reply with a short explanation and leave it open.`
}

export function Conversation({ pr }: { pr: PullRequest & { body_html?: string } }) {
  const { owner, repo, fullName } = useRepo()
  const { octokit, account } = useGitHub()
  const agent = useAgent()
  const timeline = useTimeline(owner, repo, pr.number)
  const comments = useReviewComments(owner, repo, pr.number)
  const threadInfo = useReviewThreads(owner, repo, pr.number)
  const reviewState = usePullReviewState(owner, repo, pr.number)
  // The diff tells whether a suggestion's lines still hold the code it was written against.
  const files = usePullFiles(owner, repo, pr.number)
  const invalidate = useInvalidatePull(owner, repo, pr.number)
  // pr.updated_at moves with every push or comment; only lastEditedAt says the description was edited.
  const pullExtra = usePullExtra(owner, repo, pr.number, true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'comment' | 'state' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const threads = useMemo(() => buildThreads(comments.data ?? [], threadInfo.data), [comments.data, threadInfo.data])
  const events = useMemo(() => rollupEvents(timeline.data ?? [], { pull: true }), [timeline.data])
  const threadsByReview = useMemo(() => {
    const m = new Map<number, ThreadModel[]>()
    for (const t of threads) {
      const id = t.root.pull_request_review_id ?? 0
      m.set(id, [...(m.get(id) ?? []), t])
    }
    return m
  }, [threads])
  const diffLines = useMemo(() => diffLineMap(files.data), [files.data])
  const currentLine = useCallback((path: string, n: number) => diffLines.get(`${path}|RIGHT:${n}`), [diffLines])
  const serverReview = reviewState.data?.pending ?? null
  const bots = botThreadsSummary(comments.data, threadInfo.data)
  const prompts = prPrompts(owner, repo, pr)
  const canModerate = !!pr.base.repo.permissions?.push

  const run = async (kind: 'comment' | 'state', fn: () => Promise<unknown>) => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
      invalidate()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }
  // For editors that clear or close on success: rejecting keeps the typed text when the request fails.
  const runStrict = async (fn: () => Promise<unknown>) => {
    if (!(await run('comment', fn))) throw new Error('Request failed')
  }

  const pendingComment = (c: PendingReviewComment) => (
    <PendingComment
      key={c.id}
      login={account.login}
      avatarUrl={account.avatarUrl}
      body={c.body}
      bodyHtml={c.bodyHTML}
      context={fullName}
      onEdit={(body) => runStrict(() => updatePendingComment(octokit, c.id, body))}
      onDelete={() => run('comment', () => deletePendingComment(octokit, c.id))}
      confirmDelete
    />
  )

  const threadProps = (t: ThreadModel) => ({
    thread: t,
    context: fullName,
    viewerLogin: account.login,
    replyLabel: serverReview ? 'Add review comment' : undefined,
    pendingReplies: serverReview?.comments.filter((c) => c.replyTo === t.root.id).map(pendingComment),
    // REST replies fail while the viewer has a pending review; github.com adds them to it.
    onReply: (body: string) =>
      runStrict(() =>
        serverReview && t.info
          ? addPendingReply(octokit, serverReview.id, t.info.id, body)
          : octokit.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: pr.number, comment_id: t.root.id, body }),
      ),
    onResolve: (resolved: boolean) => runStrict(() => setThreadResolved(octokit, t.info!.id, resolved)),
    onAskAgent: (p: string) => agent.ask(p),
    agentPrompt: threadPrompt(owner, repo, pr, t),
    onEditComment: (id: number, body: string) => runStrict(() => octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: id, body })),
    onDeleteComment: (id: number) => run('comment', () => octokit.rest.pulls.deleteReviewComment({ owner, repo, comment_id: id })),
  })

  const renderEvent = (e: LooseEvent, i: number) => {
    if (e.event === 'commented') {
      const bot = isBot(e.user?.login ?? e.actor?.login, e.user?.type)
      return (
        <CommentCard
          key={`c${e.id ?? i}`}
          author={e.user?.login ?? e.actor?.login}
          authorType={e.user?.type}
          avatar={e.user?.avatar_url ?? e.actor?.avatar_url}
          association={e.author_association}
          createdAt={e.created_at!}
          updatedAt={e.updated_at}
          bodyHtml={e.body_html}
          body={e.body}
          context={fullName}
          isIssueAuthor={e.user?.login === pr.user?.login}
          viewerDidAuthor={e.user?.login === account.login}
          canEdit={e.user?.login === account.login}
          htmlUrl={e.html_url}
          reactions={e.reactions}
          onQuote={(q) => setDraft((d) => d + q)}
          onAskAgent={(p) => agent.ask(p)}
          agentPrompt={
            bot
              ? `Read this comment by ${e.user?.login} on ${owner}/${repo}#${pr.number} (issue comment id ${e.id}). Verify each actionable point against the code at head ${pr.head.sha}; fix the valid ones on ${pr.head.ref}, then post one reply comment summarizing what you changed (with SHAs) and what you did not change and why.\n\nComment:\n${e.body ?? ''}`
              : undefined
          }
          onEdit={(body) => runStrict(() => octokit.rest.issues.updateComment({ owner, repo, comment_id: e.id!, body }))}
          onDelete={() => run('comment', () => octokit.rest.issues.deleteComment({ owner, repo, comment_id: e.id! }))}
        />
      )
    }
    if (e.event === 'reviewed' && e.state?.toUpperCase() === 'PENDING') {
      // Only its author sees a pending review; its comments come from GraphQL (REST lists none of them).
      const own = serverReview && serverReview.databaseId === e.id ? serverReview.comments.filter((c) => c.replyTo === null) : []
      return (
        <div key={`r${e.id}`} className="mb-3">
          <div className="timeline-event" style={{ marginBottom: 8 }}>
            <ReviewStateBadge state="PENDING" />
            <span className="flex-center gap-1 wrap">
              <UserAvatar login={e.user?.login} src={e.user?.avatar_url} size={20} />
              <UserLink login={e.user?.login} type={e.user?.type} className="actor" /> {reviewVerb('PENDING')}
              <Label variant="attention" size="small">
                Pending
              </Label>
            </span>
          </div>
          {own.length > 0 && (
            <div className="review-block">
              {own.map((c) => (
                <PendingThread key={c.id} comment={c}>
                  {pendingComment(c)}
                </PendingThread>
              ))}
            </div>
          )}
        </div>
      )
    }
    if (e.event === 'reviewed') {
      const reviewThreads = threadsByReview.get(e.id ?? -1) ?? []
      if (!e.body && reviewThreads.length === 0 && (e.state === 'COMMENTED' || e.state === 'commented')) return null
      const state = (e.state ?? '').toUpperCase()
      return (
        <div key={`r${e.id}`} className="mb-3">
          <div className="timeline-event" style={{ marginBottom: 8 }}>
            <ReviewStateBadge state={state} />
            <span className="flex-center gap-1 wrap">
              <UserAvatar login={e.user?.login} src={e.user?.avatar_url} size={20} square={isBot(e.user?.login, e.user?.type)} />
              <UserLink login={e.user?.login} type={e.user?.type} className="actor" /> {reviewVerb(state)}{' '}
              {e.submitted_at && (
                <span className="link-muted">
                  <RelativeTime date={new Date(e.submitted_at)} />
                </span>
              )}
            </span>
          </div>
          {(e.body || reviewThreads.length > 0) && (
            <div className="review-block">
              {e.body && (
                <div style={{ padding: 16, borderBottom: reviewThreads.length ? '1px solid var(--borderColor-muted)' : 0 }}>
                  <Markdown html={e.body_html} text={e.body_html ? undefined : e.body} context={fullName} />
                  {isBot(e.user?.login, e.user?.type) && (
                    <div className="mt-2">
                      <Button size="small" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(prompts.bots)}>
                        Address {botName(e.user?.login ?? '')} review
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {reviewThreads.map((t) => (
                <ReviewThread key={t.root.id} showHunk {...threadProps(t)} />
              ))}
            </div>
          )}
        </div>
      )
    }
    const simple = <SimpleEvent key={`e${e.id ?? e.node_id ?? e.sha ?? i}`} e={e} owner={owner} repo={repo} />
    // github.com heads each run of two or more pushed commits with "<author> [and others] added N commits".
    if (e.event === 'committed' && events[i - 1]?.event !== 'committed' && events[i + 1]?.event === 'committed') {
      let n = 1
      while (events[i + n]?.event === 'committed') n++
      const authors = new Set(events.slice(i, i + n).map((c) => c.author?.name).filter(Boolean))
      const first = e.author?.name ?? 'Someone'
      return (
        <div key={`g${e.sha ?? i}`}>
          <EventRow icon={<GitCommitIcon size={16} />}>
            <span className="actor">{first}</span>
            {authors.size > 1 && ' and others'} added {n} commits{' '}
            {e.author?.date && (
              <span className="link-muted">
                <RelativeTime date={new Date(e.author.date)} />
              </span>
            )}
          </EventRow>
          {simple}
        </div>
      )
    }
    return simple
  }

  return (
    <SuggestionProvider pr={pr} canApply={!!reviewState.data?.viewerCanApplySuggestion} currentLine={currentLine} onCommitted={invalidate}>
      <div className="layout-sidebar">
        <div style={{ minWidth: 0 }}>
          {bots.size > 0 && (
            <div className="mb-3">
              <Banner
                variant="info"
                title={`${[...bots.values()].reduce((a, b) => a + b, 0)} unresolved comments from review bots`}
                description={[...bots.entries()].map(([b, c]) => `${botName(b)} (${c})`).join(', ')}
                leadingVisual={<SparkleFillIcon />}
                primaryAction={
                  <Banner.PrimaryAction onClick={() => agent.ask(prompts.bots)} leadingVisual={SparkleFillIcon}>
                    Address with agent
                  </Banner.PrimaryAction>
                }
              />
            </div>
          )}
          <CommentCard
            author={pr.user?.login}
            authorType={pr.user?.type}
            avatar={pr.user?.avatar_url}
            association={pr.author_association}
            createdAt={pr.created_at}
            updatedAt={pullExtra.data?.lastEditedAt ?? undefined}
            bodyHtml={pr.body_html || null}
            body={pr.body}
            context={fullName}
            isIssueAuthor
            viewerDidAuthor={pr.user?.login === account.login}
            canEdit={pr.user?.login === account.login || canModerate}
            htmlUrl={pr.html_url}
            onQuote={(q) => setDraft((d) => d + q)}
            onAskAgent={(p) => agent.ask(p)}
            agentPrompt={prompts.summary}
            onEdit={(body) => runStrict(() => octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, body }))}
          />
          {timeline.isLoading ? <Loading /> : timeline.error ? <ErrorBox error={timeline.error} /> : events.map(renderEvent)}
          <div className="timeline-spacer" />
          <MergeBox pr={pr} />
          {error && <div className="error-box mb-3">{error}</div>}
          <div className="timeline-comment-group mt-3">
            <div className="avatar-col">
              <UserAvatar login={account.login} src={account.avatarUrl} size={40} />
            </div>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <div className="text-bold mb-2" style={{ fontSize: 16 }}>
                Add a comment
              </div>
              <Composer
                value={draft}
                onChange={setDraft}
                context={fullName}
                onSubmitShortcut={() => draft.trim() && void run('comment', async () => (await octokit.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: draft }), setDraft('')))}
                actions={
                  <>
                    {!pr.merged && (pr.user?.login === account.login || canModerate) && (
                      <Button
                        loading={busy === 'state'}
                        onClick={() =>
                          run('state', async () => {
                            if (draft.trim()) await octokit.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: draft })
                            await octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, state: pr.state === 'open' ? 'closed' : 'open' })
                            setDraft('')
                          })
                        }
                      >
                        {pr.state === 'open' ? (draft.trim() ? 'Close with comment' : 'Close pull request') : 'Reopen pull request'}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      disabled={!draft.trim()}
                      loading={busy === 'comment'}
                      onClick={() =>
                        run('comment', async () => {
                          await octokit.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: draft })
                          setDraft('')
                        })
                      }
                    >
                      Comment
                    </Button>
                  </>
                }
              />
            </div>
          </div>
        </div>
        <IssueSidebar number={pr.number} isPull pull={pr} labels={pr.labels} assignees={pr.assignees ?? []} milestone={pr.milestone} onChanged={invalidate} />
      </div>
    </SuggestionProvider>
  )
}
