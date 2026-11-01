import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, CounterLabel, Label, NavList, Pagination, RelativeTime, TextInput } from '@primer/react'
import { ShieldIcon, DependabotIcon, CodescanIcon, KeyIcon, AlertIcon, SparkleFillIcon, LinkExternalIcon, ShieldCheckIcon, HomeIcon, LawIcon, InfoIcon, SearchIcon } from '@primer/octicons-react'
import type { Octokit } from '@octokit/rest'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { openExternal } from '../../lib/platform'
import { webBaseFor } from '../../lib/hosts'
import { Blankslate, ErrorBox, Loading } from '../../components/Bits'
import { Markdown } from '../../components/Markdown'

interface Alert {
  id: string
  number: number
  title: string
  severity: string
  where: string
  created: string
  url: string
}

interface Advisory {
  ghsa: string
  summary: string
  severity: string
  state: string
  published: string | null
  created: string | null
  by: string | null
  url: string
}

type AlertSection = 'dependabot' | 'code-scanning' | 'secret-scanning'
type Section = 'overview' | 'policy' | 'advisories' | AlertSection

const SEVERITY_VARIANT: Record<string, 'danger' | 'severe' | 'attention' | 'primary' | 'secondary'> = { critical: 'danger', high: 'severe', medium: 'attention', moderate: 'attention', low: 'primary', error: 'danger', warning: 'attention', note: 'secondary' }
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** The API says "medium" where github.com shows "Moderate". */
const severityName = (s: string) => (s.toLowerCase() === 'medium' ? 'moderate' : s.toLowerCase())
/** github.com lists 10 advisories per page. */
const PER_PAGE = 10

async function load(octokit: Octokit, owner: string, repo: string, section: AlertSection): Promise<Alert[]> {
  switch (section) {
    case 'dependabot': {
      const { data } = await octokit.rest.dependabot.listAlertsForRepo({ owner, repo, state: 'open', per_page: 100 })
      return data.map((a) => ({
        id: `d${a.number}`,
        number: a.number,
        title: a.security_advisory.summary,
        severity: a.security_vulnerability.severity,
        where: `${a.dependency.package?.ecosystem}:${a.dependency.package?.name} · ${a.dependency.manifest_path}`,
        created: a.created_at,
        url: a.html_url,
      }))
    }
    case 'code-scanning': {
      const { data } = await octokit.rest.codeScanning.listAlertsForRepo({ owner, repo, state: 'open', per_page: 100 })
      return data.map((a) => ({
        id: `c${a.number}`,
        number: a.number,
        title: a.rule.description ?? a.rule.id ?? 'Alert',
        severity: a.rule.security_severity_level ?? a.rule.severity ?? 'warning',
        where: `${a.most_recent_instance.location?.path ?? ''}${a.most_recent_instance.location?.start_line ? `:${a.most_recent_instance.location.start_line}` : ''} · ${a.tool.name}`,
        created: a.created_at,
        url: a.html_url,
      }))
    }
    case 'secret-scanning': {
      const { data } = await octokit.rest.secretScanning.listAlertsForRepo({ owner, repo, state: 'open', per_page: 100 })
      return data.map((a) => ({
        id: `s${a.number}`,
        number: a.number ?? 0,
        title: a.secret_type_display_name ?? a.secret_type ?? 'Secret',
        severity: 'high',
        where: a.validity ? `validity: ${a.validity}` : 'secret scanning',
        created: a.created_at ?? '',
        url: a.html_url ?? '',
      }))
    }
  }
}

function useAlerts(section: AlertSection) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'security', owner, repo, section],
    queryFn: async () => {
      try {
        return { alerts: await load(octokit, owner, repo, section), unavailable: null as string | null }
      } catch (err) {
        const status = (err as { status?: number }).status
        // 403/404 means the feature is off or the token can't see it, not a broken page.
        if (status === 403 || status === 404) return { alerts: [] as Alert[], unavailable: errorMessage(err) }
        throw err
      }
    },
  })
}

