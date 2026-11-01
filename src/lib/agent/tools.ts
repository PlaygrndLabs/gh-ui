import { z } from 'zod'
import type { Octokit } from '@octokit/rest'
import type Anthropic from '@anthropic-ai/sdk'
import type { Account } from '../auth'
import { decodeBase64, errorMessage, fetchReviewThreads, setThreadResolved } from '../github'
import { commitFiles } from '../commit'
import { withSuggestion } from '../suggestions'
import { fetchJobLogs, summarizeLog } from '../logs'
import { canReadNotifications } from '../hosts'

export interface ToolContext {
  octokit: Octokit
  account: Account
}

export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  schema: S
  /** write tools change GitHub state and need the user's approval unless auto-approve is on. */
  kind: 'read' | 'write'
  /** One-line human summary shown on the tool card and approval prompt. */
  summarize(input: z.infer<S>): string
  run(input: z.infer<S>, ctx: ToolContext): Promise<unknown>
}

function tool<S extends z.ZodObject>(t: AgentTool<S>): AgentTool<S> {
  return t
}

const MAX_TEXT = 60_000

function clip(text: string | null | undefined, max = MAX_TEXT): string {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters; request a narrower range to see more]`
}

const repoArgs = {
  owner: z.string().describe('Repository owner (user or organization login).'),
  repo: z.string().describe('Repository name.'),
}

const prArgs = { ...repoArgs, number: z.number().int().describe('Pull request number.') }

const inlineCommentArgs = {
  path: z.string(),
  line: z.number().int().describe('Line in the file of `side`; the last line for a multi-line comment.'),
  side: z.enum(['LEFT', 'RIGHT']).optional().describe('RIGHT (default) for added or unchanged lines of the new file, LEFT for deleted lines.'),
  start_line: z.number().int().optional().describe('First line of a multi-line comment (on the same side, in the same hunk).'),
  body: z.string().describe('Markdown comment.'),
  suggestion: z.string().optional().describe('Replacement code for lines start_line..line (or line), appended as a ```suggestion block. RIGHT side only.'),
}

type InlineCommentInput = { path: string; line: number; side?: 'LEFT' | 'RIGHT'; start_line?: number; body: string; suggestion?: string }

/** REST fields of an inline review comment: start_line/start_side only for a real range, the suggestion as a block. */
export function inlineComment(c: InlineCommentInput) {
  const side = c.side ?? 'RIGHT'
  return {
    path: c.path,
    line: c.line,
    side,
    ...(c.start_line && c.start_line < c.line ? { start_line: c.start_line, start_side: side } : {}),
    body: withSuggestion(c.body, c.suggestion),
  }
}

/** GitHub allows one pending review per user, and REST can't add to it, so say how to get past that. */
function pendingReviewError(e: unknown) {
  const msg = errorMessage(e)
  if (/one pending review/i.test(msg)) {
    return { error: `${msg}. The user has an unsubmitted (pending) review on this pull request; ask them to submit or abandon it in the Files changed tab first.` }
  }
  throw e
}

