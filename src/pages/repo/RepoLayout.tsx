import { Outlet } from 'react-router-dom'
import { useRepoParams, useRepoQuery, type RepoContext } from '../../lib/repo'
import { ErrorBox, Loading } from '../../components/Bits'

export function RepoLayout() {
  const { owner, repo } = useRepoParams()
  const q = useRepoQuery(owner, repo)
  if (q.isLoading) return <Loading label="Loading repository" />
  if (q.error || !q.data)
    return (
      <div className="container-lg">
        <ErrorBox error={q.error} title={`Could not open ${owner}/${repo}`} />
      </div>
    )
  // Canonical casing comes from the API (URLs are case-insensitive).
  const ctx: RepoContext = { owner: q.data.owner.login, repo: q.data.name, data: q.data, fullName: q.data.full_name }
  return <Outlet context={ctx} />
}
