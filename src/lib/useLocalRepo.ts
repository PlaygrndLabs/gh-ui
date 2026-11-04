import { useMemo, useState } from 'react'
import { useConfirm } from '@primer/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorMessage, useGitHub } from './github'
import { localGit } from './git'
import type { LocalRepo } from './platform'

/** Live state of a folder and the means to change it, shared by the toolbar and the page under it. */
export function useLocalRepo(repo: LocalRepo | null) {
  const { account } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
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
    for (const key of ['local-status', 'local-branch-states', 'local-branches', 'local-diff', 'local-log', 'local-show', 'local-stash']) void qc.invalidateQueries({ queryKey: [key, id] })
  }
  const op = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (e) => setError(errorMessage(e)),
  })

  /** Git refuses a switch that would overwrite uncommitted changes, so that one offers to stash them first. */
  const switchBranch = (name: string) =>
    op.mutate(async () => {
      try {
        await git!.switchTo(name)
      } catch (e) {
        if (!/overwritten|commit your changes|stash them/i.test(errorMessage(e))) throw e
        const ok = await confirm({
          title: `Stash your changes and switch to ${name}?`,
          content: 'Your uncommitted changes conflict with that branch. They’ll be saved as a stash, and you can restore them from Uncommitted.',
          confirmButtonContent: 'Stash and switch',
        })
        if (!ok) return
        await git!.stash()
        await git!.switchTo(name)
      }
    })

  return { git, status, branches, op, switchBranch, refresh, error, clearError: () => setError(null) }
}
