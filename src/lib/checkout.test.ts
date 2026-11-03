import { describe, expect, it } from 'vitest'
import { checkoutPlan } from './checkout'
import { actionsQueue, type QueueRun } from './actionsQueue'

describe('checkoutPlan', () => {
  it('uses the branch itself for a pull request in this repository', () => {
    expect(checkoutPlan({ number: 7, headRef: 'fix/x', fromFork: false }, 'main')).toEqual({
      branch: 'fix/x',
      steps: [['fetch', 'origin', 'fix/x'], ['switch', 'fix/x'], ['pull', '--ff-only', 'origin', 'fix/x']],
    })
  })
  it('brings a fork down as pr-<number>', () => {
    expect(checkoutPlan({ number: 7, headRef: 'patch-1', fromFork: true }, 'main')).toEqual({
      branch: 'pr-7',
      steps: [['fetch', 'origin', 'pull/7/head:pr-7'], ['switch', 'pr-7']],
    })
  })
  it('only fast-forwards when that fork branch is already checked out', () => {
    expect(checkoutPlan({ number: 7, headRef: 'patch-1', fromFork: true }, 'pr-7').steps).toEqual([['pull', '--ff-only', 'origin', 'pull/7/head']])
  })
})

describe('actionsQueue', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  const run = (id: number, status: string, conclusion: string | null, hoursAgo: number, workflow_id = 1, head_branch = 'main'): QueueRun => ({
    id, status, conclusion, workflow_id, head_branch, updated_at: new Date(now - hoursAgo * 3_600_000).toISOString(), repository: { full_name: 'a/b' },
  })
  it('shows running work first, then failures', () => {
    expect(actionsQueue([run(1, 'completed', 'failure', 1, 1), run(2, 'in_progress', null, 2, 2)], now).map((r) => r.id)).toEqual([2, 1])
  })
  it('drops a failure that a later run on that branch replaced', () => {
    expect(actionsQueue([run(1, 'completed', 'failure', 5), run(2, 'completed', 'success', 1)], now)).toEqual([])
    expect(actionsQueue([run(1, 'completed', 'failure', 5, 1, 'other'), run(2, 'completed', 'success', 1)], now).map((r) => r.id)).toEqual([1])
  })
  it('leaves out passing runs, cancelled runs and old failures', () => {
    expect(actionsQueue([run(1, 'completed', 'success', 1), run(2, 'completed', 'cancelled', 1, 2), run(3, 'completed', 'failure', 24 * 8, 3)], now)).toEqual([])
  })
})
