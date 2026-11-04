import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { RelativeTime } from '@primer/react'
import { useGitHub } from '../../lib/github'
import { isNative } from '../../lib/platform'
import { useRepo } from '../../lib/repo'
import { useLocalRepo } from '../../lib/useLocalRepo'
import { githubKey, useWorkspaceRepos } from '../../lib/workspace'
import { ErrorBox, Loading } from '../../components/Bits'
import { CheckStatusIcon } from '../../components/Status'
import { SplitPane } from '../../components/SplitPane'
import { firstLine } from '../../lib/format'
import { ActionsPage } from '../repo/Actions'

type RunFilter = 'all' | 'failing' | 'branch'

/** The branch checked out in this repository's folder, if it has one here. */
export function useCheckedOutBranch(owner: string, repo: string) {
  const { account } = useGitHub()
  const { repos } = useWorkspaceRepos()
  const folder = repos.find((r) => r.key === githubKey({ host: account.host, owner, repo }))?.local ?? null
  const local = useLocalRepo(folder)
  return { folder, local, branch: local.status.data?.branch ?? null }
}

function RunList() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const { runId } = useParams()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { branch } = useCheckedOutBranch(owner, repo)
  const [filter, setFilter] = useState<RunFilter>('all')
  const base = `/${owner}/${repo}/actions`
  const runs = useQuery({
    queryKey: [key, 'workspace-runs', owner, repo, filter, filter === 'branch' ? branch : null],
    refetchInterval: (query) => (query.state.data?.some((r) => r.status !== 'completed') ? 15_000 : 60_000),
    queryFn: async () =>
      (
        await octokit.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          per_page: 50,
          ...(filter === 'failing' ? { status: 'failure' as const } : {}),
          ...(filter === 'branch' && branch ? { branch } : {}),
        })
      ).data.workflow_runs,
  })
  const first = runs.data?.[0]?.id
  // The list and detail layout always has something to show on arrival.
  useEffect(() => {
    if (first && pathname.replace(/\/$/, '') === base) navigate(`${base}/runs/${first}`, { replace: true })
  }, [first, pathname, base, navigate])

  const filters: Array<[RunFilter, string]> = branch
    ? [
        ['all', 'All'],
        ['failing', 'Failing'],
        ['branch', 'This branch'],
      ]
    : [
        ['all', 'All'],
        ['failing', 'Failing'],
      ]
  return (
    <div className="ws-list">
      <div className="ws-list-head ws-filters" role="group" aria-label="Filter runs">
        {filters.map(([id, label]) => (
          <button key={id} type="button" className="ws-filter" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="ws-scroll">
        {runs.isLoading ? (
          <Loading />
        ) : runs.error ? (
          <div className="p-3">
            <ErrorBox error={runs.error} />
          </div>
        ) : runs.data?.length ? (
          runs.data.map((r) => (
            <Link key={r.id} className={`ws-list-row ${String(r.id) === runId ? 'is-selected' : ''}`} to={`${base}/runs/${r.id}`} aria-current={String(r.id) === runId ? 'page' : undefined}>
              <CheckStatusIcon status={r.status} conclusion={r.conclusion} />
              <span className="ws-list-text">
                <span className="ws-list-title">{firstLine(r.display_title)}</span>
                <span className="ws-row-sub">
                  {r.name} · {r.head_branch} · <RelativeTime date={new Date(r.created_at)} />
                </span>
              </span>
            </Link>
          ))
        ) : (
          <p className="ws-note p-3">No runs match this filter.</p>
        )}
      </div>
      <div className="ws-list-foot">
        <Link to={`${base}/all`}>All workflows and filters</Link>
      </div>
    </div>
  )
}

/** Runs on the left and the chosen run on the right. The web build keeps its full pages. */
export function ActionsLayout() {
  const ctx = useRepo()
  if (!isNative) return <Outlet context={ctx} />
  return (
    <div className="ws-page">
      <SplitPane id="actions" firstLabel="Runs" secondLabel="Run" defaultWidth={320} min={200} max={600} first={<RunList />} second={<div className="ws-scroll"><Outlet context={ctx} /></div>} />
    </div>
  )
}

export function ActionsHome() {
  return isNative ? <div className="ws-empty">Choose a run to see its jobs and logs.</div> : <ActionsPage />
}
