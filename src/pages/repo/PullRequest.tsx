import { useState } from 'react'
import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, IconButton, TextInput, UnderlineNav } from '@primer/react'
import { CommentDiscussionIcon, GitCommitIcon, ChecklistIcon, FileDiffIcon, SparkleFillIcon, TriangleDownIcon, LinkExternalIcon, CodeIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { webUrl } from '../../lib/links'
import { openExternal } from '../../lib/platform'
import { plural } from '../../lib/format'
import { CopyButton, DiffStat, ErrorBox, InlineTitle, Loading, UserLink } from '../../components/Bits'
import { PullStateLabel } from '../../components/Status'
import { usePull, useChecks, useReviewComments, useReviewThreads, botThreadsSummary, summarizeChecks, prPrompts, useInvalidatePull } from './pull/data'
import { Conversation } from './pull/Conversation'
import { FilesChanged } from './pull/Files'
import { PullCommits } from './pull/Commits'
import { ChecksTab } from './pull/Checks'

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
  return (
    <div className={fullWidth ? 'container-full' : 'container-xl'} style={{ paddingBottom: 48 }}>
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
            <span className="flex-center gap-2 shrink-0" style={{ marginTop: 6 }}>
              {canEdit && (
                <Button size="small" onClick={() => (setTitle(pr.title), setEditingTitle(true))}>
                  Edit
                </Button>
              )}
              <ActionMenu>
                <ActionMenu.Anchor>
                  <Button size="small" variant="primary" leadingVisual={SparkleFillIcon} trailingVisual={TriangleDownIcon}>
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
              </ActionMenu>
              <ActionMenu>
                <ActionMenu.Anchor>
                  <Button size="small" leadingVisual={CodeIcon} trailingVisual={TriangleDownIcon}>
                    Code
                  </Button>
                </ActionMenu.Anchor>
                <ActionMenu.Overlay width="medium" align="end">
                  <div style={{ padding: 12 }}>
                    <div className="text-small text-bold mb-1">Check out with GitHub CLI</div>
                    <div className="flex-center gap-1">
                      <TextInput block readOnly value={`gh pr checkout ${pr.number}`} className="text-mono" aria-label="gh command" />
                      <CopyButton text={`gh pr checkout ${pr.number}`} label="Copy command" size="medium" />
                    </div>
                  </div>
                </ActionMenu.Overlay>
              </ActionMenu>
              <IconButton size="small" icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/pull/${number}`))} />
            </span>
          </div>
        )}
        {saveTitle.error && <div className="error-box mt-2">{errorMessage(saveTitle.error)}</div>}
        <div className="flex-center gap-2 wrap mt-2" style={{ paddingBottom: 16, borderBottom: '1px solid var(--borderColor-muted)' }}>
          <PullStateLabel pull={pr} />
          <span className="fg-muted">
            <UserLink login={pr.user?.login} type={pr.user?.type} className="text-bold fg-default" />{' '}
            {pr.merged ? (
              <>
                merged {plural(pr.commits, 'commit')} into <span className="branch-pill">{baseLabel}</span> from{' '}
              </>
            ) : (
              <>
                wants to merge {plural(pr.commits, 'commit')} into <span className="branch-pill">{baseLabel}</span> from{' '}
              </>
            )}
            <span className="branch-pill">{pr.head.repo && pr.head.repo.owner.login !== owner ? `${pr.head.repo.owner.login}:${pr.head.ref}` : pr.head.ref}</span>
          </span>
          <CopyButton text={pr.head.ref} label="Copy head branch name" />
        </div>
      </div>

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