function useAdvisories() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'security', owner, repo, 'advisories'],
    queryFn: async () => {
      try {
        const data = await octokit.paginate(octokit.rest.securityAdvisories.listRepositoryAdvisories, { owner, repo, per_page: 100 })
        const advisories: Advisory[] = data.map((a) => ({
          ghsa: a.ghsa_id,
          summary: a.summary,
          severity: a.severity ?? 'unknown',
          state: a.state,
          published: a.published_at ?? null,
          created: a.created_at ?? null,
          by: a.publisher?.login ?? a.author?.login ?? null,
          url: a.html_url,
        }))
        return { advisories, unavailable: null as string | null }
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 403 || status === 404) return { advisories: [] as Advisory[], unavailable: errorMessage(err) }
        throw err
      }
    },
  })
}

const POLICY_FILE = /^security\.(md|markdown)$/i

/** SECURITY.md as github.com finds it: .github/, the root, then docs/, falling back to the owner's .github repository. */
function useSecurityPolicy() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'security-policy', owner, repo],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      type Tree = { entries?: Array<{ name: string; type: string }> } | null
      const find = async (o: string, r: string) => {
        const res: { repository: { gh: Tree; root: Tree; docs: Tree } | null } = await octokit.graphql(
          `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){
            gh: object(expression:"HEAD:.github"){ ... on Tree { entries { name type } } }
            root: object(expression:"HEAD:"){ ... on Tree { entries { name type } } }
            docs: object(expression:"HEAD:docs"){ ... on Tree { entries { name type } } } } }`,
          { owner: o, repo: r },
        )
        const tree = res.repository
        if (!tree) return null
        for (const [dir, t] of [['.github/', tree.gh], ['', tree.root], ['docs/', tree.docs]] as const) {
          const hit = t?.entries?.find((e) => e.type === 'blob' && POLICY_FILE.test(e.name))
          if (hit) return { owner: o, repo: r, path: dir + hit.name }
        }
        return null
      }
      let at = await find(owner, repo)
      if (!at && repo !== '.github') at = await find(owner, '.github').catch(() => null)
      if (!at) return null
      const res = await octokit.rest.repos.getContent({ owner: at.owner, repo: at.repo, path: at.path, mediaType: { format: 'html' } })
      return { ...at, html: res.data as unknown as string }
    },
  })
}

/** Private vulnerability reporting decides whether "Report a vulnerability" is offered. */
function usePrivateReporting() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'security-pvr', owner, repo],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      try {
        return (await octokit.rest.repos.checkPrivateVulnerabilityReporting({ owner, repo })).data.enabled
      } catch {
        return false
      }
    },
  })
}

const ALERT_SECTIONS: Array<{ id: AlertSection; label: string; icon: React.ElementType }> = [
  { id: 'dependabot', label: 'Dependabot', icon: DependabotIcon },
  { id: 'code-scanning', label: 'Code scanning', icon: CodescanIcon },
  { id: 'secret-scanning', label: 'Secret scanning', icon: KeyIcon },
]
const SECTION_PATH: Record<Section, string> = {
  overview: '',
  policy: '/policy',
  advisories: '/advisories',
  dependabot: '/dependabot',
  'code-scanning': '/code-scanning',
  'secret-scanning': '/secret-scanning',
}

function sectionFrom(sub: string, legacyTab: string | null): Section {
  const first = sub.split('/')[0]
  const fromPath = (Object.keys(SECTION_PATH) as Section[]).find((s) => s !== 'overview' && SECTION_PATH[s] === `/${first}`)
  if (fromPath) return fromPath
  // Older gi-ui links used ?tab=<section>.
  if (legacyTab && legacyTab in SECTION_PATH) return legacyTab as Section
  return 'overview'
}

