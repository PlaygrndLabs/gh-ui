/** "…/actions/runs/123/job/456" → run and job ids, for check runs created by GitHub Actions. */
export function actionsIds(detailsUrl: string | null | undefined): { runId: number; jobId: number | null } | null {
  const m = detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/)
  return m ? { runId: Number(m[1]), jobId: m[2] ? Number(m[2]) : null } : null
}

/** What "Re-run failed" asks for: each failed Actions run once, and any other failed check run by itself. */
export function rerunTargets(runs: Array<{ id: number; status: string; conclusion: string | null; details_url?: string | null }>) {
  const actionRuns = new Set<number>()
  const checkRuns: number[] = []
  for (const r of runs) {
    if (r.status !== 'completed' || !['failure', 'timed_out', 'startup_failure', 'cancelled'].includes(r.conclusion ?? '')) continue
    const ids = actionsIds(r.details_url)
    if (ids) actionRuns.add(ids.runId)
    else checkRuns.push(r.id)
  }
  return { actionRuns: [...actionRuns], checkRuns }
}

/** Where a pull request stands on reviews: each reviewer's latest say counts, and comments don't change it. */
export function reviewStanding(reviews: Array<{ user?: { login: string } | null; state: string }> | undefined) {
  const latest = new Map<string, string>()
  for (const r of reviews ?? []) {
    const login = r.user?.login
    if (!login) continue
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(login, r.state)
    else if (r.state === 'DISMISSED') latest.delete(login)
  }
  const states = [...latest.values()]
  return { approvals: states.filter((s) => s === 'APPROVED').length, changesRequested: states.filter((s) => s === 'CHANGES_REQUESTED').length }
}

export type ReadinessTone = 'success' | 'attention' | 'danger' | 'neutral' | 'done'
export type BlockerKind = 'draft' | 'conflicts' | 'checks' | 'changes' | 'behind' | 'review' | 'blocked'

export interface Readiness {
  tone: ReadinessTone
  title: string
  /** What stands in the way, worst first. `warn` ones don't stop a merge (a failing check that isn't required). */
  blockers: Array<{ kind: BlockerKind; text: string; warn?: boolean }>
  /** GitHub says this can merge now: the Merge button is the primary action. */
  ready: boolean
  /** Merging can be tried at all: no conflicts and not a draft. */
  mergeable: boolean
}

interface ReadinessInput {
  merged: boolean
  state: string
  draft?: boolean
  mergeable: boolean | null
  mergeableState?: string
  checks: { failed: number; pending: number; total: number }
  reviews: { approvals: number; changesRequested: number }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The merge-readiness summary at the top of a pull request, as github.com's new overview page puts it: one line that
 * answers "can this merge?", and the blockers that answer "why not?".
 */
export function readiness(pr: ReadinessInput): Readiness {
  if (pr.merged) return { tone: 'done', title: 'Merged', blockers: [], ready: false, mergeable: false }
  if (pr.state === 'closed') return { tone: 'neutral', title: 'Closed with unmerged commits', blockers: [], ready: false, mergeable: false }
  const ms = pr.mergeableState ?? 'unknown'
  const blockers: Readiness['blockers'] = []
  if (pr.draft) blockers.push({ kind: 'draft', text: 'Draft pull requests can’t be merged' })
  const conflicts = ms === 'dirty' || pr.mergeable === false
  if (conflicts) blockers.push({ kind: 'conflicts', text: 'This branch has conflicts with the base branch' })
  // "unstable": checks failed, but none that branch protection requires.
  if (pr.checks.failed) blockers.push({ kind: 'checks', text: `${plural(pr.checks.failed, 'failing check')}`, ...(ms === 'unstable' || ms === 'clean' ? { warn: true } : {}) })
  if (pr.reviews.changesRequested) blockers.push({ kind: 'changes', text: 'Changes requested' })
  if (ms === 'behind') blockers.push({ kind: 'behind', text: 'This branch is out of date with the base branch' })
  if (ms === 'blocked' && !blockers.some((b) => !b.warn && b.kind !== 'draft')) {
    blockers.push(pr.reviews.approvals ? { kind: 'blocked', text: 'Branch protection requirements aren’t met yet' } : { kind: 'review', text: 'An approving review is required' })
  }
  const ready = !pr.draft && ['clean', 'unstable', 'has_hooks'].includes(ms)
  const base = { blockers, ready, mergeable: !pr.draft && !conflicts }
  if (pr.draft) return { ...base, tone: 'neutral', title: 'Draft' }
  const hard = blockers.filter((b) => !b.warn)
  if (hard.length === 1 && hard[0].kind === 'behind') return { ...base, tone: 'attention', title: 'Update branch to merge' }
  if (hard.length) return { ...base, tone: 'danger', title: 'Merging is blocked' }
  if (pr.checks.pending) return { ...base, tone: 'attention', title: 'Checks are running' }
  if (pr.mergeable === null || ms === 'unknown') return { ...base, tone: 'attention', title: 'Checking whether this can merge…' }
  return { ...base, tone: 'success', title: 'Ready to merge' }
}