export const TOOLS = [
  tool({
    name: 'get_pull_request',
    kind: 'read',
    description: 'Get a pull request: title, description, state, author, base/head branches and SHAs, mergeability, draft flag, labels, requested reviewers and diff stats.',
    schema: z.object(prArgs),
    summarize: (i) => `Read ${i.owner}/${i.repo}#${i.number}`,
    async run({ owner, repo, number }, { octokit }) {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
      return {
        number: pr.number,
        title: pr.title,
        state: pr.merged ? 'merged' : pr.state,
        draft: pr.draft,
        author: pr.user?.login,
        body: clip(pr.body, 20_000),
        base: { ref: pr.base.ref, sha: pr.base.sha, repo: pr.base.repo.full_name },
        head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name ?? null },
        maintainer_can_modify: pr.maintainer_can_modify,
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state,
        labels: pr.labels.map((l) => l.name),
        requested_reviewers: pr.requested_reviewers?.map((u) => u.login),
        commits: pr.commits,
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        html_url: pr.html_url,
      }
    },
  }),

  tool({
    name: 'list_pull_request_files',
    kind: 'read',
    description: 'List files changed in a pull request with status, additions/deletions and the unified diff patch for each file. Patches for very large files are omitted; use get_file_content for those.',
    schema: z.object({
      ...prArgs,
      include_patch: z.boolean().optional().describe('Include each file patch (default true).'),
      path_filter: z.string().optional().describe('Only include files whose path contains this substring.'),
    }),
    summarize: (i) => `List changed files in ${i.owner}/${i.repo}#${i.number}`,
    async run({ owner, repo, number, include_patch = true, path_filter }, { octokit }) {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 })
      let budget = 150_000
      return files
        .filter((f) => !path_filter || f.filename.includes(path_filter))
        .map((f) => {
          let patch: string | undefined
          if (include_patch && f.patch) {
            if (f.patch.length <= budget) {
              patch = f.patch
              budget -= f.patch.length
            } else patch = '[patch omitted to stay within the response budget; use get_file_content or path_filter]'
          }
          return { path: f.filename, previous_path: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch }
        })
    },
  }),

  tool({
    name: 'get_file_content',
    kind: 'read',
    description: 'Read a file from a repository at a ref (branch, tag or SHA). Returns numbered lines. Use start_line/end_line for large files.',
    schema: z.object({
      ...repoArgs,
      path: z.string().describe('File path relative to the repository root.'),
      ref: z.string().optional().describe('Branch, tag or commit SHA. Defaults to the default branch.'),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
    }),
    summarize: (i) => `Read ${i.path}${i.ref ? ` @ ${i.ref}` : ''}`,
    async run({ owner, repo, path, ref, start_line, end_line }, { octokit }) {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
      if (Array.isArray(data) || data.type !== 'file') return { error: `${path} is a directory; use list_directory.` }
      let text: string
      if (data.content) text = decodeBase64(data.content)
      else {
        const blob = await octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha })
        text = decodeBase64(blob.data.content)
      }
      const lines = text.split('\n')
      const from = Math.max(1, start_line ?? 1)
      const to = Math.min(lines.length, end_line ?? lines.length)
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${from + i}\t${l}`)
        .join('\n')
      return { path, sha: data.sha, total_lines: lines.length, showing: `${from}-${to}`, content: clip(body) }
    },
  }),

  tool({
    name: 'list_directory',
    kind: 'read',
    description: 'List the entries of a directory in a repository.',
    schema: z.object({ ...repoArgs, path: z.string().optional().describe('Directory path; empty for the root.'), ref: z.string().optional() }),
    summarize: (i) => `List ${i.path || '/'} in ${i.owner}/${i.repo}`,
    async run({ owner, repo, path = '', ref }, { octokit }) {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
      if (!Array.isArray(data)) return { error: `${path} is a file; use get_file_content.` }
      return data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))
    },
  }),

  tool({
    name: 'search_code',
    kind: 'read',
    description: 'Search code in a repository (GitHub code search syntax). Indexes the default branch only.',
    schema: z.object({ ...repoArgs, query: z.string().describe('Search terms, e.g. "useEffect path:src/" or a symbol name.') }),
    summarize: (i) => `Search "${i.query}" in ${i.owner}/${i.repo}`,
    async run({ owner, repo, query }, { octokit }) {
      const { data } = await octokit.rest.search.code({ q: `${query} repo:${owner}/${repo}`, per_page: 30 })
      return { total: data.total_count, results: data.items.map((i) => ({ path: i.path, url: i.html_url })) }
    },
  }),

  tool({
    name: 'list_review_threads',
    kind: 'read',
    description:
      'List inline review comment threads on a pull request, including bot reviewers such as coderabbitai[bot] and greptile-apps[bot]. Each thread has a thread_id (for resolve_review_thread), resolution state, file path, line, and its comments with comment ids (for reply_to_review_comment).',
    schema: z.object({
      ...prArgs,
      author: z.string().optional().describe('Only threads started by logins containing this text, e.g. "coderabbit" or "greptile".'),
      include_resolved: z.boolean().optional().describe('Include resolved threads (default false).'),
    }),
    summarize: (i) => `Read review threads on ${i.owner}/${i.repo}#${i.number}${i.author ? ` from ${i.author}` : ''}`,
    async run({ owner, repo, number, author, include_resolved = false }, { octokit }) {
      const [comments, threads] = await Promise.all([
        octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 }),
        fetchReviewThreads(octokit, owner, repo, number).catch(() => new Map()),
      ])
      const roots = comments.filter((c) => !c.in_reply_to_id)
      const replies = new Map<number, typeof comments>()
      for (const c of comments) {
        if (c.in_reply_to_id) replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c])
      }
      const needle = author?.toLowerCase()
      return roots
        .map((root) => {
          const info = threads.get(root.id)
          return {
            thread_id: info?.id ?? null,
            resolved: info?.isResolved ?? false,
            outdated: info?.isOutdated ?? root.position === null,
            path: root.path,
            line: root.line ?? root.original_line,
            side: root.side,
            ...((root.start_line ?? root.original_start_line) ? { start_line: root.start_line ?? root.original_start_line, start_side: root.start_side } : {}),
            diff_hunk: clip(root.diff_hunk, 1500),
            comments: [root, ...(replies.get(root.id) ?? [])].map((c) => ({
              id: c.id,
              author: c.user?.login,
              created_at: c.created_at,
              body: clip(c.body, 8000),
            })),
          }
        })
        .filter((t) => include_resolved || !t.resolved)
        .filter((t) => !needle || t.comments[0].author?.toLowerCase().includes(needle))
    },
  }),

  tool({
    name: 'list_conversation',
    kind: 'read',
    description: 'List the top-level conversation of a pull request or issue: issue comments plus review summaries (state and body). Bot summaries (e.g. CodeRabbit walkthroughs, Greptile summaries) appear here.',
    schema: z.object({ ...prArgs, author: z.string().optional().describe('Only entries by logins containing this text.') }),
    summarize: (i) => `Read conversation on ${i.owner}/${i.repo}#${i.number}`,
    async run({ owner, repo, number, author }, { octokit }) {
      const [comments, reviews] = await Promise.all([
        octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
        octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }).catch(() => []),
      ])
      const needle = author?.toLowerCase()
      const items = [
        ...comments.map((c) => ({ type: 'comment', id: c.id, author: c.user?.login, created_at: c.created_at, body: clip(c.body, 10_000) })),
        ...reviews
          .filter((r) => r.body || r.state !== 'COMMENTED')
          .map((r) => ({ type: 'review', id: r.id, author: r.user?.login, state: r.state, created_at: r.submitted_at, body: clip(r.body, 10_000) })),
      ]
      return items
        .filter((i) => !needle || i.author?.toLowerCase().includes(needle))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    },
  }),

  tool({
    name: 'get_issue',
    kind: 'read',
    description: 'Get an issue with its comments.',
    schema: z.object({ ...repoArgs, number: z.number().int() }),
    summarize: (i) => `Read issue ${i.owner}/${i.repo}#${i.number}`,
    async run({ owner, repo, number }, { octokit }) {
      const [{ data: issue }, comments] = await Promise.all([
        octokit.rest.issues.get({ owner, repo, issue_number: number }),
        octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
      ])
      return {
        title: issue.title,
        state: issue.state,
        author: issue.user?.login,
        labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        body: clip(issue.body, 20_000),
        comments: comments.map((c) => ({ id: c.id, author: c.user?.login, body: clip(c.body, 6000) })),
      }
    },
  }),

  tool({
    name: 'get_checks',
    kind: 'read',
    description: 'Get CI check runs and commit statuses for a ref (branch or SHA). For GitHub Actions, a check run id equals the job id usable with get_job_logs.',
    schema: z.object({ ...repoArgs, ref: z.string().describe('Branch name or commit SHA, e.g. the PR head SHA.') }),
    summarize: (i) => `Read checks for ${i.ref.slice(0, 12)}`,
    async run({ owner, repo, ref }, { octokit }) {
      const [checks, status] = await Promise.all([
        octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100, filter: 'latest' }),
        octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }).catch(() => null),
      ])
      return {
        check_runs: checks.data.check_runs.map((c) => ({
          id: c.id,
          name: c.name,
          app: c.app?.slug,
          status: c.status,
          conclusion: c.conclusion,
          started_at: c.started_at,
          completed_at: c.completed_at,
          details_url: c.details_url,
          summary: clip(c.output?.title ? `${c.output.title}\n${c.output.summary ?? ''}` : c.output?.summary, 2000),
        })),
        statuses: status?.data.statuses.map((s) => ({ context: s.context, state: s.state, description: s.description, target_url: s.target_url })) ?? [],
        combined_state: status?.data.state ?? null,
      }
    },
  }),

  tool({
    name: 'list_workflow_runs',
    kind: 'read',
    description: 'List recent GitHub Actions workflow runs, optionally filtered by branch, status or head SHA.',
    schema: z.object({
      ...repoArgs,
      branch: z.string().optional(),
      head_sha: z.string().optional(),
      status: z.enum(['completed', 'in_progress', 'queued', 'failure', 'success', 'cancelled', 'action_required']).optional(),
      limit: z.number().int().optional().describe('Max runs (default 15, max 50).'),
    }),
    summarize: (i) => `List workflow runs${i.branch ? ` on ${i.branch}` : ''}`,
    async run({ owner, repo, branch, head_sha, status, limit = 15 }, { octokit }) {
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo, branch, head_sha, status, per_page: Math.min(50, limit) })
      return data.workflow_runs.map((r) => ({
        id: r.id,
        name: r.name,
        title: r.display_title,
        run_number: r.run_number,
        attempt: r.run_attempt,
        event: r.event,
        branch: r.head_branch,
        head_sha: r.head_sha,
        status: r.status,
        conclusion: r.conclusion,
        created_at: r.created_at,
        workflow_id: r.workflow_id,
      }))
    },
  }),

  tool({
    name: 'get_workflow_run',
    kind: 'read',
    description: 'Get a workflow run with its jobs and their steps (status, conclusion, timing).',
    schema: z.object({ ...repoArgs, run_id: z.number().int() }),
    summarize: (i) => `Read workflow run ${i.run_id}`,
    async run({ owner, repo, run_id }, { octokit }) {
      const [{ data: run }, { data: jobs }] = await Promise.all([
        octokit.rest.actions.getWorkflowRun({ owner, repo, run_id }),
        octokit.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id, per_page: 100, filter: 'latest' }),
      ])
      return {
        id: run.id,
        name: run.name,
        title: run.display_title,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        branch: run.head_branch,
        head_sha: run.head_sha,
        attempt: run.run_attempt,
        jobs: jobs.jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          steps: j.steps?.map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
        })),
      }
    },
  }),

  tool({
    name: 'get_job_logs',
    kind: 'read',
    description: 'Fetch the log of an Actions job and return the error lines with context plus the last lines. Use grep to focus on a pattern.',
    schema: z.object({
      ...repoArgs,
      job_id: z.number().int(),
      tail: z.number().int().optional().describe('How many trailing lines to include (default 150).'),
      grep: z.string().optional().describe('Regex; matching lines are included with context.'),
    }),
    summarize: (i) => `Read logs of job ${i.job_id}`,
    async run({ owner, repo, job_id, tail, grep }, { octokit, account }) {
      const raw = await fetchJobLogs(octokit, account, owner, repo, job_id)
      return clip(summarizeLog(raw, { tail, grep }))
    },
  }),

  tool({
    name: 'get_commit',
    kind: 'read',
    description: 'Get a commit with its message and per-file patches.',
    schema: z.object({ ...repoArgs, sha: z.string() }),
    summarize: (i) => `Read commit ${i.sha.slice(0, 7)}`,
    async run({ owner, repo, sha }, { octokit }) {
      const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: sha })
      return {
        sha: data.sha,
        message: data.commit.message,
        author: data.author?.login ?? data.commit.author?.name,
        files: data.files?.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: clip(f.patch, 12_000) })),
      }
    },
  }),

  tool({
    name: 'compare_refs',
    kind: 'read',
    description: 'Compare two refs (base...head): commits ahead and changed files.',
    schema: z.object({ ...repoArgs, base: z.string(), head: z.string() }),
    summarize: (i) => `Compare ${i.base}...${i.head}`,
    async run({ owner, repo, base, head }, { octokit }) {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}` })
      return {
        status: data.status,
        ahead_by: data.ahead_by,
        behind_by: data.behind_by,
        commits: data.commits.map((c) => ({ sha: c.sha, message: c.commit.message.split('\n')[0], author: c.author?.login })),
        files: data.files?.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      }
    },
  }),

  tool({
    name: 'get_discussion',
    kind: 'read',
    description: 'Read a GitHub Discussion with its comments and replies. Comment ids are usable with comment_on_discussion.',
    schema: z.object({ ...repoArgs, number: z.number().int() }),
    summarize: (i) => `Read discussion ${i.owner}/${i.repo}#${i.number}`,
    async run({ owner, repo, number }, { octokit }) {
      const res: {
        repository: {
          discussion: {
            id: string
            title: string
            body: string
            author: { login: string } | null
            category: { name: string }
            answer: { id: string } | null
            comments: { nodes: Array<{ id: string; body: string; isAnswer: boolean; author: { login: string } | null; replies: { nodes: Array<{ id: string; body: string; author: { login: string } | null }> } }> }
          } | null
        }
      } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ discussion(number:$number){
          id title body author{login} category{name} answer{id}
          comments(first:100){ nodes{ id body isAnswer author{login} replies(first:50){ nodes{ id body author{login} } } } } } } }`,
        { owner, repo, number },
      )
      const d = res.repository.discussion
      if (!d) return { error: `Discussion #${number} not found.` }
      return {
        id: d.id,
        title: d.title,
        category: d.category.name,
        answered: !!d.answer,
        author: d.author?.login,
        body: clip(d.body, 20_000),
        comments: d.comments.nodes.map((c) => ({
          id: c.id,
          author: c.author?.login,
          is_answer: c.isAnswer,
          body: clip(c.body, 6000),
          replies: c.replies.nodes.map((r) => ({ id: r.id, author: r.author?.login, body: clip(r.body, 4000) })),
        })),
      }
    },
  }),

  tool({
    name: 'list_discussions',
    kind: 'read',
    description: 'List recent GitHub Discussions in a repository with category, answered state, upvotes and comment counts. Use get_discussion to read one.',
    schema: z.object({
      ...repoArgs,
      unanswered_only: z.boolean().optional().describe('Only discussions in answerable (Q&A) categories that have no accepted answer.'),
      limit: z.number().int().optional().describe('Default 20, max 50.'),
    }),
    summarize: (i) => `List ${i.unanswered_only ? 'unanswered ' : ''}discussions in ${i.owner}/${i.repo}`,
    async run({ owner, repo, unanswered_only = false, limit = 20 }, { octokit }) {
      const res: {
        repository: {
          hasDiscussionsEnabled: boolean
          discussions: {
            nodes: Array<{
              number: number
              title: string
              updatedAt: string
              isAnswered: boolean | null
              upvoteCount: number
              author: { login: string } | null
              category: { name: string; isAnswerable: boolean }
              comments: { totalCount: number }
            }>
          }
        }
      } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$n:Int!){ repository(owner:$owner,name:$repo){ hasDiscussionsEnabled
          discussions(first:$n, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ number title updatedAt isAnswered upvoteCount author{login} category{name isAnswerable} comments{totalCount} } } } }`,
        { owner, repo, n: Math.min(50, limit) },
      )
      if (!res.repository.hasDiscussionsEnabled) return { error: 'Discussions are not enabled for this repository.' }
      return res.repository.discussions.nodes
        .filter((d) => !unanswered_only || (d.category.isAnswerable && !d.isAnswered))
        .map((d) => ({
          number: d.number,
          title: d.title,
          category: d.category.name,
          answerable: d.category.isAnswerable,
          answered: !!d.isAnswered,
          upvotes: d.upvoteCount,
          comments: d.comments.totalCount,
          author: d.author?.login,
          updated_at: d.updatedAt,
        }))
    },
  }),

  tool({
    name: 'list_releases',
    kind: 'read',
    description: 'List recent releases (tag, name, date, prerelease flag, notes).',
    schema: z.object({ ...repoArgs, limit: z.number().int().optional().describe('Default 5, max 30.') }),
    summarize: (i) => `List releases of ${i.owner}/${i.repo}`,
    async run({ owner, repo, limit = 5 }, { octokit }) {
      const { data } = await octokit.rest.repos.listReleases({ owner, repo, per_page: Math.min(30, limit) })
      return data.map((r) => ({ tag: r.tag_name, name: r.name, published_at: r.published_at, prerelease: r.prerelease, draft: r.draft, notes: clip(r.body, 6000) }))
    },
  }),

  tool({
    name: 'list_security_alerts',
    kind: 'read',
    description: 'List open security alerts: Dependabot (vulnerable dependencies), code scanning, or secret scanning.',
    schema: z.object({ ...repoArgs, kind: z.enum(['dependabot', 'code-scanning', 'secret-scanning']) }),
    summarize: (i) => `List ${i.kind} alerts in ${i.owner}/${i.repo}`,
    async run({ owner, repo, kind }, { octokit }) {
      if (kind === 'dependabot') {
        const { data } = await octokit.rest.dependabot.listAlertsForRepo({ owner, repo, state: 'open', per_page: 100 })
        return data.map((a) => ({
          number: a.number,
          package: `${a.dependency.package?.ecosystem}:${a.dependency.package?.name}`,
          manifest: a.dependency.manifest_path,
          severity: a.security_vulnerability.severity,
          vulnerable_range: a.security_vulnerability.vulnerable_version_range,
          patched: a.security_vulnerability.first_patched_version?.identifier ?? null,
          summary: a.security_advisory.summary,
          ghsa: a.security_advisory.ghsa_id,
        }))
      }
      if (kind === 'code-scanning') {
        const { data } = await octokit.rest.codeScanning.listAlertsForRepo({ owner, repo, state: 'open', per_page: 100 })
        return data.map((a) => ({
          number: a.number,
          rule: a.rule.id,
          description: a.rule.description,
          severity: a.rule.security_severity_level ?? a.rule.severity,
          tool: a.tool.name,
          location: a.most_recent_instance.location,
          message: clip(a.most_recent_instance.message?.text, 2000),
        }))
      }
      // Secret values are never returned to the model.
      const { data } = await octokit.rest.secretScanning.listAlertsForRepo({ owner, repo, state: 'open', per_page: 100, hide_secret: true })
      return data.map((a) => ({ number: a.number, type: a.secret_type_display_name ?? a.secret_type, validity: a.validity, created_at: a.created_at }))
    },
  }),

  tool({
    name: 'search_issues',
    kind: 'read',
    description:
      'Search issues and pull requests across GitHub with search qualifiers, e.g. "is:pr is:open review-requested:@me archived:false", "is:pr is:open author:@me", "is:issue is:open assignee:@me", "repo:owner/name is:pr is:open". Returns state, author, review decision and the CI rollup for pull requests.',
    schema: z.object({
      query: z.string().describe('GitHub search query; include is:pr or is:issue.'),
      limit: z.number().int().optional().describe('Default 20, max 50.'),
    }),
    summarize: (i) => `Search "${i.query}"`,
    async run({ query, limit = 20 }, { octokit }) {
      const res: {
        search: {
          issueCount: number
          nodes: Array<{
            __typename: string
            number: number
            title: string
            url: string
            state: string
            isDraft?: boolean
            updatedAt: string
            author: { login: string } | null
            repository: { nameWithOwner: string }
            reviewDecision?: string | null
            headRefName?: string
            commits?: { nodes: Array<{ commit: { oid: string; statusCheckRollup: { state: string } | null } }> }
          }>
        }
      } = await octokit.graphql(
        `query($q:String!,$n:Int!){ search(query:$q, type:ISSUE, first:$n){ issueCount nodes{ __typename
          ... on Issue{ number title url state updatedAt author{login} repository{nameWithOwner} }
          ... on PullRequest{ number title url state isDraft updatedAt author{login} repository{nameWithOwner} reviewDecision headRefName
            commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } } } } } }`,
        { q: query, n: Math.min(50, limit) },
      )
      return {
        total: res.search.issueCount,
        results: res.search.nodes.map((n) => ({
          type: n.__typename === 'PullRequest' ? 'pr' : 'issue',
          repo: n.repository.nameWithOwner,
          number: n.number,
          title: n.title,
          state: n.state,
          draft: n.isDraft,
          author: n.author?.login,
          updated_at: n.updatedAt,
          review_decision: n.reviewDecision,
          head_branch: n.headRefName,
          head_sha: n.commits?.nodes[0]?.commit.oid,
          checks: n.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
        })),
      }
    },
  }),

  tool({
    name: 'list_notifications',
    kind: 'read',
    description: "List the user's GitHub notifications (review requests, mentions, assignments, CI). Not available for fine-grained personal access tokens or GitHub App tokens.",
    schema: z.object({
      unread_only: z.boolean().optional().describe('Default true.'),
      participating: z.boolean().optional().describe('Only threads the user participates in or is mentioned in.'),
      limit: z.number().int().optional().describe('Default 30, max 50.'),
    }),
    summarize: (i) => `List ${i.unread_only === false ? '' : 'unread '}notifications`,
    async run({ unread_only = true, participating = false, limit = 30 }, { octokit, account }) {
      if (!canReadNotifications(account.kind)) return { error: 'GitHub does not allow fine-grained personal access tokens or GitHub App tokens to read notifications.' }
      const { data } = await octokit.rest.activity.listNotificationsForAuthenticatedUser({ all: !unread_only, participating, per_page: Math.min(50, limit) })
      return data.map((n) => ({
        reason: n.reason,
        unread: n.unread,
        repo: n.repository.full_name,
        type: n.subject.type,
        title: n.subject.title,
        api_url: n.subject.url,
        updated_at: n.updated_at,
      }))
    },
  }),

  // ---------------- write tools ----------------

  tool({
    name: 'reply_to_review_comment',
    kind: 'write',
    description: 'Reply in an inline review thread (e.g. to explain a fix to coderabbitai or greptile, or decline a suggestion with reasoning). comment_id is any comment id in the thread.',
    schema: z.object({ ...prArgs, comment_id: z.number().int(), body: z.string().describe('Markdown reply.') }),
    summarize: (i) => `Reply to review comment ${i.comment_id}`,
    async run({ owner, repo, number, comment_id, body }, { octokit }) {
      const { data } = await octokit.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: number, comment_id, body })
      return { id: data.id, url: data.html_url }
    },
  }),

  tool({
    name: 'post_comment',
    kind: 'write',
    description: 'Post a top-level comment on a pull request or issue. Also used to send commands to review bots, e.g. "@coderabbitai review" or "@greptileai".',
    schema: z.object({ ...repoArgs, number: z.number().int(), body: z.string() }),
    summarize: (i) => `Comment on #${i.number}`,
    async run({ owner, repo, number, body }, { octokit }) {
      const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body })
      return { id: data.id, url: data.html_url }
    },
  }),

  tool({
    name: 'comment_on_discussion',
    kind: 'write',
    description: 'Post a comment on a GitHub Discussion, or a reply to one of its comments (reply_to_comment_id from get_discussion).',
    schema: z.object({ discussion_id: z.string().describe('Discussion node id from get_discussion.'), body: z.string(), reply_to_comment_id: z.string().optional() }),
    summarize: (i) => (i.reply_to_comment_id ? 'Reply in discussion' : 'Comment on discussion'),
    async run({ discussion_id, body, reply_to_comment_id }, { octokit }) {
      const res: { addDiscussionComment: { comment: { url: string } } } = await octokit.graphql(
        `mutation($id:ID!,$body:String!,$reply:ID){ addDiscussionComment(input:{discussionId:$id, body:$body, replyToId:$reply}){ comment{ url } } }`,
        { id: discussion_id, body, reply: reply_to_comment_id ?? null },
      )
      return { url: res.addDiscussionComment.comment.url }
    },
  }),

  tool({
    name: 'resolve_review_thread',
    kind: 'write',
    description: 'Resolve (or unresolve) a review thread by thread_id from list_review_threads. Resolve only after the concern is addressed or answered.',
    schema: z.object({ thread_id: z.string(), resolved: z.boolean().optional().describe('Default true.') }),
    summarize: (i) => `${i.resolved === false ? 'Unresolve' : 'Resolve'} review thread`,
    async run({ thread_id, resolved = true }, { octokit }) {
      await setThreadResolved(octokit, thread_id, resolved)
      return { ok: true, thread_id, resolved }
    },
  }),

  tool({
    name: 'submit_review',
    kind: 'write',
    description:
      'Submit a pull request review with an overall body and optional inline comments. event: COMMENT, APPROVE or REQUEST_CHANGES. Inline comment line numbers refer to the new file (side RIGHT) unless side is LEFT for deleted lines; lines must be inside the diff. Set start_line to comment on lines start_line..line (same hunk). For a concrete fix on RIGHT lines, put the replacement code for those lines in `suggestion`; it becomes a ```suggestion block the author can commit.',
    schema: z.object({
      ...prArgs,
      event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
      body: z.string().optional(),
      comments: z.array(z.object(inlineCommentArgs)).optional(),
    }),
    summarize: (i) => `Submit ${i.event.replace('_', ' ').toLowerCase()} review${i.comments?.length ? ` with ${i.comments.length} inline comments` : ''}`,
    async run({ owner, repo, number, event, body, comments }, { octokit }) {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
      try {
        const { data } = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: number,
          commit_id: pr.head.sha,
          event,
          body: body ?? '',
          comments: comments?.map(inlineComment),
        })
        return { id: data.id, state: data.state, url: data.html_url }
      } catch (e) {
        return pendingReviewError(e)
      }
    },
  }),

  tool({
    name: 'add_review_comment',
    kind: 'write',
    description:
      'Post one inline review comment on a pull request right away (like "Add single comment"), on a line or, with start_line, on lines start_line..line of one side. Lines must be inside the diff and in one hunk. For a concrete fix on RIGHT lines, put the replacement code for exactly those lines in `suggestion` (empty string deletes them); it becomes a ```suggestion block the author can commit. Use submit_review instead to post several comments as one review.',
    schema: z.object({ ...prArgs, ...inlineCommentArgs }),
    summarize: (i) => `Comment on ${i.path}:${i.start_line && i.start_line < i.line ? `${i.start_line}-` : ''}${i.line}${i.suggestion !== undefined ? ' with a suggestion' : ''}`,
    async run({ owner, repo, number, ...c }, { octokit }) {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
      try {
        const { data } = await octokit.rest.pulls.createReviewComment({ owner, repo, pull_number: number, commit_id: pr.head.sha, ...inlineComment(c) })
        return { id: data.id, url: data.html_url, start_line: data.start_line, line: data.line }
      } catch (e) {
        return pendingReviewError(e)
      }
    },
  }),

  tool({
    name: 'commit_files',
    kind: 'write',
    description:
      'Create one commit on a branch that changes one or more files, then move the branch to it. Each change provides either full `content`, a list of exact `edits` (old_str must match exactly once in the current file), or `delete: true`. Pass expected_head_sha (e.g. the PR head SHA) to refuse if the branch moved.',
    schema: z.object({
      ...repoArgs,
      branch: z.string().describe('Branch to commit to, e.g. the PR head branch.'),
      message: z.string().describe('Commit message.'),
      expected_head_sha: z.string().optional(),
      changes: z
        .array(
          z.object({
            path: z.string(),
            content: z.string().optional().describe('Full new file content.'),
            edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })).optional(),
            delete: z.boolean().optional(),
          }),
        )
        .min(1),
    }),
    summarize: (i) => `Commit ${i.changes.length} file${i.changes.length === 1 ? '' : 's'} to ${i.branch}: "${i.message.split('\n')[0]}"`,
    run({ owner, repo, branch, message, expected_head_sha, changes }, { octokit }) {
      return commitFiles(octokit, { owner, repo, branch, message, expectedHeadSha: expected_head_sha, changes })
    },
  }),

  tool({
    name: 'rerun_workflow',
    kind: 'write',
    description: 'Re-run a GitHub Actions workflow run, either all jobs or only the failed ones.',
    schema: z.object({ ...repoArgs, run_id: z.number().int(), failed_only: z.boolean().optional().describe('Default true.') }),
    summarize: (i) => `Re-run ${i.failed_only === false ? 'all jobs' : 'failed jobs'} of run ${i.run_id}`,
    async run({ owner, repo, run_id, failed_only = true }, { octokit }) {
      if (failed_only) await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id })
      else await octokit.rest.actions.reRunWorkflow({ owner, repo, run_id })
      return { ok: true, run_id }
    },
  }),

  tool({
    name: 'cancel_workflow_run',
    kind: 'write',
    description: 'Cancel an in-progress workflow run.',
    schema: z.object({ ...repoArgs, run_id: z.number().int() }),
    summarize: (i) => `Cancel run ${i.run_id}`,
    async run({ owner, repo, run_id }, { octokit }) {
      await octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id })
      return { ok: true }
    },
  }),

  tool({
    name: 'dispatch_workflow',
    kind: 'write',
    description: 'Trigger a workflow that has a workflow_dispatch trigger.',
    schema: z.object({
      ...repoArgs,
      workflow: z.string().describe('Workflow file name (e.g. ci.yml) or numeric id.'),
      ref: z.string().describe('Branch or tag to run on.'),
      inputs: z.record(z.string(), z.string()).optional(),
    }),
    summarize: (i) => `Run workflow ${i.workflow} on ${i.ref}`,
    async run({ owner, repo, workflow, ref, inputs }, { octokit }) {
      await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: /^\d+$/.test(workflow) ? Number(workflow) : workflow, ref, inputs })
      return { ok: true }
    },
  }),

  tool({
    name: 'update_pull_request_branch',
    kind: 'write',
    description: 'Merge the latest base branch into the pull request head branch ("Update branch").',
    schema: z.object(prArgs),
    summarize: (i) => `Update branch of #${i.number} from base`,
    async run({ owner, repo, number }, { octokit }) {
      const { data } = await octokit.rest.pulls.updateBranch({ owner, repo, pull_number: number })
      return data
    },
  }),

  tool({
    name: 'merge_pull_request',
    kind: 'write',
    description: 'Merge a pull request. Only when the user explicitly asks to merge.',
    schema: z.object({ ...prArgs, method: z.enum(['merge', 'squash', 'rebase']).optional() }),
    summarize: (i) => `Merge #${i.number}${i.method ? ` (${i.method})` : ''}`,
    async run({ owner, repo, number, method }, { octokit }) {
      const { data } = await octokit.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: method })
      return data
    },
  }),
]

export const TOOLS_BY_NAME = new Map<string, AgentTool>(TOOLS.map((t) => [t.name, t as unknown as AgentTool]))

function inputSchema(schema: z.ZodObject): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json as Anthropic.Tool.InputSchema
}

/** Tool definitions for the Messages API (stable order keeps the prompt cache warm). */
export const TOOL_DEFINITIONS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description + (t.kind === 'write' ? ' This changes GitHub state; the user may be asked to approve it.' : ''),
  input_schema: inputSchema(t.schema),
  eager_input_streaming: true,
}))
