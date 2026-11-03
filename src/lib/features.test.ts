import { describe, expect, it } from 'vitest'
import { FEATURES } from './features'

describe('FEATURES', () => {
  it('keeps the daily work on and the rest off by default', () => {
    const on = Object.entries(FEATURES).filter(([, f]) => f.default).map(([k]) => k)
    expect(on).toEqual(['issues', 'homeActions', 'updateNotice'])
  })
  it('labels and groups every feature', () => {
    for (const f of Object.values(FEATURES)) expect(f.label && f.description && f.group).toBeTruthy()
  })
})
