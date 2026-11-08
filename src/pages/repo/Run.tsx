import { useMemo, useState, useLayoutEffect, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Banner, Button, NavList, RelativeTime, TextInput, IconButton } from '@primer/react'
import {
  ArrowLeftIcon,
  SyncIcon,
  StopIcon,
  SparkleFillIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
  HomeIcon,
  PackageIcon,
  LinkExternalIcon,
  TriangleDownIcon,
  CopyIcon,
  StopwatchIcon,
  FileCodeIcon,
  GitCommitIcon,
  XCircleFillIcon,
  AlertIcon,
  InfoIcon,
  SkipIcon,
  CircleIcon,
} from '@primer/octicons-react'
import { parse as parseYaml } from 'yaml'
import { useGitHub, decodeBase64, errorMessage, type Job } from '../../lib/github'
import { useRepo, encodePath } from '../../lib/repo'
import { AgentOnly, useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { fetchJobLogs, parseLog, splitLogBySteps, type LogLine, type StepLog } from '../../lib/logs'
import { durationBetween, shortSha, copyText } from '../../lib/format'
import { graphEdges } from '../../lib/runGraph'
import { webUrl } from '../../lib/links'
import { isNative, openExternal } from '../../lib/platform'
import { useEffectOnChange } from '../../lib/activity'
import { CheckStatusIcon } from '../../components/Status'
import { Blankslate, CopyButton, ErrorBox, Loading, UserAvatar } from '../../components/Bits'

export function RunPage() {
  const { owner, repo, fullName, data } = useRepo()
  const { runId = '', jobId } = useParams()
  const run_id = Number(runId)
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const agent = useAgent()

  const run = useQuery({
    queryKey: [key, 'run', owner, repo, run_id],
    queryFn: async () => (await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id })).data,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'completed' ? 5000 : false),
  })
  const jobs = useQuery({
    queryKey: [key, 'run-jobs', owner, repo, run_id],
    queryFn: async () => octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, { owner, repo, run_id, per_page: 100, filter: 'latest' }),
    refetchInterval: () => (run.data && run.data.status !== 'completed' ? 5000 : false),
  })
  const artifacts = useQuery({
    queryKey: [key, 'run-artifacts', owner, repo, run_id],
    queryFn: async () => octokit.paginate(octokit.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id, per_page: 100 }),
  })
  const workflowPath = run.data?.path.split('@')[0] ?? ''
  const spec = useWorkflowJobs(workflowPath, run.data?.head_sha ?? '')
  // Only the run summary shows annotations; a job page never reads them.
  const annotations = useRunAnnotations(run.data?.check_suite_id ?? undefined, jobs.data, !jobId)
  const orderedJobs = useMemo(() => orderJobs(spec.data ?? null, jobs.data ?? []), [spec.data, jobs.data])
  // Runs from forks come with an empty pull_requests list; find the pull request by its head branch instead.
  const isPullEvent = run.data?.event === 'pull_request' || run.data?.event === 'pull_request_target'
  const forkHead = run.data?.head_repository && run.data.head_repository.full_name !== run.data.repository.full_name ? run.data.head_repository : null
  const forkPull = useQuery({
    queryKey: [key, 'run-fork-pull', owner, repo, forkHead?.owner.login, run.data?.head_branch],
    enabled: isPullEvent && !!forkHead && !!run.data?.head_branch && !run.data?.pull_requests?.length,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await octokit.rest.pulls.list({ owner, repo, head: `${forkHead!.owner.login}:${run.data!.head_branch}`, state: 'all', per_page: 5 })
      return res.data.find((p) => p.head.sha === run.data!.head_sha) ?? res.data[0] ?? null
    },
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [key, 'run', owner, repo, run_id] })
    void qc.invalidateQueries({ queryKey: [key, 'run-jobs', owner, repo, run_id] })
    void qc.invalidateQueries({ queryKey: [key, 'runs', owner, repo] })
  }
  const act = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: refresh })

  const r = run.data
  const selectedJob = jobs.data?.find((j) => String(j.id) === jobId)
  const failedJobs = (jobs.data ?? []).filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out')

  useAgentPageContext(
    r
      ? {
          tabTitle: r.display_title,
          label: `workflow run “${r.display_title}” (${r.name} #${r.run_number}, run id ${r.id}) in ${fullName}${selectedJob ? `, job “${selectedJob.name}” (job id ${selectedJob.id})` : ''}`,
          owner,
          repo,
          details: { run_id: r.id, status: r.status, conclusion: r.conclusion, branch: r.head_branch, head_sha: r.head_sha, event: r.event, failed_jobs: failedJobs.map((j) => `${j.name} (${j.id})`).join(', ') },
          suggestions: [
            ...(failedJobs.length
              ? [
                  { label: 'Explain the failure', prompt: `Explain why workflow run ${r.id} in ${fullName} failed. Read the logs of the failed jobs (${failedJobs.map((j) => j.id).join(', ')}), identify the root cause, and suggest a fix.` },
                  { label: 'Fix it', prompt: `Workflow run ${r.id} in ${fullName} failed on branch ${r.head_branch} (${r.head_sha}). Find the root cause from the logs. If the code is at fault, fix it with a commit to ${r.head_branch}; if it's flaky, re-run the failed jobs. Explain what you did.` },
                ]
              : []),
            { label: 'Summarize run', prompt: `Summarize workflow run ${r.id} in ${fullName}: what ran, how long each job took, and anything noteworthy in the logs.` },
          ],
        }
      : null,
  )

  if (run.isLoading) return <Loading />
  if (run.error || !r)
    return (
      <div className="container-xl">
        <ErrorBox error={run.error} />
      </div>
    )

  const canWrite = !!data.permissions?.push
  const workflowFile = r.path.split('/').pop()?.split('@')[0]
  const workflowBlob = `/${owner}/${repo}/blob/${encodePath(r.head_sha)}/${encodePath(workflowPath)}`
  const actor = r.triggering_actor ?? r.actor
  // The API also lists pull requests from other repositories whose head is this branch; github.com shows only this repository's.
  const pulls: Array<{ number: number }> = (r.pull_requests ?? []).filter((p) => Number(p.base.repo.id) === data.id)
  if (!pulls.length && forkPull.data) pulls.push({ number: forkPull.data.number })
  const awaitingApproval = r.conclusion === 'action_required'
  const fork = r.head_repository && r.head_repository.full_name !== r.repository.full_name ? r.head_repository : null
  const runStatus = r.status === 'completed' ? r.conclusion : r.status
  return (
    <div className="container-full">
      <div className="mb-3">
        <Link to={`/${owner}/${repo}/actions/workflows/${workflowFile}`} className="link-muted run-parent-link">
          <ArrowLeftIcon /> {r.name}
        </Link>
        <div className="flex-center gap-2 wrap">
          <CheckStatusIcon status={r.status} conclusion={r.conclusion} size={22} />
          <h1 className="flex-1 run-title">
            {r.display_title} <span className="fg-muted text-normal">#{r.run_number}</span>
          </h1>
          {!isNative && <CopyButton text={r.html_url} label="Copy link to this run" size="medium" />}
          {failedJobs.length > 0 && (
            <AgentOnly><Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Explain why workflow run ${r.id} in ${fullName} failed and propose a fix. Failed jobs: ${failedJobs.map((j) => `${j.name} (${j.id})`).join(', ')}.`)}>
              Explain failure
            </Button></AgentOnly>
          )}
          {canWrite && r.status === 'completed' && (
            <ActionMenu>
              <ActionMenu.Anchor>
                <Button leadingVisual={SyncIcon} trailingVisual={TriangleDownIcon} loading={act.isPending}>
                  Re-run jobs
                </Button>
              </ActionMenu.Anchor>
              <ActionMenu.Overlay align="end">
                <ActionList>
                  <ActionList.Item onSelect={() => act.mutate(() => octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id }))} disabled={!failedJobs.length}>
                    Re-run failed jobs
                  </ActionList.Item>
                  <ActionList.Item onSelect={() => act.mutate(() => octokit.rest.actions.reRunWorkflow({ owner, repo, run_id }))}>Re-run all jobs</ActionList.Item>
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          )}
          {canWrite && r.status !== 'completed' && (
            <Button variant="danger" leadingVisual={StopIcon} loading={act.isPending} onClick={() => act.mutate(() => octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id }))}>
              Cancel workflow
            </Button>
          )}
          {!isNative && <IconButton icon={LinkExternalIcon} aria-label="Open on GitHub" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/actions/runs/${run_id}${jobId ? `/job/${jobId}` : ''}`))} />}
        </div>
        {act.error && <div className="error-box mt-2">{errorMessage(act.error)}</div>}
      </div>

      <div className="layout-sidebar-left" style={{ gridTemplateColumns: '280px minmax(0,1fr)' }}>
        <div>
          <NavList aria-label="Run">
            <NavList.Item as={Link} to={`/${owner}/${repo}/actions/runs/${run_id}`} aria-current={!jobId ? 'page' : undefined}>
              <NavList.LeadingVisual>
                <HomeIcon />
              </NavList.LeadingVisual>
              Summary
            </NavList.Item>
            <NavList.Group title="All jobs">
              {orderedJobs.map((j) => (
                <NavList.Item key={j.id} as={Link} to={`/${owner}/${repo}/actions/runs/${run_id}/job/${j.id}`} aria-current={String(j.id) === jobId ? 'page' : undefined}>
                  <NavList.LeadingVisual>
                    <CheckStatusIcon status={j.status} conclusion={j.conclusion} />
                  </NavList.LeadingVisual>
                  {j.name}
                </NavList.Item>
              ))}
            </NavList.Group>
            <NavList.Group title="Run details">
              <NavList.Item
                href={webUrl(account.host, `/${owner}/${repo}/actions/runs/${run_id}/usage`)}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault()
                  openExternal(webUrl(account.host, `/${owner}/${repo}/actions/runs/${run_id}/usage`))
                }}
              >
                <NavList.LeadingVisual>
                  <StopwatchIcon />
                </NavList.LeadingVisual>
                Usage
                <NavList.TrailingVisual>
                  <LinkExternalIcon />
                </NavList.TrailingVisual>
              </NavList.Item>
              <NavList.Item as={Link} to={workflowBlob}>
                <NavList.LeadingVisual>
                  <FileCodeIcon />
                </NavList.LeadingVisual>
                Workflow file
              </NavList.Item>
            </NavList.Group>
          </NavList>
        </div>
        <div style={{ minWidth: 0 }}>
          {selectedJob ? (
            <JobLogs job={selectedJob} canWrite={canWrite} onChanged={refresh} />
          ) : jobId && jobs.isLoading ? (
            <Loading />
          ) : (
            <>
              {awaitingApproval && (
                <Banner
                  className="mb-3"
                  variant="warning"
                  hideTitle
                  title="Awaiting approval"
                  description={
                    <>
                      This workflow is awaiting approval from a maintainer
                      {pulls.length > 0 && (
                        <>
                          {' '}
                          in <Link to={`/${owner}/${repo}/pull/${pulls[0].number}`}>#{pulls[0].number}</Link>
                        </>
                      )}
                    </>
                  }
                />
              )}
              <div className="Box run-summary mb-3" role="region" aria-label="Workflow run summary">
                <div className="run-summary-item">
                  <span className="run-summary-label">
                    {r.event === 'workflow_dispatch' ? 'Manually triggered' : `Triggered via ${r.event.replace(/_/g, ' ')}`} <RelativeTime date={new Date(r.run_started_at ?? r.created_at)} />
                  </span>
                  <div className="run-trigger">
                    {actor && (
                      <Link to={`/${actor.login}`} className="run-actor">
                        <UserAvatar login={actor.login} src={actor.avatar_url} size={16} />
                        {actor.login}
                      </Link>
                    )}
                    {r.event === 'push' && <span className="fg-default">pushed</span>}
                    {(r.event === 'pull_request' || r.event === 'pull_request_target') && pulls.length ? (
                      pulls.map((p) => (
                        <Link key={p.number} to={`/${owner}/${repo}/pull/${p.number}`} className="fg-default">
                          #{p.number}
                        </Link>
                      ))
                    ) : (
                      <Link to={`/${owner}/${repo}/commit/${r.head_sha}`} className="run-sha">
                        <GitCommitIcon size={16} /> {shortSha(r.head_sha)}
                      </Link>
                    )}
                    {r.head_branch && (
                      <Link to={`/${fork ? fork.full_name : `${owner}/${repo}`}/tree/${encodePath(r.head_branch)}`} className="branch-pill" title={r.head_branch}>
                        {fork ? `${fork.owner.login}:${r.head_branch}` : r.head_branch}
                      </Link>
                    )}
                  </div>
                </div>
                <div className="run-summary-item">
                  <span className="run-summary-label">Status</span>
                  <span className="run-summary-value">{runStatus ? runStatus[0].toUpperCase() + runStatus.slice(1).replace(/_/g, ' ') : '–'}</span>
                </div>
                <div className="run-summary-item">
                  <span className="run-summary-label">Total duration</span>
                  {/* A run waiting for approval never started: github.com shows a dash, as the Actions list does. */}
                  <span className="run-summary-value">{awaitingApproval ? '–' : durationBetween(r.run_started_at ?? r.created_at, r.status === 'completed' ? r.updated_at : null)}</span>
                </div>
                <div className="run-summary-item">
                  <span className="run-summary-label">Artifacts</span>
                  <span className="run-summary-value">{artifacts.data?.length || '–'}</span>
                </div>
              </div>
              <div className="run-graph-box mb-3">
                <div className="run-graph-head">
                  <h2>
                    <Link to={workflowBlob}>{workflowFile}</Link>
                  </h2>
                  <div className="text-small fg-muted">on: {r.event}</div>
                </div>
                {jobs.isLoading ? <Loading /> : <JobGraph jobs={orderedJobs} specs={spec.data ?? null} runId={run_id} />}
              </div>
              {annotations.data && annotations.data.list.length > 0 && (
                <div className="Box run-section mb-3" role="region" aria-label="Annotations">
                  <div className="run-section-head">
                    <h2>Annotations</h2>
                    <div className="text-small fg-muted">{annotationSummary(annotations.data.list)}</div>
                  </div>
                  {annotations.data.list.map((a, i) => (
                    <AnnotationRow key={i} annotation={a} title={a.title || a.job.name} to={`/${owner}/${repo}/actions/runs/${run_id}/job/${a.job.id}`} />
                  ))}
                  {annotations.data.skipped > 0 && (
                    <div className="run-annotation text-small fg-muted">
                      Annotations from {annotations.data.skipped} more job{annotations.data.skipped === 1 ? '' : 's'} are on each job's page.
                    </div>
                  )}
                </div>
              )}
              {(artifacts.data?.length ?? 0) > 0 && (
                <div className="Box run-section">
                  <div className="run-section-head">
                    <h2>Artifacts</h2>
                    <div className="text-small fg-muted">Produced during runtime</div>
                  </div>
                  <table className="run-artifacts">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th className="col-size">Size</th>
                        <th className="col-digest">Digest</th>
                        <th className="col-actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {[...artifacts.data!]
                        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                        .map((a) => (
                          <tr key={a.id}>
                            <td>
                              <span className="flex-center gap-2">
                                <PackageIcon className="fg-muted shrink-0" />
                                <span className={`text-bold text-break ${a.expired ? 'fg-muted' : 'fg-default'}`}>{a.name}</span>
                              </span>
                            </td>
                            <td>{humanSize(a.size_in_bytes)}</td>
                            <td>
                              {a.digest && (
                                <span className="flex-center gap-1">
                                  <code className="text-truncate">{a.digest}</code>
                                  <CopyButton text={a.digest} label="Copy artifact digest" />
                                </span>
                              )}
                            </td>
                            <td className="col-actions">
                              {a.expired ? (
                                <span className="fg-muted text-small">Expired</span>
                              ) : (
                                <Button size="small" onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/actions/runs/${run_id}/artifacts/${a.id}`))}>
                                  Download
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** "924 KB", "1.23 MB": three significant digits in base 1024, like github.com's artifact sizes. */
function humanSize(bytes: number) {
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : Number(n.toPrecision(3))} ${units[i]}`
}

interface JobSpec {
  key: string
  /** The job's `name:` (or its key), as written: it may hold ${{ }} expressions. */
  label: string
  needs: string[]
  matrix: boolean
  reusable: boolean
}

/** The workflow file's jobs, for laying the jobs out by `needs` and grouping matrix jobs as github.com does. */
function useWorkflowJobs(path: string, ref: string) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'run-workflow-jobs', owner, repo, path, ref],
    enabled: !!path && !!ref && path.startsWith('.github/'),
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<JobSpec[] | null> => {
      const res = await octokit.rest.repos.getContent({ owner, repo, path, ref })
      if (Array.isArray(res.data) || res.data.type !== 'file') return null
      const doc = parseYaml(decodeBase64(res.data.content)) as { jobs?: Record<string, Record<string, unknown> | null> } | null
      if (!doc?.jobs || typeof doc.jobs !== 'object') return null
      return Object.entries(doc.jobs).map(([k, j]) => {
        const needs = j?.needs
        return {
          key: k,
          label: typeof j?.name === 'string' ? j.name : k,
          needs: Array.isArray(needs) ? needs.map(String) : typeof needs === 'string' ? [needs] : [],
          matrix: !!(j?.strategy as { matrix?: unknown } | undefined)?.matrix,
          reusable: typeof j?.uses === 'string',
        }
      })
    },
  })
}

const EXPR = /\$\{\{[\s\S]*?\}\}/g
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface GraphCard {
  id: string
  heading?: string
  matrix: boolean
  /** The workflow-file jobs this card shows. */
  keys: string[]
  jobs: Job[]
  /** Jobs of the workflow file that have no job yet (the run is waiting, or hasn't reached them), by name. */
  pending: string[]
  order: number
}

/** Columns of cards, from each job's `needs`, or null when the jobs can't be matched to the workflow file. */
/** Which workflow-file job each API job comes from, by its name: `name:` may hold expressions, matrix jobs get " (values)" appended, reusable workflow jobs " / inner job". */
function matchJobs(specs: JobSpec[], jobs: Job[]) {
  const patterns = specs.map((s) => {
    const body = s.label.split(EXPR).map(escapeRe).join('.*?')
    return { spec: s, literal: s.label.replace(EXPR, '').length, re: new RegExp(`^(?:${body}|${escapeRe(s.key)})(?: \\(.*\\))?(?: / .*)?$`) }
  })
  const out = new Map<number, JobSpec>()
  for (const j of jobs) {
    const exact = specs.find((s) => s.label === j.name || s.key === j.name)
    const best = exact ?? patterns.filter((p) => p.re.test(j.name)).sort((a, b) => b.literal - a.literal)[0]?.spec
    if (best) out.set(j.id, best)
  }
  return out
}

/** Jobs in workflow-file order, as github.com lists them; the API lists them in the order they were created. */
function orderJobs(specs: JobSpec[] | null, jobs: Job[]) {
  if (!specs) return jobs
  const matched = matchJobs(specs, jobs)
  const pos = (j: Job) => {
    const s = matched.get(j.id)
    return s ? specs.indexOf(s) : specs.length
  }
  return [...jobs].sort((a, b) => pos(a) - pos(b) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

function layoutJobs(specs: JobSpec[], jobs: Job[]): GraphCard[][] | null {
  const matched = matchJobs(specs, jobs)
  const byKey = new Map<string, Job[]>()
  const unmatched: Job[] = []
  for (const j of jobs) {
    const s = matched.get(j.id)
    if (!s) unmatched.push(j)
    else byKey.set(s.key, [...(byKey.get(s.key) ?? []), j])
  }
  if (jobs.length && unmatched.length === jobs.length) return null
  const index = new Map(specs.map((s) => [s.key, s]))
  const depth = new Map<string, number>()
  const depthOf = (k: string, seen: Set<string>): number => {
    if (depth.has(k)) return depth.get(k)!
    const s = index.get(k)
    if (!s || seen.has(k)) return 0
    seen.add(k)
    const d = s.needs.length ? 1 + Math.max(...s.needs.map((n) => depthOf(n, seen))) : 0
    depth.set(k, d)
    return d
  }
  const dependents = (k: string) =>
    specs
      .filter((s) => s.needs.includes(k))
      .map((s) => s.key)
      .sort()
      .join(',')
  const stages: Map<string, GraphCard>[] = []
  specs.forEach((s, order) => {
    // Placeholders only when every job was matched, so a job is never shown twice.
    const list = byKey.get(s.key) ?? []
    if (!list.length && unmatched.length) return
    const name = s.label.includes('${{') ? s.key : s.label
    const pending = list.length ? [] : [name]
    const d = depthOf(s.key, new Set())
    const stage = (stages[d] ??= new Map())
    if (s.matrix || s.reusable) {
      stage.set(`k:${s.key}`, { id: `k:${s.key}`, heading: s.matrix ? `Matrix: ${name}` : name, matrix: s.matrix, keys: [s.key], jobs: list, pending, order })
      return
    }
    // Like github.com, jobs with the same needs and the same dependents share a card.
    const id = `g:${[...s.needs].sort().join(',')}|${dependents(s.key)}`
    const card = stage.get(id)
    if (card) {
      card.keys.push(s.key)
      card.jobs.push(...list)
      card.pending.push(...pending)
    } else stage.set(id, { id, matrix: false, keys: [s.key], jobs: [...list], pending, order })
  })
  if (unmatched.length) {
    const first = (stages[0] ??= new Map())
    for (const j of unmatched) first.set(`j:${j.id}`, { id: `j:${j.id}`, matrix: false, keys: [], jobs: [j], pending: [], order: Infinity })
  }
  return stages.filter(Boolean).map((m) => [...m.values()].sort((a, b) => a.order - b.order))
}

function groupStatus(jobs: Job[]): { status: string; conclusion: string | null } {
  if (jobs.some((j) => j.status !== 'completed')) return { status: jobs.some((j) => j.status === 'in_progress') ? 'in_progress' : 'queued', conclusion: null }
  const has = (...c: string[]) => jobs.some((j) => c.includes(j.conclusion ?? ''))
  const conclusion = has('failure', 'timed_out', 'startup_failure') ? 'failure' : has('cancelled') ? 'cancelled' : jobs.every((j) => j.conclusion === 'skipped') ? 'skipped' : 'success'
  return { status: 'completed', conclusion }
}

/** Half the height of a card's first row, where its lines join. */
const GRAPH_ROW_CENTER = 22

function JobGraph({ jobs, specs, runId }: { jobs: Job[]; specs: JobSpec[] | null; runId: number }) {
  const { owner, repo } = useRepo()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const stages = useMemo(() => (specs ? layoutJobs(specs, jobs) : null), [specs, jobs])
  const edges = useMemo(() => (stages && specs ? graphEdges(stages.flat(), (k) => specs.find((s) => s.key === k)?.needs ?? []) : []), [stages, specs])
  const graph = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<{ width: number; height: number; paths: Array<{ x1: number; y1: number; x2: number; y2: number }> } | null>(null)
  // The lines follow where the cards landed, which depends on the fonts, the width and any matrix that's been opened.
  useLayoutEffect(() => {
    const box = graph.current
    if (!box || !edges.length) return setLines(null)
    const measure = () => {
      const origin = box.getBoundingClientRect()
      const rectOf = (id: string) => box.querySelector(`[data-card="${CSS.escape(id)}"]`)?.getBoundingClientRect()
      const paths = edges.flatMap(([from, to]) => {
        const [a, b] = [rectOf(from), rectOf(to)]
        if (!a || !b) return []
        return [{ x1: a.right - origin.left + box.scrollLeft, y1: a.top - origin.top + box.scrollTop + GRAPH_ROW_CENTER, x2: b.left - origin.left + box.scrollLeft, y2: b.top - origin.top + box.scrollTop + GRAPH_ROW_CENTER }]
      })
      setLines({ width: box.scrollWidth, height: box.scrollHeight, paths })
    }
    measure()
    const seen = new ResizeObserver(measure)
    seen.observe(box)
    box.querySelectorAll('[data-card]').forEach((card) => seen.observe(card))
    return () => seen.disconnect()
  }, [edges, expanded])
  const jobLink = (j: Job) => (
    <Link key={j.id} to={`/${owner}/${repo}/actions/runs/${runId}/job/${j.id}`} className="graph-job">
      <CheckStatusIcon status={j.status} conclusion={j.conclusion} />
      <span className="graph-job-name">{j.name}</span>
      <span className="graph-job-time">{durationBetween(j.started_at, j.completed_at)}</span>
    </Link>
  )
  if (!stages)
    return (
      <div className="run-graph wrap">
        {jobs.map((j) => (
          <div key={j.id} className="graph-card">
            {jobLink(j)}
          </div>
        ))}
      </div>
    )
  return (
    <div className="run-graph" ref={graph}>
      {lines && (
        <svg className="run-graph-lines" width={lines.width} height={lines.height} aria-hidden="true">
          {lines.paths.map(({ x1, y1, x2, y2 }) => {
            const bend = (x2 - x1) / 2
            return (
              <g key={`${x1},${y1},${x2},${y2}`}>
                <path d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`} />
                <circle cx={x1} cy={y1} r={3.5} />
                <circle cx={x2} cy={y2} r={3.5} />
              </g>
            )
          })}
        </svg>
      )}
      {stages.map((cards, i) => (
        <div key={i} className="graph-stage">
          {cards.map((c) => {
            const done = c.jobs.filter((j) => j.status === 'completed').length
            const st = groupStatus(c.jobs)
            return (
              <div key={c.id} data-card={c.id} className={`graph-card ${c.jobs.length + c.pending.length > 1 || c.heading ? 'group' : ''} ${c.heading ? 'has-heading' : ''}`}>
                {c.heading && <div className="graph-card-heading text-truncate">{c.heading}</div>}
                {c.heading && !c.jobs.length ? (
                  <div className="graph-job pending">
                    <CircleIcon />
                    <span className="graph-job-name">Waiting for pending jobs</span>
                  </div>
                ) : c.matrix && !expanded[c.id] ? (
                  <button type="button" className="graph-matrix" onClick={() => setExpanded((e) => ({ ...e, [c.id]: true }))}>
                    <span className="flex-center gap-2">
                      <CheckStatusIcon status={st.status} conclusion={st.conclusion} />
                      <span className="text-bold fg-default">
                        {done === c.jobs.length ? `${c.jobs.length} job${c.jobs.length === 1 ? '' : 's'} completed` : `${done}/${c.jobs.length} jobs completed`}
                      </span>
                    </span>
                    <span className="text-small fg-muted">Show all jobs</span>
                  </button>
                ) : (
                  <>
                    {c.jobs.map(jobLink)}
                    {!c.heading &&
                      c.pending.map((name) => (
                        <div key={name} className="graph-job pending">
                          <CircleIcon />
                          <span className="graph-job-name">{name}</span>
                        </div>
                      ))}
                  </>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface RunAnnotation {
  job: Job
  level: string
  title: string
  message: string
}

const LEVEL_RANK: Record<string, number> = { failure: 0, warning: 1, notice: 2 }
/** At most this many jobs' annotations on the summary, failed jobs first: each job costs a request. */
const ANNOTATED_JOBS_LIMIT = 30

function useRunAnnotations(checkSuiteId: number | undefined, jobs: Job[] | undefined, enabled: boolean) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  // Refetch when a job fails or the run finishes, not on every job that completes: each fetch costs a request per annotated job.
  const failed = jobs?.filter((j) => j.conclusion === 'failure').length
  const finished = !!jobs?.every((j) => j.status === 'completed')
  return useQuery({
    queryKey: [key, 'run-annotations', owner, repo, checkSuiteId, jobs?.length, failed, finished],
    enabled: enabled && !!checkSuiteId && !!jobs?.length,
    // A finished run's annotations never change; don't refetch them all on every window focus.
    staleTime: finished ? Infinity : 30_000,
    queryFn: async () => {
      const byId = new Map(jobs!.map((j) => [j.id, j]))
      const checks = await octokit.paginate(octokit.rest.checks.listForSuite, { owner, repo, check_suite_id: checkSuiteId!, filter: 'latest', per_page: 100 })
      const noted = checks
        .filter((c) => (c.output?.annotations_count ?? 0) > 0 && byId.has(c.id))
        .sort((a, b) => Number(b.conclusion === 'failure') - Number(a.conclusion === 'failure'))
      const lists = await Promise.all(
        noted.slice(0, ANNOTATED_JOBS_LIMIT).map(async (c) =>
          (await octokit.paginate(octokit.rest.checks.listAnnotations, { owner, repo, check_run_id: c.id, per_page: 100 })).map(
            (a): RunAnnotation => ({ job: byId.get(c.id)!, level: a.annotation_level ?? 'notice', title: a.title ?? '', message: a.message ?? '' }),
          ),
        ),
      )
      const order = new Map(jobs!.map((j, i) => [j.id, i]))
      const list = lists.flat().sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3) || order.get(a.job.id)! - order.get(b.job.id)!)
      return { list, skipped: Math.max(0, noted.length - ANNOTATED_JOBS_LIMIT) }
    },
  })
}

/** "1 error, 2 warnings, and 3 notices", as on github.com. */
function annotationSummary(list: Array<{ level: string }>) {
  const count = (level: string) => list.filter((a) => a.level === level).length
  const parts = (
    [
      [count('failure'), 'error'],
      [count('warning'), 'warning'],
      [count('notice'), 'notice'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`)
  return parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

function AnnotationRow({ annotation: a, title, to, onPick }: { annotation: { level: string; message: string }; title: string; to?: string; onPick?(): void }) {
  const [more, setMore] = useState(false)
  const long = a.message.split('\n').length > 4 || a.message.length > 400
  return (
    <div className="run-annotation">
      {a.level === 'failure' ? <XCircleFillIcon className="fg-danger shrink-0" /> : a.level === 'warning' ? <AlertIcon className="fg-attention shrink-0" /> : <InfoIcon className="fg-muted shrink-0" />}
      <div style={{ minWidth: 0 }}>
        {title &&
          (to ? (
            <Link to={to} className="run-annotation-title">
              {title}
            </Link>
          ) : (
            <button type="button" className="run-annotation-title" onClick={onPick}>
              {title}
            </button>
          ))}
        <div className={`run-annotation-message ${long && !more ? 'contracted' : ''}`}>{a.message}</div>
        {long && (
          <button type="button" className="run-annotation-more" onClick={() => setMore((m) => !m)}>
            {more ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}

/** The job page's collapsible annotations box; each annotation is titled with the step that logged it, as on github.com. */
function JobAnnotations({ job, steps, onPick }: { job: Job; steps: StepLog[]; onPick(step: number): void }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const [open, setOpen] = useState(false)
  const notes = useQuery({
    queryKey: [key, 'annotations', owner, repo, job.id, job.status],
    queryFn: async () => (await octokit.rest.checks.listAnnotations({ owner, repo, check_run_id: job.id, per_page: 100 })).data,
  })
  const list = useMemo(
    () =>
      [...(notes.data ?? [])]
        .sort((a, b) => (LEVEL_RANK[a.annotation_level ?? ''] ?? 3) - (LEVEL_RANK[b.annotation_level ?? ''] ?? 3))
        .map((a) => {
          const level = a.annotation_level ?? 'notice'
          const message = a.message ?? ''
          const first = message.split('\n')[0].trim()
          const kind = level === 'failure' ? 'error' : level
          const step = first ? steps.find((s) => s.lines.some((l) => l.kind === kind && l.text.includes(first))) : undefined
          return { level, message, title: a.title || step?.name || '', step: step?.number }
        }),
    [notes.data, steps],
  )
  if (!list.length) return null
  return (
    <div className="Box run-section mb-3" role="region" aria-label="Annotations">
      <button type="button" className="run-section-head run-section-toggle" aria-expanded={open} aria-label={open ? 'Close job annotations' : 'Open job annotations'} onClick={() => setOpen((o) => !o)}>
        <span className="fg-muted">{open ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
        <span>
          <h2>Annotations</h2>
          <span className="run-section-sub">{annotationSummary(list)}</span>
        </span>
      </button>
      {open && list.map((a, i) => <AnnotationRow key={i} annotation={a} title={a.title} onPick={a.step ? () => onPick(a.step!) : undefined} />)}
    </div>
  )
}

/** "failed", "succeeded"…: the verb github.com's job header puts before the time. */
function jobVerb(job: Job) {
  if (job.status !== 'completed') return job.status === 'in_progress' ? 'started' : (job.status ?? '').replace(/_/g, ' ')
  const words: Record<string, string> = { success: 'succeeded', failure: 'failed', timed_out: 'timed out', startup_failure: 'failed', action_required: 'requires action' }
  return words[job.conclusion ?? ''] ?? (job.conclusion ?? 'completed').replace(/_/g, ' ')
}

function JobLogs({ job, canWrite, onChanged }: { job: Job; canWrite: boolean; onChanged(): void }) {
  const { owner, repo, fullName } = useRepo()
  const { octokit, key, account } = useGitHub()
  const agent = useAgent()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Record<number, boolean>>({})

  const logs = useQuery({
    queryKey: [key, 'job-logs', owner, repo, job.id, job.status],
    enabled: job.status === 'completed' && job.conclusion !== 'skipped',
    queryFn: () => fetchJobLogs(octokit, account, owner, repo, job.id),
    staleTime: Infinity,
  })
  const rerun = useMutation({ mutationFn: () => octokit.rest.actions.reRunJobForWorkflowRun({ owner, repo, job_id: job.id }), onSuccess: onChanged })

  const steps = useMemo(() => {
    if (!logs.data) return []
    const parsed = parseLog(logs.data)
    const split = splitLogBySteps(job.steps ?? [], parsed)
    return split.length ? split : [{ number: 1, name: job.name, status: job.status, conclusion: job.conclusion, lines: parsed }]
  }, [logs.data, job])
  useEffectOnChange(() => {
    // Expand failed steps by default, like github.com.
    const next: Record<number, boolean> = {}
    // Expand failed steps, and any step GitHub annotated with an error, like github.com.
    for (const s of steps) if (s.conclusion === 'failure' || s.lines.some((l) => l.annotated)) next[s.number] = true
    setOpen(next)
  }, [steps])

  const failed = job.conclusion === 'failure' || job.conclusion === 'timed_out'
  const skipped = job.status === 'completed' && job.conclusion === 'skipped'
  // github.com dates a finished job by when it finished.
  const at = job.status === 'completed' ? (job.completed_at ?? job.started_at) : job.started_at
  return (
    <>
      <JobAnnotations job={job} steps={steps} onPick={(n) => setOpen((o) => ({ ...o, [n]: true }))} />
      <div className="Box job-log">
        <div className="job-log-header">
          <div className="flex-1">
            <div className="job-log-title">{job.name}</div>
            <div className="text-small fg-muted">
              {jobVerb(job)}{' '}
              {at && !skipped && (
                <>
                  <RelativeTime date={new Date(at)} /> in {durationBetween(job.started_at, job.completed_at)}
                </>
              )}
              {job.runner_name && ` · ${job.runner_name}`}
            </div>
          </div>
          <TextInput leadingVisual={SearchIcon} placeholder="Search logs" size="small" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search logs" />
          {failed && (
            <AgentOnly><Button size="small" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Job "${job.name}" (job id ${job.id}) failed in ${fullName}. Read its logs with get_job_logs, explain the root cause, and propose a fix.`)}>
              Explain
            </Button></AgentOnly>
          )}
          {canWrite && job.status === 'completed' && (
            <IconButton description="Re-run this job" size="small" icon={SyncIcon} aria-label="Re-run this job" onClick={() => rerun.mutate()} />
          )}
          {logs.data && (
            <IconButton description="Copy full log" size="small" icon={CopyIcon} aria-label="Copy full log" onClick={() => void copyText(logs.data!)} />
          )}
        </div>
        {rerun.error && <div className="Box-row fg-danger">{errorMessage(rerun.error)}</div>}
        <div className="log-view">
          {skipped ? (
            <Blankslate icon={<SkipIcon />} title="This job was skipped" />
          ) : !logs.data ? (
            // Like github.com, list the steps while the log loads, and when it can't be shown.
            <>
              {logs.error && (
                <div className="p-3">
                  <ErrorBox error={logs.error} title="Could not load logs" />
                </div>
              )}
              {(job.steps ?? []).map((s) => (
                <div key={s.number} className="log-step">
                  <div className="log-step-header">
                    <ChevronRightIcon className="fg-muted" />
                    <CheckStatusIcon status={s.status} conclusion={s.conclusion} />
                    <span className="flex-1">{s.name}</span>
                    <span className="log-step-time">{durationBetween(s.started_at, s.completed_at)}</span>
                  </div>
                </div>
              ))}
              {job.status !== 'completed' ? (
                <p className="job-log-note">Full logs appear here when the job finishes. This page refreshes automatically.</p>
              ) : (
                logs.isLoading && <Loading label="Loading logs" />
              )}
            </>
          ) : (
            steps.map((s) => {
              const isOpen = open[s.number] || (!!search && s.lines.some((l) => l.text.toLowerCase().includes(search.toLowerCase())))
              return (
                <div key={s.number} className="log-step">
                  <button type="button" className="log-step-header" onClick={() => setOpen((o) => ({ ...o, [s.number]: !isOpen }))} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    <CheckStatusIcon status={s.status} conclusion={s.conclusion} />
                    <span className="flex-1">{s.name}</span>
                    <span className="log-step-time">{durationBetween(s.started_at, s.completed_at)}</span>
                  </button>
                  {isOpen && <StepLines lines={s.lines} search={search} />}
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

function StepLines({ lines, search }: { lines: LogLine[]; search: string }) {
  const [collapsedGroups, setCollapsed] = useState<Record<number, boolean>>({})
  const needle = search.toLowerCase()
  const out: React.ReactNode[] = []
  let hiddenUntilEnd: number | null = null
  for (const l of lines) {
    if (l.kind === 'endgroup') {
      hiddenUntilEnd = null
      continue
    }
    if (hiddenUntilEnd !== null && !needle) continue
    const isMatch = !!needle && l.text.toLowerCase().includes(needle)
    if (l.kind === 'group') {
      const collapsed = collapsedGroups[l.n] ?? true
      if (collapsed && !needle) hiddenUntilEnd = l.n
      out.push(
        <div key={l.n} className={`log-line group ${isMatch ? 'match' : ''}`} onClick={() => setCollapsed((c) => ({ ...c, [l.n]: !collapsed }))}>
          <span className="ln">{l.n}</span>
          <span>
            {collapsed && !needle ? '▸ ' : '▾ '}
            {l.text}
          </span>
        </div>,
      )
      continue
    }
    out.push(
      <div key={l.n} className={`log-line ${l.kind === 'error' ? 'error' : l.kind === 'warning' ? 'warning' : l.kind === 'command' ? 'command' : ''} ${isMatch ? 'match' : ''}`}>
        <span className="ln">{l.n}</span>
        <span>{l.text}</span>
      </div>,
    )
  }
  return <div style={{ paddingBottom: 8 }}>{out}</div>
}
