// Home's Actions list: what needs a look across recently active repositories.

export interface QueueRun {
  id: number
  name?: string | null
  display_title?: string
  status: string | null
  conclusion: string | null
  head_branch: string | null
  workflow_id: number
  updated_at: string
  repository: { full_name: string }
}

const FAILED = ['failure', 'timed_out', 'startup_failure']
const DAY = 24 * 60 * 60 * 1000

/**
 * Running work, and failures that are still the latest word for their workflow on that branch: a failure followed by a
 * green run has been dealt with. Running first, then newest; failures older than `maxAgeDays` have stopped mattering.
 */
export function actionsQueue<T extends QueueRun>(runs: T[], now: number, maxAgeDays = 7): T[] {
  const newest = [...runs].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  const seen = new Set<string>()
  const out: T[] = []
  for (const run of newest) {
    const key = `${run.repository.full_name}\n${run.workflow_id}\n${run.head_branch}`
    if (seen.has(key)) continue
    seen.add(key)
    const running = run.status !== 'completed'
    const failed = FAILED.includes(run.conclusion ?? '') && now - Date.parse(run.updated_at) < maxAgeDays * DAY
    if (running || failed) out.push(run)
  }
  return out.sort((a, b) => Number(b.status !== 'completed') - Number(a.status !== 'completed'))
}
