import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorMessage, useGitHub } from './github'
import { localGit } from './git'
import type { LocalRepo } from './platform'

/** Live state of a folder and the means to change it, shared by the toolbar and the page under it. */
export function useLocalRepo(repo: LocalRepo | null) {
  const { account } = useGitHub()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const id = repo?.id ?? ''
  const git = useMemo(() => (id ? localGit(id, { token: account.token, host: account.host }) : null), [id, account.token, account.host])

  const status = useQuery({
    queryKey: ['local-status', id],
    enabled: !!git,
    queryFn: () => git!.status(),
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  })
  const branches = useQuery({
    queryKey: ['local-branch-states', id],
    enabled: !!git,
    queryFn: () => git!.branches(),
    refetchInterval: 15_000,
  })

  const refresh = () => {
    for (const key of ['local-status', 'local-branch-states', 'local-branches', 'local-diff', 'local-log', 'local-show']) void qc.invalidateQueries({ queryKey: [key, id] })
  }
  const op = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return { git, status, branches, op, refresh, error, clearError: () => setError(null) }
}
