import { useEffect } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@primer/react'
import { useGitHub } from '../../lib/github'
import { isNative } from '../../lib/platform'
import { useRepo } from '../../lib/repo'
import { useLocalRepo } from '../../lib/useLocalRepo'
import { githubKey, useWorkspaceRepos } from '../../lib/workspace'
import { ErrorBox, Loading } from '../../components/Bits'
import { ActionsPage } from '../repo/Actions'

export type RunFilter = 'all' | 'failing' | 'branch'

/** The branch checked out in this repository's folder, if it has one here. */
export function useCheckedOutBranch(owner: string, repo: string) {
  const { account } = useGitHub()
  const { repos } = useWorkspaceRepos()
  const folder = repos.find((r) => r.key === githubKey({ host: account.host, owner, repo }))?.local ?? null
  const local = useLocalRepo(folder)
  return { folder, local, branch: local.status.data?.branch ?? null }
}

/** A repository's latest workflow runs, checked again sooner while any are under way. */
export function useRunList(owner: string, repo: string, filter: RunFilter) {
  const { octokit, key } = useGitHub()
  const { branch } = useCheckedOutBranch(owner, repo)
  return useQuery({
    queryKey: [key, 'workspace-runs', owner, repo, filter, filter === 'branch' ? branch : null],
    enabled: !!owner && !!repo && (filter !== 'branch' || !!branch),
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
}

/** The run picked in the header, using the window's full width. The web build keeps its full pages. */
export function ActionsLayout() {
  const ctx = useRepo()
  const { owner, repo } = ctx
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const runs = useRunList(owner, repo, 'all')
  const first = runs.data?.[0]?.id
  const base = `/${owner}/${repo}/actions`
  // Actions always has something to show on arrival.
  useEffect(() => {
    if (isNative && first && pathname.replace(/\/$/, '') === base) navigate(`${base}/runs/${first}`, { replace: true })
  }, [first, pathname, base, navigate])
  if (!isNative) return <Outlet context={ctx} />
  return (
    <div className="ws-page">
      <div className="ws-scroll">
        <Outlet context={ctx} />
      </div>
    </div>
  )
}

export function ActionsHome() {
  const { owner, repo } = useRepo()
  const runs = useRunList(owner, repo, 'all')
  if (!isNative) return <ActionsPage />
  return (
    <div className="ws-empty">
      {runs.isLoading ? (
        <Loading />
      ) : runs.error ? (
        <ErrorBox error={runs.error} />
      ) : (
        <div className="ws-empty-body">
          <p>{runs.data?.length ? 'Choose a run from the menu at the top.' : 'No workflow runs yet.'}</p>
          <div className="ws-empty-actions">
            <Button as={Link} to={`/${owner}/${repo}/actions/all`}>
              All workflows and filters
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
