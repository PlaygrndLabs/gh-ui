import { isNative } from '../../lib/platform'
import { useRepo } from '../../lib/repo'
import { useGitHub } from '../../lib/github'
import { githubKey, useWorkspaceRepos } from '../../lib/workspace'
import { Loading } from '../../components/Bits'
import { BranchesWorkspace } from '../workspace/BranchesWorkspace'
import { CodePage } from './Code'

/** A repository's front page: its branches in the desktop app, and its code on the web. */
export function RepoHome() {
  return isNative ? <WorkspaceHome /> : <CodePage />
}

function WorkspaceHome() {
  const { owner, repo } = useRepo()
  const { account } = useGitHub()
  const { repos, isLoading } = useWorkspaceRepos()
  if (isLoading) return <Loading />
  const key = githubKey({ host: account.host, owner, repo })
  const known = repos.find((r) => r.key === key)
  return <BranchesWorkspace key={key} repo={known ?? { key, name: repo, location: 'github', local: null, github: { host: account.host, owner, repo } }} />
}
