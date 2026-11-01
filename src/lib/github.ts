import { useMemo } from 'react'
import { Octokit } from '@octokit/rest'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import { reportRejectedToken, useAccount, type Account } from './auth'
import { hunkSide } from './suggestions'

const clients = new Map<string, Octokit>()

// GitHub marks API responses cacheable for 60 seconds, so the refetch after a write (a submitted review, a
// committed suggestion) would get the browser's stale copy. Revalidate instead: unchanged data comes back as a
// 304, which doesn't count against the rate limit. React Query does the caching.
const revalidatingFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-cache' })

export function octokitFor(account: Pick<Account, 'id' | 'token' | 'apiBase'>): Octokit {
  const key = `${account.id}\n${account.token}`
  let client = clients.get(key)
  if (!client) {
    client = new Octokit({ auth: account.token, baseUrl: account.apiBase, request: { fetch: revalidatingFetch } })
    // 401 means GitHub no longer accepts this token (REST and GraphQL both go through this hook).
    client.hook.error('request', (error) => {
      if ((error as { status?: number }).status === 401) reportRejectedToken(account.id, account.token)
      throw error
    })
    clients.set(key, client)
  }
  return client
}

/** Octokit for the active account plus a query-key prefix scoped to it. */
export function useGitHub() {
  const account = useAccount()
  return useMemo(() => ({ octokit: octokitFor(account), account, key: account.id }), [account])
}

// Requests that ask GitHub for rendered HTML alongside markdown bodies (body_html).
export const FULL_BODY = { mediaType: { format: 'full' } } as const


export type Repo = RestEndpointMethodTypes['repos']['get']['response']['data']
export type PullRequest = RestEndpointMethodTypes['pulls']['get']['response']['data']
export type PullFile = RestEndpointMethodTypes['pulls']['listFiles']['response']['data'][number]
export type ReviewComment = RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][number]
export type Review = RestEndpointMethodTypes['pulls']['listReviews']['response']['data'][number]
export type IssueComment = RestEndpointMethodTypes['issues']['listComments']['response']['data'][number]
export type Issue = RestEndpointMethodTypes['issues']['get']['response']['data']
export type CheckRun = RestEndpointMethodTypes['checks']['listForRef']['response']['data']['check_runs'][number]
export type WorkflowRun = RestEndpointMethodTypes['actions']['listWorkflowRunsForRepo']['response']['data']['workflow_runs'][number]
export type Workflow = RestEndpointMethodTypes['actions']['listRepoWorkflows']['response']['data']['workflows'][number]
export type Job = RestEndpointMethodTypes['actions']['listJobsForWorkflowRun']['response']['data']['jobs'][number]
export type Commit = RestEndpointMethodTypes['repos']['getCommit']['response']['data']
export type CommitListItem = RestEndpointMethodTypes['repos']['listCommits']['response']['data'][number]
export type Branch = RestEndpointMethodTypes['repos']['listBranches']['response']['data'][number]
export type Notification = RestEndpointMethodTypes['activity']['listNotificationsForAuthenticatedUser']['response']['data'][number]
export type SearchIssue = RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][number]
export type TimelineEvent = RestEndpointMethodTypes['issues']['listEventsForTimeline']['response']['data'][number]

export interface ReviewThreadInfo {
  id: string
  isResolved: boolean
  isOutdated: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  path: string
  line: number | null
  firstCommentId: number
}

