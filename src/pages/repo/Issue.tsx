import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, ButtonGroup, IconButton, TextInput } from '@primer/react'
import { SparkleFillIcon, LinkExternalIcon, LinkIcon, TriangleDownIcon, IssueClosedIcon, SkipIcon, CopyIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage, FULL_BODY, type Issue } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { AgentOnly, useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { webUrl } from '../../lib/links'
import { isNative, openExternal } from '../../lib/platform'
import { copyText } from '../../lib/format'
import { CopyButton, ErrorBox, InlineTitle, Loading, UserAvatar, isBot } from '../../components/Bits'
import { IssueStateLabel, PullStateIcon } from '../../components/Status'
import { Composer } from '../../components/Composer'
import { CommentCard, SimpleEvent, rollupEvents, type LooseEvent } from '../../components/Timeline'
import { IssueSidebar, useIssueExtra } from '../../components/IssueSidebar'

export function IssuePage() {
  const { owner, repo, fullName, data } = useRepo()
  const { number: n = '' } = useParams()
  const number = Number(n)
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const agent = useAgent()
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const issue = useQuery({
    queryKey: [key, 'issue', owner, repo, number],
    queryFn: async () => (await octokit.rest.issues.get({ owner, repo, issue_number: number, ...FULL_BODY })).data as Issue & { body_html?: string },
  })
  const timeline = useQuery({
    queryKey: [key, 'timeline', owner, repo, number],
    queryFn: async () => (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, { owner, repo, issue_number: number, per_page: 100, ...FULL_BODY })) as unknown as LooseEvent[],
  })
  // Linked pull requests, what closed the issue and referenced commits' messages: REST has none of them.
  const extra = useIssueExtra(owner, repo, number, !!issue.data && !issue.data.pull_request)
  const events = useMemo(() => {
    const closers = new Map<string, LooseEvent['closer']>()
    const messages = new Map<string, string>()
    const closing = new Set<string>()
    for (const n of extra.data?.timelineItems.nodes ?? []) {
      if (n.__typename === 'CrossReferencedEvent' && n.willCloseTarget && n.source?.url) closing.add(n.source.url)
      const id = n.url?.match(/#event-(\d+)$/)?.[1]
      if (n.__typename === 'ClosedEvent' && id && n.closer?.repository)
        closers.set(id, { number: n.closer.number, oid: n.closer.oid, repo: n.closer.repository.nameWithOwner })
      if (n.__typename === 'ReferencedEvent' && n.commit) messages.set(n.commit.oid, n.commit.messageHeadline)
    }
    const enriched = (timeline.data ?? []).map((e) => {
      if (e.event === 'closed' && closers.has(String(e.id))) return { ...e, closer: closers.get(String(e.id)) }
      if (e.event === 'referenced' && e.commit_id && messages.has(e.commit_id)) return { ...e, commit_message: messages.get(e.commit_id) }
      if (e.event === 'cross-referenced' && e.source?.issue && closing.has(e.source.issue.html_url)) return { ...e, will_close: true }
      return e
    })
    return rollupEvents(enriched)
  }, [timeline.data, extra.data])

  // Comment editors close only when this resolves, so failures are shown and rethrown.
  const reportAndRethrow = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      setError(null)
      refresh()
    } catch (e) {
      setError(errorMessage(e))
      throw e
    }
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [key, 'issue', owner, repo, number] })
    void qc.invalidateQueries({ queryKey: [key, 'timeline', owner, repo, number] })
    void qc.invalidateQueries({ queryKey: [key, 'issue-extra', owner, repo, number] })
    void qc.invalidateQueries({ queryKey: [key, 'repo-counts', owner, repo] })
  }

  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (e) => setError(errorMessage(e)),
  })

  const i = issue.data
  useAgentPageContext(
    i
      ? {
          label: `issue ${fullName}#${number} “${i.title}”`,
          tabTitle: `#${number} ${i.title}`,
          owner,
          repo,
          details: { state: i.state, author: i.user?.login, labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(', ') },
          suggestions: [
            { label: 'Summarize', prompt: `Summarize issue ${fullName}#${number} and its discussion: the problem, what's been tried, and open questions.` },
            { label: 'Find the cause', prompt: `Investigate issue ${fullName}#${number}: find the code most likely responsible, explain the probable cause, and sketch a fix. Don't change anything.` },
            { label: 'Draft a reply', prompt: `Draft a helpful reply to issue ${fullName}#${number}. Show me the draft; don't post it.` },
          ],
        }
      : null,
  )

  if (i && i.pull_request) return <Navigate to={`/${owner}/${repo}/pull/${number}`} replace />
  if (issue.isLoading) return <Loading />
  if (issue.error || !i)
    return (
      <div className="container-xl">
        <ErrorBox error={issue.error} />
      </div>
    )
  const canModerate = !!data.permissions?.push || !!data.permissions?.triage
  const canEditIssue = canModerate || i.user?.login === account.login

  const linkedPulls = extra.data?.closedByPullRequestsReferences?.nodes ?? []
  return (
    <div className="container-xl issue-page">
      <div className="issue-header">
        {editingTitle ? (
          <form
            className="flex-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              act.mutate(async () => {
                await octokit.rest.issues.update({ owner, repo, issue_number: number, title })
                setEditingTitle(false)
              })
            }}
          >
            <TextInput block size="large" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Title" />
            <Button type="submit">Save</Button>
            <Button variant="invisible" onClick={() => setEditingTitle(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
            <h1 className="page-title flex-1">
              <InlineTitle text={i.title} /> <span className="num">#{i.number}</span>
            </h1>
            <span className="shrink-0" style={{ marginTop: 6 }}>
              <CopyButton text={i.html_url} label="Copy issue link" size="medium" icon={LinkIcon} />
            </span>
            <span className="flex-center gap-2 shrink-0 issue-header-actions">
              {canEditIssue && <Button onClick={() => (setTitle(i.title), setEditingTitle(true))}>Edit</Button>}
              <Button as={Link} to={`/${owner}/${repo}/issues/new`} variant="primary">
                New issue
              </Button>
              <AgentOnly><Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Investigate issue ${fullName}#${number}: find the relevant code and explain the likely cause and fix.`)}>
                Agent
              </Button></AgentOnly>
              {!isNative && (
                <>
                  <IconButton variant="invisible" icon={CopyIcon} aria-label="Copy link" onClick={() => void copyText(i.html_url)} />
                  <IconButton variant="invisible" icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/issues/${number}`))} />
                </>
              )}
            </span>
          </div>
        )}
        {/* github.com's metadata row: the state and the pull requests that close the issue. */}
        <div className="issue-meta-row">
          <IssueStateLabel issue={i} />
          {linkedPulls.length > 0 && (
            <span className="issue-linked-pulls">
              {linkedPulls.map((pr) => {
                const [o, r] = pr.repository.nameWithOwner.split('/')
                const same = pr.repository.nameWithOwner.toLowerCase() === fullName.toLowerCase()
                return (
                  <Link key={pr.url} to={`/${o}/${r}/pull/${pr.number}`} title={pr.title}>
                    <PullStateIcon pull={{ state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.merged, draft: pr.isDraft }} />
                    {same ? `#${pr.number}` : `${pr.repository.nameWithOwner}#${pr.number}`}
                  </Link>
                )
              })}
            </span>
          )}
        </div>
      </div>

      <div className="layout-sidebar">
        <div className="issue-timeline" style={{ minWidth: 0 }}>
          {/* github.com shows the association badge on the description too, and "opened" instead of "commented". */}
          <CommentCard
            author={i.user?.login}
            authorType={i.user?.type}
            avatar={i.user?.avatar_url}
            association={i.author_association}
            createdAt={i.created_at}
            updatedAt={extra.data?.lastEditedAt ?? undefined}
            bodyHtml={i.body_html || null}
            body={i.body}
            context={fullName}
            verb="opened"
            inlineAvatar
            viewerDidAuthor={i.user?.login === account.login}
            canEdit={canEditIssue}
            htmlUrl={i.html_url}
            reactions={i.reactions}
            onQuote={(q) => setDraft((d) => d + q)}
            onAskAgent={(p) => agent.ask(p)}
            onEdit={(body) => reportAndRethrow(() => octokit.rest.issues.update({ owner, repo, issue_number: number, body }))}
          />
          {timeline.isLoading ? (
            <Loading />
          ) : (
            events.map((e, idx) =>
              e.event === 'commented' ? (
                <CommentCard
                  key={`c${e.id}`}
                  author={e.user?.login ?? e.actor?.login}
                  authorType={e.user?.type}
                  avatar={e.user?.avatar_url}
                  association={e.author_association}
                  createdAt={e.created_at!}
                  updatedAt={e.updated_at}
                  bodyHtml={e.body_html}
                  body={e.body}
                  context={fullName}
                  verb={null}
                  inlineAvatar
                  isIssueAuthor={e.user?.login === i.user?.login}
                  viewerDidAuthor={e.user?.login === account.login}
                  canEdit={e.user?.login === account.login}
                  htmlUrl={e.html_url}
                  reactions={e.reactions}
                  onQuote={(q) => setDraft((d) => d + q)}
                  onAskAgent={(p) => agent.ask(p)}
                  agentPrompt={isBot(e.user?.login, e.user?.type) ? `Explain this comment from ${e.user?.login} on ${fullName}#${number} and whether anything needs to be done:\n\n${e.body ?? ''}` : undefined}
                  onEdit={(body) => reportAndRethrow(() => octokit.rest.issues.updateComment({ owner, repo, comment_id: e.id!, body }))}
                  onDelete={() => reportAndRethrow(() => octokit.rest.issues.deleteComment({ owner, repo, comment_id: e.id! })).catch(() => {})}
                />
              ) : (
                <SimpleEvent key={`e${e.id ?? e.node_id ?? idx}`} e={e} owner={owner} repo={repo} variant="issue" />
              ),
            )
          )}
          <div className="timeline-spacer" />
          {error && <div className="error-box mb-3">{error}</div>}
          <div className="issue-new-comment">
            <h2 className="issue-new-comment-heading">
              <UserAvatar login={account.login} src={account.avatarUrl} size={24} />
              Add a comment
            </h2>
            <div style={{ minWidth: 0 }}>
              <Composer
                value={draft}
                onChange={setDraft}
                context={fullName}
                placeholder="Use Markdown to format your comment"
                onSubmitShortcut={() => draft.trim() && act.mutate(async () => (await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: draft }), setDraft('')))}
                actions={
                  <>
                    {canEditIssue &&
                      (i.state === 'open' ? (
                        <ButtonGroup>
                          <Button
                            leadingVisual={IssueClosedIcon}
                            onClick={() =>
                              act.mutate(async () => {
                                if (draft.trim()) await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: draft })
                                await octokit.rest.issues.update({ owner, repo, issue_number: number, state: 'closed', state_reason: 'completed' })
                                setDraft('')
                              })
                            }
                          >
                            {draft.trim() ? 'Close with comment' : 'Close issue'}
                          </Button>
                          <ActionMenu>
                            <ActionMenu.Anchor>
                              <IconButton icon={TriangleDownIcon} aria-label="More close options" />
                            </ActionMenu.Anchor>
                            <ActionMenu.Overlay>
                              <ActionList>
                                <ActionList.Item onSelect={() => act.mutate(() => octokit.rest.issues.update({ owner, repo, issue_number: number, state: 'closed', state_reason: 'not_planned' }))}>
                                  <ActionList.LeadingVisual>
                                    <SkipIcon />
                                  </ActionList.LeadingVisual>
                                  Close as not planned
                                </ActionList.Item>
                              </ActionList>
                            </ActionMenu.Overlay>
                          </ActionMenu>
                        </ButtonGroup>
                      ) : (
                        <Button onClick={() => act.mutate(() => octokit.rest.issues.update({ owner, repo, issue_number: number, state: 'open' }))}>Reopen issue</Button>
                      ))}
                    <Button
                      variant="primary"
                      disabled={!draft.trim()}
                      loading={act.isPending}
                      onClick={() =>
                        act.mutate(async () => {
                          await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: draft })
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
        <IssueSidebar number={number} labels={i.labels} assignees={i.assignees ?? []} milestone={i.milestone} onChanged={refresh} />
      </div>
    </div>
  )
}

export function NewIssuePage() {
  const { owner, repo, fullName } = useRepo()
  const { octokit, account } = useGitHub()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const create = useMutation({
    mutationFn: async () => (await octokit.rest.issues.create({ owner, repo, title, body })).data,
    onSuccess: (d) => navigate(`/${owner}/${repo}/issues/${d.number}`),
  })
  useAgentPageContext({ label: `the new issue form in ${fullName}`, owner, repo })
  return (
    <div className="container-lg">
      <h2 className="section-title">Create new issue</h2>
      <div className="timeline-comment-group">
        <div className="avatar-col">
          <UserAvatar login={account.login} src={account.avatarUrl} size={40} />
        </div>
        <div className="flex-1" style={{ minWidth: 0 }}>
          <TextInput data-tab-draft block size="large" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus className="mb-3" />
          <Composer
            value={body}
            onChange={setBody}
            context={fullName}
            rows={10}
            placeholder="Add a description"
            actions={
              <Button variant="primary" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                Submit new issue
              </Button>
            }
          />
          {create.error && <div className="error-box mt-2">{errorMessage(create.error)}</div>}
        </div>
      </div>
    </div>
  )
}
