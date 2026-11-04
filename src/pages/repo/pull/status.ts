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