/** Review thread ids and resolution state, which REST does not expose. Keyed by first comment databaseId. */
export async function fetchReviewThreads(octokit: Octokit, owner: string, repo: string, number: number) {
  const threads = new Map<number, ReviewThreadInfo>()
  let cursor: string | null = null
  for (let page = 0; page < 10; page++) {
    const res: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
            nodes: Array<{
              id: string
              isResolved: boolean
              isOutdated: boolean
              viewerCanResolve: boolean
              viewerCanUnresolve: boolean
              path: string
              line: number | null
              comments: { nodes: Array<{ databaseId: number }> }
            }>
          }
        } | null
      }
    } = await octokit.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){
            reviewThreads(first:100, after:$cursor){
              pageInfo{hasNextPage endCursor}
              nodes{ id isResolved isOutdated viewerCanResolve viewerCanUnresolve path line
                comments(first:1){nodes{databaseId}} }
            }
          }
        }
      }`,
      { owner, repo, number, cursor },
    )
    const conn = res.repository.pullRequest?.reviewThreads
    if (!conn) break
    for (const n of conn.nodes) {
      const first = n.comments.nodes[0]?.databaseId
      if (first) threads.set(first, { ...n, firstCommentId: first })
    }
    if (!conn.pageInfo.hasNextPage) break
    cursor = conn.pageInfo.endCursor
  }
  return threads
}

export async function setThreadResolved(octokit: Octokit, threadId: string, resolved: boolean) {
  const mutation = resolved
    ? `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`
    : `mutation($id:ID!){ unresolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`
  await octokit.graphql(mutation, { id: threadId })
}

// ---------------------------------------------------------------------------
// Pending reviews. GitHub keeps at most one per user per pull request, visible only to its author. REST can
// neither add to it nor post a single comment or reply while it exists, so these go through GraphQL.

export interface PendingReviewComment {
  id: string
  databaseId: number
  path: string
  /** Current last/first line; line is null once the comment is outdated. startLine is null for one line. */
  line: number | null
  startLine: number | null
  originalLine: number | null
  originalStartLine: number | null
  /**
   * GraphQL puts sides on threads only: the viewer's pending threads are among the pull request's threads. The
   * diff hunk's last line is the fallback, though it can't tell the LEFT side of an unchanged line.
   */
  side: 'LEFT' | 'RIGHT'
  body: string
  bodyHTML: string
  diffHunk: string
  outdated: boolean
  createdAt: string
  /** Root comment of the submitted thread this pending comment replies to. */
  replyTo: number | null
}

export interface PendingReview {
  id: string
  databaseId: number
  body: string
  commitOid: string | null
  comments: PendingReviewComment[]
}

export interface PullReviewState {
  pullId: string
  viewerCanApplySuggestion: boolean
  pending: PendingReview | null
}

/** The viewer's pending review on a pull request (if any) and whether they may commit suggestions there. */
export async function fetchPullReviewState(octokit: Octokit, owner: string, repo: string, number: number, login: string): Promise<PullReviewState> {
  type RawComment = Omit<PendingReviewComment, 'side' | 'replyTo'> & { replyTo: { databaseId: number } | null }
  const res: {
    repository: {
      pullRequest: {
        id: string
        viewerCanApplySuggestion: boolean
        reviews: { nodes: Array<{ id: string; databaseId: number; body: string; commit: { oid: string } | null; comments: { nodes: RawComment[] } }> }
        reviewThreads: { nodes: Array<{ diffSide: 'LEFT' | 'RIGHT'; comments: { nodes: Array<{ databaseId: number }> } }> }
      } | null
    }
  } = await octokit.graphql(
    `query($owner:String!,$repo:String!,$number:Int!,$login:String!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          id viewerCanApplySuggestion
          reviews(states:PENDING, author:$login, first:1){
            nodes{ id databaseId body commit{oid}
              comments(first:100){ nodes{ id databaseId path line startLine originalLine originalStartLine body bodyHTML diffHunk outdated createdAt replyTo{databaseId} } } }
          }
          reviewThreads(last:100){ nodes{ diffSide comments(first:1){ nodes{ databaseId } } } }
        }
      }
    }`,
    { owner, repo, number, login },
  )
  const pr = res.repository.pullRequest
  if (!pr) throw new Error(`Pull request #${number} not found.`)
  const review = pr.reviews.nodes[0]
  const threadSide = new Map(pr.reviewThreads.nodes.map((t) => [t.comments.nodes[0]?.databaseId, t.diffSide]))
  return {
    pullId: pr.id,
    viewerCanApplySuggestion: pr.viewerCanApplySuggestion,
    pending: review
      ? {
          id: review.id,
          databaseId: review.databaseId,
          body: review.body,
          commitOid: review.commit?.oid ?? null,
          comments: review.comments.nodes.map((c) => ({
            ...c,
            // A one-line comment can report startLine equal to line.
            startLine: c.startLine !== null && c.startLine !== c.line ? c.startLine : null,
            originalStartLine: c.originalStartLine !== null && c.originalStartLine !== c.originalLine ? c.originalStartLine : null,
            side: threadSide.get(c.databaseId) ?? hunkSide(c.diffHunk),
            replyTo: c.replyTo?.databaseId ?? null,
          })),
        }
      : null,
  }
}

