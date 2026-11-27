import { describe, expect, it } from 'vitest'
import { pullSearch } from './pullSearch'

describe('pullSearch', () => {
  it('asks for a repository\'s pull requests, newest activity first', () => {
    expect(pullSearch('octo', 'app', 'all')).toBe('repo:octo/app is:pr sort:updated-desc')
    expect(pullSearch('octo', 'app', 'open')).toBe('repo:octo/app is:pr is:open sort:updated-desc')
    expect(pullSearch('octo', 'app', 'closed')).toBe('repo:octo/app is:pr is:closed sort:updated-desc')
  })

  it('narrows to the viewer for the personal filters', () => {
    expect(pullSearch('octo', 'app', 'review')).toBe('repo:octo/app is:pr is:open review-requested:@me sort:updated-desc')
    expect(pullSearch('octo', 'app', 'mine')).toBe('repo:octo/app is:pr is:open author:@me sort:updated-desc')
    expect(pullSearch('octo', 'app', 'assigned')).toBe('repo:octo/app is:pr is:open assignee:@me sort:updated-desc')
  })

  it('adds what was typed, words and qualifiers alike', () => {
    expect(pullSearch('octo', 'app', 'open', 'date picker')).toBe('repo:octo/app is:pr is:open date picker sort:updated-desc')
    expect(pullSearch('octo', 'app', 'open', 'author:hubot label:bug')).toBe('repo:octo/app is:pr is:open author:hubot label:bug sort:updated-desc')
  })

  it('lets a typed state replace the filter\'s own, keeping the rest of the filter', () => {
    expect(pullSearch('octo', 'app', 'open', 'is:merged picker')).toBe('repo:octo/app is:pr is:merged picker sort:updated-desc')
    expect(pullSearch('octo', 'app', 'mine', 'state:closed')).toBe('repo:octo/app is:pr author:@me state:closed sort:updated-desc')
    // A draft is still open: is:draft is no state.
    expect(pullSearch('octo', 'app', 'open', 'is:draft')).toBe('repo:octo/app is:pr is:open is:draft sort:updated-desc')
  })

  it('keeps a typed sort', () => {
    expect(pullSearch('octo', 'app', 'open', 'sort:created-asc')).toBe('repo:octo/app is:pr is:open sort:created-asc')
  })
})
