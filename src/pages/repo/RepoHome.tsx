import { isNative } from '../../lib/platform'
import { useRepo } from '../../lib/repo'
import { useGitHub } from '../../lib/github'
import { githubKey, useWorkspaceRepos } from '../../lib/workspace'
import { Loading } from '../../components/Bits'
import { LocalRepoView } from '../Local'
import { CodePage } from './Code'

/** A repository's front page: in the desktop app, the work in its folder if there is one; on the web, its code. */
export function RepoHome() {
  return isNative ? <WorkspaceHome /> : <CodePage />
}

function WorkspaceHome() {
  const { owner, repo } = useRepo()
  const { account } = useGitHub()
  const { repos, isLoading } = useWorkspaceRepos()
  if (isLoading) return <Loading />
  const key = githubKey({ host: account.host, owner, repo })
  const folder = repos.find((r) => r.key === key)?.local
  return folder ? <LocalRepoView key={folder.id} repo={folder} embedded /> : <CodePage />
}