export interface NewReviewThread {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
}

/** Adds a new comment thread to a pending review. */
export async function addPendingThread(octokit: Octokit, reviewId: string, t: NewReviewThread) {
  const range = t.startLine && t.startLine < t.line ? { startLine: t.startLine, startSide: t.startSide ?? t.side } : {}
  await octokit.graphql(
    `mutation($input:AddPullRequestReviewThreadInput!){ addPullRequestReviewThread(input:$input){ thread{ id } } }`,
    { input: { pullRequestReviewId: reviewId, path: t.path, body: t.body, line: t.line, side: t.side, subjectType: 'LINE', ...range } },
  )
}

/** Adds a reply to a submitted thread into the pending review (REST replies fail while one exists). */
export async function addPendingReply(octokit: Octokit, reviewId: string, threadId: string, body: string) {
  await octokit.graphql(
    `mutation($review:ID!,$thread:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewId:$review, pullRequestReviewThreadId:$thread, body:$body}){ comment{ id } } }`,
    { review: reviewId, thread: threadId, body },
  )
}

export async function updatePendingComment(octokit: Octokit, commentId: string, body: string) {
  await octokit.graphql(
    `mutation($id:ID!,$body:String!){ updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id, body:$body}){ pullRequestReviewComment{ id } } }`,
    { id: commentId, body },
  )
}

export async function deletePendingComment(octokit: Octokit, commentId: string) {
  await octokit.graphql(`mutation($id:ID!){ deletePullRequestReviewComment(input:{id:$id}){ pullRequestReview{ id } } }`, { id: commentId })
}

export async function submitPendingReview(octokit: Octokit, reviewId: string, event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', body: string) {
  await octokit.graphql(
    `mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){ submitPullRequestReview(input:{pullRequestReviewId:$id, event:$event, body:$body}){ pullRequestReview{ id state } } }`,
    { id: reviewId, event, body },
  )
}

/** Abandons a pending review with all of its comments. */
export async function deletePendingReview(octokit: Octokit, reviewId: string) {
  await octokit.graphql(`mutation($id:ID!){ deletePullRequestReview(input:{pullRequestReviewId:$id}){ pullRequestReview{ id } } }`, { id: reviewId })
}

export async function markReadyForReview(octokit: Octokit, pullNodeId: string) {
  await octokit.graphql(
    `mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ id isDraft } } }`,
    { id: pullNodeId },
  )
}

export async function convertToDraft(octokit: Octokit, pullNodeId: string) {
  await octokit.graphql(
    `mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest{ id isDraft } } }`,
    { id: pullNodeId },
  )
}

/** Renders markdown the way GitHub does, resolving #refs and @mentions against a repo. */
export async function renderMarkdown(octokit: Octokit, text: string, context?: string) {
  const res = await octokit.rest.markdown.render({ text, mode: context ? 'gfm' : 'markdown', context })
  return res.data as unknown as string
}

/** Decodes base64 file content from the contents API as UTF-8. */
export function decodeBase64(content: string): string {
  const bin = atob(content.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { status?: number; message?: string; response?: { data?: { message?: string; errors?: Array<{ message?: string }> } } }
    const data = e.response?.data
    const detail = data?.errors?.map((x) => x.message).filter(Boolean).join('; ')
    if (data?.message) return detail ? `${data.message}: ${detail}` : data.message
    if (e.message) return e.message
  }
  return String(err)
}
