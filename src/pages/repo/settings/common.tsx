import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Banner, Spinner } from '@primer/react'
import { CheckIcon } from '@primer/octicons-react'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import { useGitHub, errorMessage, type Repo } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { isUpgradeMessage, stripGraphqlPreamble } from '../../../lib/repoSettings'

export type RepoPatch = Omit<RestEndpointMethodTypes['repos']['update']['parameters'], 'owner' | 'repo'>

/**
 * PATCH /repos/{owner}/{repo}, then writes the response into every cached copy of the repository (the URL's casing
 * may differ from the canonical name), so RepoLayout, the tabs and the settings pages re-render with the saved values.
 */
export function useRepoUpdate() {
  const { owner, repo } = useRepo()
  const { octokit } = useGitHub()
  const patchCache = usePatchRepoCache()
  return useCallback(
    async (patch: RepoPatch) => {
      const res = await octokit.rest.repos.update({ owner, repo, ...patch })
      patchCache(res.data)
      return res.data
    },
    [octokit, patchCache, owner, repo],
  )
}

/** Merges fields into every cached copy of this repository. */
export function usePatchRepoCache() {
  const { data } = useRepo()
  const { key } = useGitHub()
  const qc = useQueryClient()
  return useCallback(
    (fields: Partial<Repo>) => qc.setQueriesData<Repo>({ queryKey: [key, 'repo'], predicate: (q) => (q.state.data as Repo | undefined)?.id === data.id }, (prev) => (prev ? { ...prev, ...fields } : prev)),
    [qc, key, data.id],
  )
}

/** Every page of a 100-per-page list. */
export async function allPages<T>(page: (params: { per_page: number; page: number }) => Promise<{ data: T[] }>) {
  const all: T[] = []
  for (let n = 1; ; n++) {
    const { data } = await page({ per_page: 100, page: n })
    all.push(...data)
    if (data.length < 100) return all
  }
}

export type SaveState = 'idle' | 'saving' | 'saved'

/** Runs a save and reports github.com's autosave states: a spinner while saving, a check for a moment after. */
export function useSaveState() {
  const [state, setState] = useState<SaveState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    clearTimeout(timer.current)
    setState('saving')
    try {
      const out = await fn()
      setState('saved')
      timer.current = setTimeout(() => setState('idle'), 2000)
      return out
    } catch (e) {
      setState('idle')
      throw e
    }
  }, [])
  return [state, run] as const
}

export function SaveStatus({ state }: { state: SaveState }) {
  if (state === 'saving') return <Spinner size="small" srText="Saving" className="settings-save-status" />
  if (state === 'saved')
    return (
      <span className="settings-save-status fg-success" role="status">
        <CheckIcon aria-label="Saved" />
      </span>
    )
  return null
}

/** github.com's Subhead: a 24px heading over a rule, optionally with actions and a description. */
export function SettingsSubhead({ title, actions, description, spacious, danger, id }: { title: ReactNode; actions?: ReactNode; description?: ReactNode; spacious?: boolean; danger?: boolean; id?: string }) {
  return (
    <div className={`subhead settings-subhead${spacious ? ' spacious' : ''}${danger ? ' danger' : ''}`}>
      <h2 id={id}>{title}</h2>
      {actions}
      {description && <p className="settings-subhead-description">{description}</p>}
    </div>
  )
}

/** github.com's sub-page heading: "Webhooks / Add webhook", the first part linking back to the section. */
export function SettingsCrumb({ to, parent, current }: { to: string; parent: string; current: string }) {
  return (
    <>
      <Link to={to} className="settings-crumb-link">
        {parent}
      </Link>
      {' / '}
      {current}
    </>
  )
}

/** Navigates to a settings page with github.com's flash message ("Okay, that hook was successfully created.") on top. */
export function useNavigateWithFlash() {
  const navigate = useNavigate()
  return useCallback((to: string, flash: string) => navigate(to, { state: { flash } }), [navigate])
}

/** The flash a settings form left for this page; dismissing it clears it from the history entry. */
export function SettingsFlash() {
  const location = useLocation()
  const navigate = useNavigate()
  const flash = (location.state as { flash?: string } | null)?.flash
  if (!flash) return null
  return (
    <Banner
      className="mb-3"
      variant="success"
      hideTitle
      title="Success"
      description={flash}
      onDismiss={() => navigate(location.pathname + location.search, { replace: true, state: null })}
    />
  )
}

/**
 * GitHub answers features a private repository's plan lacks (rulesets, branch protection) with "Upgrade to GitHub Pro or
 * make this repository public to enable this feature.": a 403 from REST, a FORBIDDEN error from GraphQL.
 */
export function needsUpgrade(err: unknown) {
  return !!err && isUpgradeMessage(errorMessage(err))
}

export function graphqlErrorMessage(err: unknown) {
  return stripGraphqlPreamble(errorMessage(err))
}
