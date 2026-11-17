import { describe, expect, it } from 'vitest'
import { reviewStanding, rerunTargets, readiness } from './status'

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

describe('readiness', () => {
  const open = { merged: false, state: 'open', mergeable: true, mergeableState: 'clean', checks: { failed: 0, pending: 0, total: 3 }, reviews: { approvals: 1, changesRequested: 0 } }
  it('is ready when GitHub says clean', () => expect(readiness(open)).toMatchObject({ tone: 'success', title: 'Ready to merge', ready: true, blockers: [] }))
  it('says merged and closed first', () => {
    expect(readiness({ ...open, merged: true, state: 'closed' }).title).toBe('Merged')
    expect(readiness({ ...open, state: 'closed' }).tone).toBe('neutral')
  })
  it('blocks a draft without offering merge', () => expect(readiness({ ...open, draft: true })).toMatchObject({ title: 'Draft', ready: false, mergeable: false }))
  it('lists conflicts and failing required checks as blockers', () => {
    const r = readiness({ ...open, mergeable: false, mergeableState: 'dirty', checks: { failed: 2, pending: 0, total: 3 } })
    expect(r).toMatchObject({ tone: 'danger', title: 'Merging is blocked', mergeable: false })
    expect(r.blockers.map((b) => b.kind)).toEqual(['conflicts', 'checks'])
  })
  it('only warns about checks branch protection doesn’t require', () => {
    const r = readiness({ ...open, mergeableState: 'unstable', checks: { failed: 1, pending: 0, total: 3 } })
    expect(r).toMatchObject({ tone: 'success', ready: true })
    expect(r.blockers).toEqual([{ kind: 'checks', text: '1 failing check', warn: true }])
  })
  it('asks for a review when protection blocks with no other reason', () => {
    expect(readiness({ ...open, mergeableState: 'blocked', reviews: { approvals: 0, changesRequested: 0 } }).blockers).toEqual([{ kind: 'review', text: 'An approving review is required' }])
  })
  it('points at Update branch when that is all that is missing', () => expect(readiness({ ...open, mergeableState: 'behind' })).toMatchObject({ tone: 'attention', title: 'Update branch to merge' }))
  it('waits on running checks', () => expect(readiness({ ...open, mergeableState: 'unstable', checks: { failed: 0, pending: 2, total: 3 } }).title).toBe('Checks are running'))
})
