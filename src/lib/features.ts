import { useCallback } from 'react'
import { useSharedPref } from './storage'

// The app covers most of GitHub, but day to day it's for repositories, pull requests and Actions. Everything else stays
// available and starts switched off; Settings → Features turns each part on.

export const FEATURES = {
  issues: { label: 'Issues', description: 'The Issues tab in repositories.', group: 'Repository tabs', default: true },
  discussions: { label: 'Discussions', description: 'The Discussions tab, in repositories that use them.', group: 'Repository tabs', default: false },
  projects: { label: 'Projects', description: 'Boards and tables linked to a repository.', group: 'Repository tabs', default: false },
  wiki: { label: 'Wiki', description: 'Wiki pages, in repositories that have them.', group: 'Repository tabs', default: false },
  security: { label: 'Security and quality', description: 'Dependabot, code scanning and secret scanning alerts, and advisories.', group: 'Repository tabs', default: false },
  insights: { label: 'Insights', description: 'Pulse, commit activity and contributors.', group: 'Repository tabs', default: false },
  repoSettings: { label: 'Repository settings', description: 'Settings for repositories you administer, including the Danger Zone.', group: 'Repository tabs', default: false },
  activityFeed: { label: 'Recent activity', description: 'The activity feed on Home.', group: 'Home', default: false },
  assignedIssues: { label: 'Assigned issues', description: 'Issues assigned to you, on Home.', group: 'Home', default: false },
  headerShortcuts: { label: 'Issues and pull requests buttons', description: 'Your issues and Your pull requests buttons in the header.', group: 'Header', default: false },
  sidebarDetails: { label: 'Empty sidebar sections', description: 'Show Projects and Development on pull requests and issues even when they have nothing in them.', group: 'Pull requests', default: false },
} as const

export type Feature = keyof typeof FEATURES

const PREF = 'features'

/** What's been switched by hand; anything else follows its default, so a new feature doesn't need a migration. */
export function useFeatures() {
  const [chosen, setChosen] = useSharedPref<Partial<Record<Feature, boolean>>>(PREF, {})
  const isOn = useCallback((feature: Feature) => chosen[feature] ?? FEATURES[feature].default, [chosen])
  const setFeature = useCallback((feature: Feature, on: boolean) => setChosen((c) => ({ ...c, [feature]: on })), [setChosen])
  return { isOn, setFeature }
}

export function useFeature(feature: Feature) {
  return useFeatures().isOn(feature)
}