export function SecurityPage() {
  const { owner, repo, fullName } = useRepo()
  const { account } = useGitHub()
  const agent = useAgent()
  const { '*': sub = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const section = sectionFrom(sub, params.get('tab'))
  const base = `/${owner}/${repo}/security`
  const site = webBaseFor(account.host)
  const webBase = `${site}/${owner}/${repo}`
  const counts = { dependabot: useAlerts('dependabot'), 'code-scanning': useAlerts('code-scanning'), 'secret-scanning': useAlerts('secret-scanning') }
  const advisories = useAdvisories()
  const policy = useSecurityPolicy()
  const reporting = usePrivateReporting()
  const published = (advisories.data?.advisories ?? []).filter((a) => a.state === 'published')

  useAgentPageContext({
    label: `security alerts of ${fullName}`,
    owner,
    repo,
    details: {
      ...Object.fromEntries(Object.entries(counts).map(([k, q]) => [k, q.data?.unavailable ? 'unavailable' : q.data?.alerts.length])),
      advisories: advisories.data?.unavailable ? 'unavailable' : advisories.data?.advisories.length,
      security_policy: policy.data ? policy.data.path : policy.isLoading ? undefined : 'none',
    },
    suggestions: [
      { label: 'Triage alerts', prompt: `Triage the open security alerts in ${fullName} (use list_security_alerts). Rank by real exploitability in this codebase, and say which can be fixed by a dependency bump.` },
    ],
  })

  const reportButton = reporting.data ? (
    <Button variant="primary" onClick={() => openExternal(`${webBase}/security/advisories/new`)}>
      Report a vulnerability
    </Button>
  ) : null

  const page = Math.max(1, Number(params.get('page')) || 1)
  const setPage = (n: number) => setParams((p) => {
    const next = new URLSearchParams(p)
    if (n <= 1) next.delete('page')
    else next.set('page', String(n))
    return next
  })

  const navItem = (id: Section, label: string, Icon: React.ElementType, count?: number) => (
    <NavList.Item key={id} as={Link} to={base + SECTION_PATH[id]} aria-current={section === id ? 'page' : undefined}>
      <NavList.LeadingVisual>
        <Icon />
      </NavList.LeadingVisual>
      {label}
      {count !== undefined && (
        <NavList.TrailingVisual>
          <CounterLabel>{count}</CounterLabel>
        </NavList.TrailingVisual>
      )}
    </NavList.Item>
  )

  const alertSection = ALERT_SECTIONS.find((s) => s.id === section)
  const current = alertSection ? counts[alertSection.id] : null

  return (
    <div className="security-layout">
      <div className="security-sidebar">
        <nav aria-labelledby="security-nav-heading">
          <h2 id="security-nav-heading" className="security-nav-heading">
            Security and quality
          </h2>
          <NavList aria-label="Security and quality">
            {navItem('overview', 'Overview', HomeIcon)}
            <NavList.Divider />
            <NavList.Group title="Reporting">
              {navItem('policy', 'Security policy', LawIcon)}
              {navItem('advisories', 'Advisories', ShieldIcon, advisories.data && !advisories.data.unavailable ? published.length : undefined)}
            </NavList.Group>
            <NavList.Group title="Vulnerability alerts">
              {ALERT_SECTIONS.map((s) => navItem(s.id, s.label, s.icon, counts[s.id].data && !counts[s.id].data!.unavailable ? counts[s.id].data!.alerts.length : undefined))}
            </NavList.Group>
          </NavList>
        </nav>
      </div>
      <div className="security-main">
        <div>
          {section === 'overview' && (
            <>
              <div className="security-subhead mb-3">
                <h2 className="security-subhead-heading">Security</h2>
                {reportButton}
              </div>
              <div className="mb-4">
                <PolicyBox policy={policy} bordered />
              </div>
              <AdvisoryList query={advisories} advisories={published} page={page} setPage={setPage} fullName={fullName} site={site} footer />
            </>
          )}
          {section === 'policy' && <PolicyBox policy={policy} />}
          {section === 'advisories' && (
            <AdvisoriesView
              query={advisories}
              advisories={advisories.data?.advisories ?? []}
              reportButton={reportButton}
              page={page}
              setPage={setPage}
              fullName={fullName}
              site={site}
            />
          )}
          {alertSection && current && (
            <>
              <div className="security-subhead mb-3">
                <h2 className="security-subhead-heading">{alertSection.label} alerts</h2>
                {!!current.data?.alerts.length && (
                  <Button leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Look at the open ${alertSection.id.replace('-', ' ')} alerts in ${fullName} (list_security_alerts with kind "${alertSection.id}"). Explain which matter for this codebase and propose fixes.`)}>
                    Triage with agent
                  </Button>
                )}
              </div>
              {current.isLoading ? (
                <Loading />
              ) : current.error ? (
                <div className="error-box">{errorMessage(current.error)}</div>
              ) : current.data!.unavailable ? (
                <div className="Box security-blankslate">
                  <Blankslate icon={<AlertIcon size={24} />} title="Not available">
                    {current.data!.unavailable.replace(/\.$/, '')}. The feature may be disabled for this repository, or your token lacks the security_events / Dependabot alerts permission.
                  </Blankslate>
                </div>
              ) : current.data!.alerts.length === 0 ? (
                <div className="Box security-blankslate">
                  <Blankslate icon={<ShieldCheckIcon size={24} />} title="No open alerts" />
                </div>
              ) : (
                <div className="Box">
                  {current.data!.alerts.map((a) => (
                    <div key={a.id} className="Box-row hoverable" style={{ alignItems: 'center' }}>
                      <ShieldIcon className="fg-muted" />
                      <div className="flex-1">
                        <div className="flex-center gap-2 wrap">
                          <span className="text-bold">{a.title}</span>
                          <Label variant={SEVERITY_VARIANT[a.severity.toLowerCase()] ?? 'secondary'}>{capitalize(severityName(a.severity))}</Label>
                        </div>
                        <div className="Box-row-meta">
                          {a.number ? `#${a.number} · ` : ''}
                          {a.where}
                          {a.created && (
                            <>
                              {' '}
                              · opened <RelativeTime date={new Date(a.created)} />
                            </>
                          )}
                        </div>
                      </div>
                      {a.url && <Button size="small" variant="invisible" trailingVisual={LinkExternalIcon} onClick={() => openExternal(a.url)}>View</Button>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PolicyBox({ policy, bordered }: { policy: ReturnType<typeof useSecurityPolicy>; bordered?: boolean }) {
  if (policy.isLoading) return <Loading />
  if (policy.error) return <ErrorBox error={policy.error} title="Could not load the security policy" />
  if (!policy.data)
    return (
      <div className={bordered ? 'Box security-blankslate' : 'security-blankslate'}>
        <Blankslate icon={<LawIcon size={24} />} title="No security policy detected">
          This project has not set up a <span className="text-mono">SECURITY.md</span> file yet.
        </Blankslate>
      </div>
    )
  return (
    <div className="Box security-policy">
      <div className="Box-header">
        <h3 className="Box-title flex-1" style={{ margin: 0 }}>
          SECURITY.md
        </h3>
      </div>
      <div className="Box-body">
        <Markdown html={policy.data.html} />
      </div>
    </div>
  )
}

function AdvisoriesView({
  query,
  advisories,
  reportButton,
  page,
  setPage,
  fullName,
  site,
}: {
  query: ReturnType<typeof useAdvisories>
  advisories: Advisory[]
  reportButton: React.ReactNode
  page: number
  setPage: (n: number) => void
  fullName: string
  site: string
}) {
  const [filter, setFilter] = useState('')
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = advisories.filter((a) =>
    terms.every((t) => {
      if (t.startsWith('severity:')) return severityName(a.severity) === severityName(t.slice(9))
      return a.summary.toLowerCase().includes(t) || a.ghsa.toLowerCase().includes(t)
    }),
  )
  return (
    <>
      <div className="security-subhead">
        <h2 className="security-subhead-heading">Security Advisories</h2>
        {reportButton}
        <div className="security-subhead-description">
          {reportButton ? 'View known security vulnerabilities and report new vulnerabilities privately to maintainers.' : 'View information about security vulnerabilities from this repository’s maintainers.'}
        </div>
      </div>
      <TextInput
        className="mt-3 mb-3"
        block
        leadingVisual={SearchIcon}
        aria-label="Filter advisories: severity:critical, ecosystem:npm"
        placeholder="Filter advisories: severity:critical, ecosystem:npm"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value)
          setPage(1)
        }}
      />
      <AdvisoryList query={query} advisories={shown} page={page} setPage={setPage} fullName={fullName} site={site} />
    </>
  )
}

function AdvisoryList({
  query,
  advisories,
  page,
  setPage,
  fullName,
  site,
  footer,
}: {
  query: ReturnType<typeof useAdvisories>
  advisories: Advisory[]
  page: number
  setPage: (n: number) => void
  fullName: string
  site: string
  footer?: boolean
}) {
  if (query.isLoading) return <Loading />
  if (query.error) return <ErrorBox error={query.error} title="Could not load advisories" />
  if (query.data?.unavailable)
    return (
      <div className="Box security-blankslate">
        <Blankslate icon={<AlertIcon size={24} />} title="Advisories are not available">
          {query.data.unavailable}
        </Blankslate>
      </div>
    )
  if (!advisories.length)
    return (
      <div className="Box security-blankslate">
        <Blankslate icon={<ShieldCheckIcon size={24} />} title="There aren’t any published security advisories" />
      </div>
    )
  const pageCount = Math.ceil(advisories.length / PER_PAGE)
  const current = Math.min(page, pageCount)
  return (
    <>
      <div className="Box">
        {advisories.slice((current - 1) * PER_PAGE, current * PER_PAGE).map((a) => {
          const date = a.published ?? a.created
          return (
            <div key={a.ghsa} className="Box-row hoverable security-advisory-row">
              <span title={a.state === 'published' ? 'Published advisory' : `${capitalize(a.state)} advisory`} className="security-advisory-icon">
                <ShieldIcon className={a.state === 'published' ? 'fg-done' : 'fg-muted'} />
              </span>
              <div className="flex-1">
                <a
                  href={a.url}
                  className="security-advisory-title"
                  onClick={(e) => {
                    e.preventDefault()
                    openExternal(a.url)
                  }}
                >
                  {a.summary}
                </a>
                <div className="mt-1 text-small fg-muted">
                  {a.ghsa}{' '}
                  {date && (
                    <>
                      {a.state === 'published' ? 'published' : 'opened'} <RelativeTime date={new Date(date)} />
                    </>
                  )}
                  {a.by && (
                    <>
                      {' '}
                      by{' '}
                      <Link to={`/${a.by}`} className="link-muted">
                        {a.by}
                      </Link>
                    </>
                  )}
                </div>
              </div>
              {a.severity !== 'unknown' && (
                <span className="shrink-0">
                  <Label variant={SEVERITY_VARIANT[a.severity.toLowerCase()] ?? 'secondary'} title={`Severity: ${severityName(a.severity)}`}>
                    {capitalize(severityName(a.severity))}
                  </Label>
                </span>
              )}
            </div>
          )
        })}
      </div>
      {pageCount > 1 && (
        <Pagination
          className="security-pagination"
          pageCount={pageCount}
          currentPage={current}
          onPageChange={(e, n) => {
            e.preventDefault()
            setPage(n)
          }}
        />
      )}
      {footer && (
        <div className="fg-muted text-small flex-center gap-1 mt-3">
          <InfoIcon /> Learn more about advisories related to <strong>{fullName}</strong> in the{' '}
          <a
            href={`${site}/advisories`}
            onClick={(e) => {
              e.preventDefault()
              openExternal(`${site}/advisories`)
            }}
          >
            GitHub Advisory Database
          </a>
        </div>
      )}
    </>
  )
}
