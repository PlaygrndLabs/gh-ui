import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Button, NavList, RelativeTime } from '@primer/react'
import { SyncIcon, SparkleFillIcon, FileIcon, LinkExternalIcon, ReportIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage, type PullRequest, type CheckRun } from '../../../lib/github'
import { useRepo, encodePath } from '../../../lib/repo'
import { useAgent } from '../../../lib/agent/AgentProvider'
import { durationBetween, firstLine, plural, shortSha } from '../../../lib/format'
import { openExternal } from '../../../lib/platform'
import { CheckStatusIcon } from '../../../components/Status'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { Markdown } from '../../../components/Markdown'
import { useChecks, useInvalidatePull, actionsIds } from './data'

const FAILED = ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']

interface CheckGroup {
  key: string
  title: string
  /** "on: pull_request" for Actions workflows. */
  event?: string
  runs: CheckRun[]
  /** Status of a workflow run that has no jobs yet. */
  workflowStatus?: string | null
}

export function ChecksTab({ pr }: { pr: PullRequest }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const checks = useChecks(owner, repo, pr.head.sha)
  const [params, setParams] = useSearchParams()
  const runs = checks.data?.runs ?? []
  // Actions check runs only know their app ("GitHub Actions"); github.com lists them under their workflow, so look the
  // workflow runs up by id. This also finds workflows with no jobs yet (a fork's runs awaiting approval), which
  // github.com lists too. Keyed on the run ids so a workflow whose jobs start later on this commit is picked up.
  const workflowRunIds = [...new Set(runs.map((r) => actionsIds(r.details_url)?.runId).filter((id): id is number => !!id))].sort((a, b) => a - b)
  const workflowRuns = useQuery({
    queryKey: [key, 'pr-workflow-runs', owner, repo, pr.head.sha, workflowRunIds.join(',')],
    enabled: !checks.isLoading,
    staleTime: Infinity,
    queryFn: async () => (await octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo, head_sha: pr.head.sha, per_page: 100 })).data.workflow_runs,
  })
  const commit = useQuery({
    queryKey: [key, 'git-commit', owner, repo, pr.head.sha],
    staleTime: Infinity,
    queryFn: async () => (await octokit.rest.git.getCommit({ owner, repo, commit_sha: pr.head.sha })).data,
  })

  const groups = useMemo(() => {
    const byId = new Map((workflowRuns.data ?? []).map((w) => [w.id, w]))
    const m = new Map<string, CheckGroup & { order: number }>()
    for (const r of checks.data?.runs ?? []) {
      const runId = actionsIds(r.details_url)?.runId
      const wf = runId ? byId.get(runId) : undefined
      const k = runId ? `run:${runId}` : `app:${r.app?.slug ?? r.app?.name ?? ''}`
      const g = m.get(k) ?? { key: k, title: wf?.name ?? (runId ? (r.app?.name ?? 'GitHub Actions') : (r.app?.slug ?? r.app?.name ?? 'Checks')), event: wf?.event, runs: [], order: r.check_suite?.id ?? r.id }
      g.runs.push(r)
      g.order = Math.min(g.order, r.check_suite?.id ?? r.id)
      m.set(k, g)
    }
    const titles = new Set([...m.values()].map((g) => g.title))
    for (const w of workflowRuns.data ?? []) {
      if (m.has(`run:${w.id}`) || titles.has(w.name ?? '')) continue
      m.set(`run:${w.id}`, { key: `run:${w.id}`, title: w.name ?? `Workflow run ${w.id}`, event: w.event, runs: [], workflowStatus: w.status, order: w.check_suite_id ?? w.id })
    }
    // Suites in the order they were created, jobs in the order they started, as on github.com.
    const list = [...m.values()].sort((a, b) => a.order - b.order)
    for (const g of list) g.runs.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '') || a.id - b.id)
    return list
  }, [checks.data, workflowRuns.data])

  if (checks.isLoading) return <Loading />
  if (checks.error) return <ErrorBox error={checks.error} />
  // Until the workflow runs arrive, Actions checks could only be grouped under "GitHub Actions"; wait for their names.
  if ((!runs.length || workflowRunIds.length > 0) && workflowRuns.isLoading) return <Loading />
  if (!runs.length && !checks.data?.statuses.length && !groups.length) return <Blankslate title="No checks for this commit">Checks and statuses reported on {pr.head.sha.slice(0, 7)} show up here.</Blankslate>

  // Without an explicit selection, open the first failing (then running) check so problems surface first.
  const rank = (r: CheckRun) => (r.status !== 'completed' ? 1 : FAILED.includes(r.conclusion ?? '') ? 0 : 2)
  const ordered = groups.flatMap((g) => g.runs)
  const fallback = [...ordered].sort((a, b) => rank(a) - rank(b))[0]
  const selectedId = Number(params.get('run')) || fallback?.id
  const selected = ordered.find((r) => r.id === selectedId)

  return (
    <div>
      <div className="checks-toolbar">
        <ChecksDonut runs={runs} />
        <h2 className="checks-commit-title text-truncate">{commit.data ? firstLine(commit.data.message) : ''}</h2>
        <Link to={`/${owner}/${repo}/commit/${pr.head.sha}`} className="checks-commit-sha">
          {shortSha(pr.head.sha)}
        </Link>
      </div>
      <div className="layout-sidebar-left checks-layout">
        <div className="checks-sidebar">
          <NavList aria-label="Check suites">
            {groups.map((g) => {
              const annotations = g.runs.reduce((n, r) => n + (r.output?.annotations_count ?? 0), 0)
              return (
                <NavList.Group key={g.key}>
                  <NavList.GroupHeading>
                    <span className="checks-suite">
                      <span className="flex-1" style={{ minWidth: 0 }}>
                        <span className="checks-suite-name">{g.title}</span>
                        {g.event && <span className="checks-suite-event">on: {g.event}</span>}
                      </span>
                      {annotations > 0 && (
                        <span className="flex-center gap-1 fg-muted text-small" title={plural(annotations, 'annotation')}>
                          <ReportIcon size={16} /> {annotations}
                        </span>
                      )}
                    </span>
                  </NavList.GroupHeading>
                  {g.runs.map((r) => (
                    <NavList.Item key={r.id} aria-current={r.id === selectedId ? 'page' : undefined} onClick={() => setParams({ run: String(r.id) })}>
                      <NavList.LeadingVisual>
                        <CheckStatusIcon status={r.status} conclusion={r.conclusion} />
                      </NavList.LeadingVisual>
                      {r.name}
                    </NavList.Item>
                  ))}
                </NavList.Group>
              )
            })}
            {!!checks.data?.statuses.length && (
              <NavList.Group title="Commit statuses">
                {checks.data.statuses.map((s) => (
                  <NavList.Item key={s.id} onClick={() => s.target_url && openExternal(s.target_url)}>
                    <NavList.LeadingVisual>
                      <CheckStatusIcon status={s.state === 'pending' ? 'in_progress' : 'completed'} conclusion={s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure'} />
                    </NavList.LeadingVisual>
                    {s.context}
                    <NavList.TrailingVisual>
                      <LinkExternalIcon />
                    </NavList.TrailingVisual>
                  </NavList.Item>
                ))}
              </NavList.Group>
            )}
          </NavList>
        </div>
        <div style={{ minWidth: 0 }}>
          {selected ? (
            <CheckDetail run={selected} pr={pr} />
          ) : (
            <Blankslate
              title={!runs.length && groups.length && groups.every((g) => g.workflowStatus === 'completed') ? 'Workflow runs completed with no jobs' : 'Select a check to view from the sidebar'}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** The ring github.com shows next to the head commit: one arc per outcome, sized by how many checks had it. */
function ChecksDonut({ runs }: { runs: CheckRun[] }) {
  const parts = [
    { color: 'var(--fgColor-success)', n: runs.filter((r) => r.status === 'completed' && r.conclusion === 'success').length },
    { color: 'var(--fgColor-danger)', n: runs.filter((r) => r.status === 'completed' && FAILED.includes(r.conclusion ?? '')).length },
    { color: 'var(--fgColor-attention)', n: runs.filter((r) => r.status !== 'completed').length },
  ]
  const neutral = runs.length - parts.reduce((n, p) => n + p.n, 0)
  parts.push({ color: 'var(--fgColor-muted)', n: neutral })
  const r = 11
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <svg width={30} height={30} viewBox="0 0 30 30" aria-hidden className="shrink-0">
      <circle cx={15} cy={15} r={r} fill="none" stroke="var(--borderColor-muted)" strokeWidth={4} />
      {runs.length > 0 &&
        parts.map((p, i) => {
          if (!p.n) return null
          const len = (p.n / runs.length) * c
          const el = <circle key={i} cx={15} cy={15} r={r} fill="none" stroke={p.color} strokeWidth={4} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 15 15)" />
          offset += len
          return el
        })}
    </svg>
  )
}

const VERB: Record<string, string> = {
  success: 'succeeded',
  failure: 'failed',
  cancelled: 'was cancelled',
  timed_out: 'timed out',
  skipped: 'was skipped',
  neutral: 'completed',
  action_required: 'requires action',
  startup_failure: 'failed to start',
  stale: 'is stale',
}

/** "failed <time> in 5m 52s" / "started <time>", like the header of a check run on github.com. */
function RunStatusLine({ run }: { run: CheckRun }) {
  if (run.status !== 'completed') {
    if (!run.started_at || run.status === 'queued') return <>queued</>
    return (
      <>
        started <RelativeTime date={new Date(run.started_at)} />
      </>
    )
  }
  const verb = VERB[run.conclusion ?? ''] ?? run.conclusion ?? 'completed'
  if (run.conclusion === 'skipped' || !run.completed_at) return <>This check {verb}</>
  return (
    <>
      {verb} <RelativeTime date={new Date(run.completed_at)} />
      {run.started_at && <> in {durationBetween(run.started_at, run.completed_at)}</>}
    </>
  )
}

const LEVEL_WORD: Record<string, string> = { failure: 'error', warning: 'warning', notice: 'notice' }

/** "1 error and 1 notice" */
function annotationSummary(levels: string[]) {
  const parts = (['failure', 'warning', 'notice'] as const)
    .map((l) => ({ l, n: levels.filter((x) => x === l).length }))
    .filter((p) => p.n > 0)
    .map((p) => plural(p.n, LEVEL_WORD[p.l]))
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function CheckDetail({ run, pr }: { run: CheckRun; pr: PullRequest }) {
  const { owner, repo, fullName, data } = useRepo()
  const { octokit, key } = useGitHub()
  const agent = useAgent()
  const invalidate = useInvalidatePull(owner, repo, pr.number)
  const ids = actionsIds(run.details_url)
  const annotations = useQuery({
    queryKey: [key, 'annotations', owner, repo, run.id],
    enabled: (run.output?.annotations_count ?? 0) > 0,
    queryFn: async () => (await octokit.rest.checks.listAnnotations({ owner, repo, check_run_id: run.id, per_page: 100 })).data,
  })
  const rerun = useMutation({
    mutationFn: async () => {
      if (ids?.jobId) await octokit.rest.actions.reRunJobForWorkflowRun({ owner, repo, job_id: ids.jobId })
      else await octokit.rest.checks.rerequestRun({ owner, repo, check_run_id: run.id })
    },
    onSuccess: invalidate,
  })
  const failed = run.status === 'completed' && FAILED.includes(run.conclusion ?? '')
  return (
    <div className="Box">
      <div className="Box-header">
        <CheckStatusIcon status={run.status} conclusion={run.conclusion} size={20} />
        <div className="flex-1">
          <div className="text-bold" style={{ fontSize: 16 }}>
            {run.name}
          </div>
          <div className="text-small fg-muted">
            <RunStatusLine run={run} />
          </div>
        </div>
        {failed && (
          <Button
            size="small"
            leadingVisual={SparkleFillIcon}
            onClick={() =>
              agent.ask(
                `The check "${run.name}" (check run id ${run.id}${ids?.jobId ? `, Actions job ${ids.jobId} in run ${ids.runId}` : ''}) failed on ${owner}/${repo}#${pr.number} at ${pr.head.sha}. Read its logs, explain the root cause, and propose a fix. Don't commit until I confirm.`,
              )
            }
          >
            Explain failure
          </Button>
        )}
        {data.permissions?.push && run.status === 'completed' && (
          <Button size="small" leadingVisual={SyncIcon} loading={rerun.isPending} onClick={() => rerun.mutate()}>
            Re-run
          </Button>
        )}
        {ids ? (
          <Button as={Link} size="small" to={`/${owner}/${repo}/actions/runs/${ids.runId}${ids.jobId ? `/job/${ids.jobId}` : ''}`}>
            View logs
          </Button>
        ) : (
          run.details_url && (
            <Button size="small" trailingVisual={LinkExternalIcon} onClick={() => openExternal(run.details_url!)}>
              Details
            </Button>
          )
        )}
      </div>
      {rerun.error && <div className="Box-row fg-danger">{errorMessage(rerun.error)}</div>}
      {/* github.com shows a run's annotations above its output. */}
      {(annotations.data?.length ?? 0) > 0 && (
        <div className="checks-annotations">
          <div className="checks-annotations-header">
            <h3>Annotations</h3>
            <div className="text-small fg-muted">{annotationSummary(annotations.data!.map((a) => a.annotation_level ?? ''))}</div>
          </div>
          {annotations.data!.map((a, i) => (
            <div key={i} className="Box-row">
              <CheckStatusIcon status="completed" conclusion={a.annotation_level === 'failure' ? 'failure' : a.annotation_level === 'warning' ? 'action_required' : 'neutral'} />
              <div className="flex-1">
                <div className="text-bold">{a.title || run.name}</div>
                <div className="text-small" style={{ whiteSpace: 'pre-wrap' }}>
                  {a.message}
                </div>
                {/* Job-level annotations carry the path ".github" rather than a file; they get no file link. */}
                {a.path && a.path !== '.github' && (
                  <Link to={`/${owner}/${repo}/blob/${pr.head.sha}/${encodePath(a.path)}#L${a.start_line}`} className="text-small text-mono flex-center gap-1 mt-1">
                    <FileIcon size={12} /> {a.path}:{a.start_line}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="Box-body">
        {run.output?.title && <h3 style={{ marginTop: 0 }}>{run.output.title}</h3>}
        {run.output?.summary ? <Markdown text={run.output.summary} context={fullName} /> : <p className="fg-muted">No summary reported.</p>}
        {run.output?.text && (
          <div className="mt-3">
            <Markdown text={run.output.text} context={fullName} />
          </div>
        )}
      </div>
    </div>
  )
}
