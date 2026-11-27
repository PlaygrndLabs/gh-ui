/** The header's pull request filters. */
export type PullFilter = 'open' | 'review' | 'mine' | 'assigned' | 'closed' | 'all'

const QUALIFIER: Record<PullFilter, string> = {
  open: 'is:open',
  review: 'is:open review-requested:@me',
  mine: 'is:open author:@me',
  assigned: 'is:open assignee:@me',
  closed: 'is:closed',
  all: '',
}

/**
 * The search a filter makes, with what was typed beside it: words, or GitHub's own qualifiers
 * (author:octocat label:bug). A state or sort typed there replaces the filter's own.
 */
export function pullSearch(owner: string, repo: string, filter: PullFilter, term = '') {
  const typedState = /\b(is|state):(open|closed|merged|unmerged)\b/i.test(term)
  const qualifier = typedState ? QUALIFIER[filter].replace(/\bis:(open|closed)\b/, '') : QUALIFIER[filter]
  const sort = /\bsort:[\w-]+/i.test(term) ? '' : 'sort:updated-desc'
  return [`repo:${owner}/${repo}`, 'is:pr', qualifier, term, sort].join(' ').replace(/\s+/g, ' ').trim()
}
