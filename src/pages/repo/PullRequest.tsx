import { useState } from 'react'
import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, IconButton, TextInput, UnderlineNav } from '@primer/react'
import { CommentDiscussionIcon, GitCommitIcon, ChecklistIcon, FileDiffIcon, SparkleFillIcon, TriangleDownIcon, LinkExternalIcon, PencilIcon, LinkIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { encodePath, useRepo } from '../../lib/repo'
import { AgentOnly, useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { webUrl } from '../../lib/links'
import { isNative, openExternal } from '../../lib/platform'
import { plural } from '../../lib/format'
import { CopyButton, DiffStat, ErrorBox, InlineTitle, Loading, UserLink } from '../../components/Bits'
import { PullStateLabel } from '../../components/Status'
import { usePull, useChecks, useReviewComments, useReviewThreads, botThreadsSummary, summarizeChecks, prPrompts, useInvalidatePull } from './pull/data'
import { Conversation } from './pull/Conversation'
import { FilesChanged } from './pull/Files'
import { PullCommits } from './pull/Commits'
import { ChecksTab } from './pull/Checks'
import { SplitPane } from '../../components/SplitPane'
import { PullCommitsPane, PullStatusBar } from '../workspace/PullsWorkspace'
import { CheckoutMenu, PullStatusLine } from './pull/PullHeaderActions'

/**
 * A base or head branch that opens its code, the way github.com links them. A closed pull request's head branch is
 * often deleted after the merge: that one is struck through instead, since there's nothing left to open.
 */
function BranchPill({ repo, branch, label, checkDeleted }: { repo: string | undefined; branch: string; label: string; checkDeleted?: boolean }) {
  const { octokit, key } = useGitHub()
  const exists = useQuery({
    queryKey: [key, 'branch-exists', repo, branch],
    enabled: !!repo && !!checkDeleted,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const [o, r] = repo!.split('/')
      try {
        await octokit.rest.repos.getBranch({ owner: o, repo: r, branch })
        return true
      } catch (e) {
        if ((e as { status?: number }).status === 404) return false
        throw e
      }
    },
  })
  // No repository means the fork it came from is gone.
  if (!repo || exists.data === false)
    return (
      <span className="branch-pill is-deleted" title={repo ? `${label} has been deleted` : `The repository ${label} came from has been deleted`}>
        {label}
      </span>
    )
  return (
    <Link to={`/${repo}/tree/${encodePath(branch)}`} className="branch-pill" title={label}>
      {label}
    </Link>
  )
}

/** Keyed per PR so every tab's local state (drafts, pending reviews, merge box) starts fresh. */
export function PullRequestPage() {
  const { owner, repo } = useRepo()
  const { number = '' } = useParams()
  return <PullRequestView key={`${owner}/${repo}#${number}`} />
}

function PullRequestView() {
  const { owner, repo } = useRepo()
  const { number: n = '' } = useParams()
  const number = Number(n)
  const { octokit, account } = useGitHub()
  const { pathname } = useLocation()
  const agent = useAgent()
  const pull = usePull(owner, repo, number)
  const pr = pull.data
  const checks = useChecks(owner, repo, pr?.head.sha)
  const comments = useReviewComments(owner, repo, number)
  const threads = useReviewThreads(owner, repo, number)
  const invalidate = useInvalidatePull(owner, repo, number)
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')
  const [chatOnly, setChatOnly] = useState(false)

  const saveTitle = useMutation({
    mutationFn: async () => octokit.rest.pulls.update({ owner, repo, pull_number: number, title }),
    onSuccess: () => {
      setEditingTitle(false)
      invalidate()
    },
  })

  const checkSummary = summarizeChecks(checks.data)
  const bots = botThreadsSummary(comments.data, threads.data)
  const unresolvedBot = [...bots.values()].reduce((a, b) => a + b, 0)
  const prompts = pr ? prPrompts(owner, repo, pr) : null

  useAgentPageContext(
    pr
      ? {
          label: `pull request ${owner}/${repo}#${number} “${pr.title}”`,
          tabTitle: `#${number} ${pr.title}`,
          owner,
          repo,
          details: {
            state: pr.merged ? 'merged' : pr.state,
            draft: pr.draft,
            author: pr.user?.login,
            base: pr.base.ref,
            head: pr.head.ref,
            head_sha: pr.head.sha,
            head_repo: pr.head.repo?.full_name,
            checks: checkSummary.total ? `${checkSummary.passed} passed, ${checkSummary.failed} failed, ${checkSummary.pending} pending` : 'none',
            unresolved_bot_threads: unresolvedBot ? [...bots.entries()].map(([b, c]) => `${b}: ${c}`).join(', ') : 0,
            tab: pathname.endsWith('/files') ? 'Files changed' : pathname.endsWith('/checks') ? 'Checks' : pathname.endsWith('/commits') ? 'Commits' : 'Conversation',
          },
          suggestions: [
            { label: 'Review this PR', prompt: prompts!.review },
            ...(unresolvedBot ? [{ label: `Address ${unresolvedBot} bot comment${unresolvedBot === 1 ? '' : 's'}`, prompt: prompts!.bots }] : []),
            ...(checkSummary.failed ? [{ label: 'Fix failing checks', prompt: prompts!.checks }] : []),
            { label: 'Summarize', prompt: prompts!.summary },
          ],
        }
      : null,
  )

  if (pull.isLoading) return <Loading label="Loading pull request" />
  if (pull.error || !pr)
    return (
      <div className="container-xl">
        <ErrorBox error={pull.error} title={`Could not load pull request #${number}`} />
      </div>
    )

  const base = `/${owner}/${repo}/pull/${number}`
  const tab = pathname.endsWith('/files') ? 'files' : pathname.endsWith('/checks') ? 'checks' : pathname.endsWith('/commits') ? 'commits' : 'conversation'
  const canEdit = pr.user?.login === account.login || !!pr.base.repo.permissions?.push
  // Like github.com: owner-qualify the base branch when the head comes from a fork.
  const fromFork = !!pr.head.repo && pr.head.repo.owner.login !== pr.base.repo.owner.login
  const baseLabel = fromFork ? `${pr.base.repo.owner.login}:${pr.base.ref}` : pr.base.ref

  // github.com lays out Files changed and Checks across the full width; Conversation and Commits stay in the 1280px container.
  const fullWidth = tab === 'files' || tab === 'checks'
  const header = (
      <div className="mb-3">
        {editingTitle ? (
          <form
            className="flex-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              saveTitle.mutate()
            }}
          >
            <TextInput block value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Title" size="large" />
            <Button type="submit" loading={saveTitle.isPending}>
              Save
            </Button>
            <Button variant="invisible" onClick={() => setEditingTitle(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
            <h1 className="page-title flex-1">
              <InlineTitle text={pr.title} /> <span className="num">#{pr.number}</span>
            </h1>
            <span className="flex-center gap-1 shrink-0" style={{ marginTop: 6 }}>
              {canEdit && <IconButton size="small" variant="invisible" icon={PencilIcon} aria-label="Edit title" onClick={() => (setTitle(pr.title), setEditingTitle(true))} />}
              {/* The desktop app's tab row links to the page on show. */}
              {!isNative && (
                <>
                  <CopyButton text={pr.html_url} label="Copy pull request link" icon={LinkIcon} />
                  <IconButton size="small" variant="invisible" icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/pull/${number}`))} />
                </>
              )}
              <span style={{ width: 4 }} />
              <CheckoutMenu pr={pr} owner={owner} repo={repo} />
              <AgentOnly><ActionMenu>
                <ActionMenu.Anchor>
                  <Button size="small" leadingVisual={SparkleFillIcon} trailingVisual={TriangleDownIcon}>
                    Agent
                  </Button>
                </ActionMenu.Anchor>
                <ActionMenu.Overlay width="medium" align="end">
                  <ActionList>
                    <ActionList.Item onSelect={() => agent.ask(prompts!.review)}>
                      Review this pull request
                      <ActionList.Description variant="block">Findings ranked by severity; nothing is posted.</ActionList.Description>
                    </ActionList.Item>
                    <ActionList.Item onSelect={() => agent.ask(prompts!.bots)} disabled={!unresolvedBot}>
                      Address bot review comments{unresolvedBot ? ` (${unresolvedBot})` : ''}
                      <ActionList.Description variant="block">Verify, fix, reply and resolve CodeRabbit / Greptile threads.</ActionList.Description>
                    </ActionList.Item>
                    <ActionList.Item onSelect={() => agent.ask(prompts!.checks)}>
                      Investigate checks
                      <ActionList.Description variant="block">Read logs, fix or re-run.</ActionList.Description>
                    </ActionList.Item>
                    <ActionList.Item onSelect={() => agent.ask(prompts!.summary)}>Summarize</ActionList.Item>
                    <ActionList.Item onSelect={() => agent.ask(prompts!.description)}>Draft a description</ActionList.Item>
                  </ActionList>
                </ActionMenu.Overlay>
              </ActionMenu></AgentOnly>
            </span>
          </div>
        )}
        {saveTitle.error && <div className="error-box mt-2">{errorMessage(saveTitle.error)}</div>}
        <div className="flex-center gap-2 wrap mt-2">
          {!isNative && <PullStateLabel pull={pr} />}
          <span className="fg-muted">
            <UserLink login={pr.user?.login} type={pr.user?.type} className="text-bold fg-default" />{' '}
            {pr.merged ? 'merged' : 'wants to merge'} {plural(pr.commits, 'commit')} into <BranchPill repo={pr.base.repo.full_name} branch={pr.base.ref} label={baseLabel} /> from{' '}
            <BranchPill repo={pr.head.repo?.full_name} branch={pr.head.ref} label={pr.head.repo && pr.head.repo.owner.login !== owner ? `${pr.head.repo.owner.login}:${pr.head.ref}` : pr.head.ref} checkDeleted={pr.state === 'closed'} />
          </span>
          <CopyButton text={pr.head.ref} label="Copy head branch name" />
        </div>
        <div style={{ marginTop: 8, paddingBottom: 16, borderBottom: '1px solid var(--borderColor-muted)' }}>
          {!isNative && pr.state === 'open' && <PullStatusLine pr={pr} owner={owner} repo={repo} canAct={!!pr.base.repo.permissions?.push} />}
        </div>
      </div>
  )

  if (isNative) {
    const rest = pathname.slice(base.length)
    const showCommits = rest.startsWith('/commits')
    const showChecks = rest.startsWith('/checks')
    return (
      <div className="ws-pr">
        <div className="ws-pr-head">{header}</div>
        <PullStatusBar pr={pr} />
        <div className="ws-branch-body">
          <SplitPane
            id="pull-chat"
            firstLabel="Chat"
            secondLabel="Code"
            defaultWidth={420}
            min={300}
            max={900}
            first={
              <div className={`ws-pr-chat ${chatOnly ? 'is-comments-only' : ''}`}>
                <nav className="ws-subtabs" aria-label="Chat">
                  <Link className="ws-tab" to={showChecks ? (showCommits ? `${base}/commits` : base) : pathname} aria-current={!showChecks && !chatOnly ? 'page' : undefined} onClick={() => setChatOnly(false)}>
                    All
                  </Link>
                  <Link className="ws-tab" to={showChecks ? base : pathname} aria-current={!showChecks && chatOnly ? 'page' : undefined} onClick={() => setChatOnly(true)}>
                    Conversation
                  </Link>
                  <Link className="ws-tab" to={`${base}/checks`} aria-current={showChecks ? 'page' : undefined}>
                    Checks{checks.data && checks.data.runs.length > 0 ? ` ${checks.data.runs.length}` : ''}
                  </Link>
                </nav>
                <div className="ws-scroll ws-pr-thread">{showChecks ? <ChecksTab pr={pr} /> : <Conversation pr={pr} />}</div>
              </div>
            }
            second={
              <div className="ws-pr-code">
                <nav className="ws-subtabs" aria-label="Code">
                  <Link className="ws-tab" to={`${base}/files`} aria-current={!showCommits ? 'page' : undefined}>
                    Files {pr.changed_files}
                  </Link>
                  <Link className="ws-tab" to={`${base}/commits`} aria-current={showCommits ? 'page' : undefined}>
                    Commits {pr.commits}
                  </Link>
                  <span className="ws-subtabs-end">
                    <DiffStat additions={pr.additions} deletions={pr.deletions} />
                  </span>
                </nav>
                {showCommits ? <PullCommitsPane pr={pr} /> : (
                  <div className="ws-scroll ws-pr-files">
                    <FilesChanged pr={pr} defaultTreeWidth={200} />
                  </div>
                )}
              </div>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className={fullWidth ? 'container-full' : 'container-xl'} style={{ paddingBottom: 48 }}>
      {header}

      <div className="tabnav-sticky mb-3">
        <UnderlineNav aria-label="Pull request">
          <UnderlineNav.Item as={Link} to={base} icon={CommentDiscussionIcon} counter={pr.comments + pr.review_comments} aria-current={tab === 'conversation' ? 'page' : undefined}>
            Conversation
          </UnderlineNav.Item>
          <UnderlineNav.Item as={Link} to={`${base}/commits`} icon={GitCommitIcon} counter={pr.commits} aria-current={tab === 'commits' ? 'page' : undefined}>
            Commits
          </UnderlineNav.Item>
          <UnderlineNav.Item as={Link} to={`${base}/checks`} icon={ChecklistIcon} counter={checks.data ? checks.data.runs.length : undefined} aria-current={tab === 'checks' ? 'page' : undefined}>
            Checks
          </UnderlineNav.Item>
          <UnderlineNav.Item as={Link} to={`${base}/files`} icon={FileDiffIcon} counter={pr.changed_files} aria-current={tab === 'files' ? 'page' : undefined}>
            Files changed
          </UnderlineNav.Item>
        </UnderlineNav>
        <div style={{ position: 'absolute', right: 0, top: 12 }} className="hide-sm">
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
        </div>
      </div>

      <Routes>
        <Route index element={<Conversation pr={pr} />} />
        <Route path="commits" element={<PullCommits pr={pr} />} />
        <Route path="checks" element={<ChecksTab pr={pr} />} />
        <Route path="files" element={<FilesChanged pr={pr} />} />
      </Routes>
    </div>
  )
}
