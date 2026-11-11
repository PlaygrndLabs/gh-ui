import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useConfirm } from '@primer/react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { errorMessage, useGitHub } from './github'
import { localGit, type BranchState, type RepoState, type StatusEntry } from './git'
import type { LocalRepo } from './platform'
import { createRepoOps, type RepoOps, type StageIntents } from './repoOps'

const opsByRepo = new Map<string, RepoOps>()

/** One per folder however many components ask, because the queue only protects a folder if everything shares it. */
function repoOpsFor(id: string, qc: QueryClient) {
  let ops = opsByRepo.get(id)
  if (!ops) {
    // Staging needs no sign-in, so this client lasts across account switches.
    const git = localGit(id)
    ops = createRepoOps({
      stage: git.stage,
      unstage: git.unstage,
      reconcile: async () => {
        await qc.invalidateQueries({ queryKey: ['local-status', id], exact: true })
        // React Query tells the page on the next task. Waiting for that keeps the box from showing the old answer for a frame.
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    })
    opsByRepo.set(id, ops)
  }
  return ops
}

/** The branch each folder is being switched to, so the menu can say so before git has answered. */
const switching = new Map<string, string>()
const switchListeners = new Set<() => void>()
function setSwitching(id: string, name: string | null) {
  if (name) switching.set(id, name)
  else switching.delete(id)
  switchListeners.forEach((listener) => listener())
}
const subscribeSwitching = (listener: () => void) => {
  switchListeners.add(listener)
  return () => void switchListeners.delete(listener)
}

/** The branch a switch in this folder is heading to, while it's under way. */
export function useSwitchingTo(id: string | undefined) {
  return useSyncExternalStore(subscribeSwitching, () => (id ? (switching.get(id) ?? null) : null))
}

const NO_INTENTS: StageIntents = new Map()
const noSubscribe = () => () => {}

/** The boxes clicked and not yet confirmed by git. Only the list subscribes, so a click redraws nothing else. */
export function useStageIntents(ops: RepoOps | null) {
  return useSyncExternalStore(ops?.subscribe ?? noSubscribe, ops?.intents ?? (() => NO_INTENTS))
}

export function useStageError(ops: RepoOps | null) {
  return useSyncExternalStore(ops?.subscribe ?? noSubscribe, ops?.error ?? (() => null))
}

/** Live state of a folder and the means to change it, shared by the toolbar and the page under it. */
export function useLocalRepo(repo: LocalRepo | null) {
  const { account } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const id = repo?.id ?? ''
  const git = useMemo(() => (id ? localGit(id, { token: account.token, host: account.host }) : null), [id, account.token, account.host])
  const ops = useMemo(() => (id ? repoOpsFor(id, qc) : null), [id, qc])

  const status = useQuery({
    queryKey: ['local-status', id],
    enabled: !!git,
    queryFn: () => git!.status(),
    // Coming back from an editor should show what just changed, not wait for the next check.
    staleTime: 0,
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  })
  const branches = useQuery({
    queryKey: ['local-branch-states', id],
    enabled: !!git,
    queryFn: () => git!.branches(),
    refetchInterval: 15_000,
  })

  const operation = useQuery({
    queryKey: ['local-operation', id],
    enabled: !!git,
    queryFn: () => git!.operation(),
    refetchInterval: 4000,
  })

  const refresh = () => {
    for (const key of ['local-operation', 'local-status', 'local-branch-states', 'local-worktrees', 'local-branches', 'local-diff', 'local-log', 'local-show', 'local-stash']) void qc.invalidateQueries({ queryKey: [key, id] })
  }
  const settled = {
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (e: unknown) => setError(errorMessage(e)),
  }
  /** For anything that changes the index, the working tree or HEAD: waits its turn behind what's already running. */
  const op = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => ops!.run(fn), ...settled })
  /** For what only talks to the remote, or queues its own steps: a slow push shouldn't hold up staging. */
  const unqueued = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), ...settled })

  const setStaged = useCallback((entries: StatusEntry[], staged: boolean) => ops?.setStaged(entries, staged), [ops])

  /**
   * Puts the branch git just switched to on screen straight away. The checks that confirm it can take a while in a
   * folder other programs are busy in, and the menu and the page would otherwise catch up at different times.
   */
  const showSwitched = async (name: string) => {
    await Promise.all([qc.cancelQueries({ queryKey: ['local-status', id] }), qc.cancelQueries({ queryKey: ['local-branch-states', id] })])
    const known = qc.getQueryData<BranchState[]>(['local-branch-states', id])?.find((b) => b.name === name)
    qc.setQueryData<RepoState>(['local-status', id], (s) => s && { ...s, branch: name, upstream: known?.upstream ?? null, ahead: known?.ahead ?? 0, behind: known?.behind ?? 0 })
    qc.setQueryData<BranchState[]>(['local-branch-states', id], (list) => list?.map((b) => (b.current === (b.name === name) ? b : { ...b, current: b.name === name })))
  }

  /** Git refuses a switch that would overwrite uncommitted changes, so that one offers to stash them first. */
  const switchBranch = (name: string) =>
    unqueued.mutate(async () => {
      setSwitching(id, name)
      try {
        try {
          await ops!.run(() => git!.switchTo(name))
        } catch (e) {
          if (!/overwritten|commit your changes|stash them/i.test(errorMessage(e))) throw e
          // While the question is open, nothing has changed yet.
          setSwitching(id, null)
          // Asked outside the queue: an open dialog mustn't stop everything else in this folder.
          const ok = await confirm({
            title: `Stash your changes and switch to ${name}?`,
            content: 'Your uncommitted changes conflict with that branch. They’ll be saved as a stash, and you can restore them from Uncommitted.',
            confirmButtonContent: 'Stash and switch',
          })
          if (!ok) return
          setSwitching(id, name)
          await ops!.run(async () => {
            await git!.stash()
            await git!.switchTo(name)
          })
        }
        await showSwitched(name)
      } finally {
        setSwitching(id, null)
      }
    })

  return { git, ops, status, branches, operation, op, unqueued, setStaged, switchBranch, refresh, error, clearError: () => setError(null) }
}
