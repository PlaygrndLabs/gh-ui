import { useQuery } from '@tanstack/react-query'
import { useGitHub, type PullRequest } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { CommitTimeline } from '../Commits'

export function PullCommits({ pr }: { pr: PullRequest }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const commits = useQuery({
    queryKey: [key, 'pull-commits', owner, repo, pr.number],
    queryFn: async () => octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: pr.number, per_page: 100 }),
  })
  if (commits.isLoading) return <Loading />
  if (commits.error) return <ErrorBox error={commits.error} />
  if (!commits.data?.length) return <Blankslate title="There are no commits on this pull request" />
  // Like github.com: one timeline entry per day, shared with the commit history and compare pages.
  return (
    <>
      <h2 className="sr-only">Commits</h2>
      <CommitTimeline owner={owner} repo={repo} commits={commits.data} />
    </>
  )
}
