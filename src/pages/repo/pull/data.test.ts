import { describe, expect, it } from 'vitest'
import { reviewStanding, rerunTargets } from './status'

describe('rerunTargets', () => {
  const run = (id: number, status: string, conclusion: string | null, details_url?: string) => ({ id, status, conclusion, details_url })
  it('asks once per failed Actions run, and separately for other failed checks', () => {
    const url = 'https://github.com/a/b/actions/runs/55/job/1'
    expect(
      rerunTargets([run(1, 'completed', 'failure', url), run(2, 'completed', 'failure', url.replace('/1', '/2')), run(3, 'completed', 'failure', 'https://ci.example/9'), run(4, 'completed', 'success', url), run(5, 'in_progress', null, url)]),
    ).toEqual({ actionRuns: [55], checkRuns: [3] })
  })
})

describe('reviewStanding', () => {
  it('counts each reviewer once, by their latest say', () => {
    const r = (login: string, state: string) => ({ user: { login }, state })
    expect(reviewStanding([r('a', 'CHANGES_REQUESTED'), r('a', 'COMMENTED'), r('b', 'APPROVED'), r('b', 'CHANGES_REQUESTED'), r('c', 'APPROVED')])).toEqual({ approvals: 1, changesRequested: 2 })
    expect(reviewStanding([r('a', 'APPROVED'), r('a', 'DISMISSED')])).toEqual({ approvals: 0, changesRequested: 0 })
    expect(reviewStanding(undefined)).toEqual({ approvals: 0, changesRequested: 0 })
  })
})
