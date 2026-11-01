import { Link, Outlet, useLocation } from 'react-router-dom'
import { NavList } from '@primer/react'
import { GearIcon, PeopleIcon, GitBranchIcon, RepoPushIcon, WebhookIcon, KeyIcon, KeyAsteriskIcon, LockIcon } from '@primer/octicons-react'
import { useRepo } from '../../../lib/repo'
import { useAgentPageContext } from '../../../lib/agent/AgentProvider'
import { Blankslate } from '../../../components/Bits'

/** github.com answers a non-admin's /settings with its 404 page. */
function SettingsNotFound() {
  const { fullName } = useRepo()
  return (
    <div className="container-lg">
      <Blankslate icon={<LockIcon size={32} />} title="404 – This is not the web page you are looking for">
        Only people with admin access to {fullName} can view or change its settings.
      </Blankslate>
    </div>
  )
}

/**
 * /:owner/:repo/settings/*: github.com's settings side navigation (same groups and order) beside the section page.
 * gh-ui covers General, Collaborators, Branches, Rulesets, Webhooks, Deploy keys and Actions secrets/variables.
 */
export function RepoSettingsLayout() {
  const ctx = useRepo()
  const { owner, repo, data, fullName } = ctx
  const { pathname } = useLocation()
  // ['', owner, repo, 'settings', ...rest]
  const rest = pathname.split('/').slice(4).filter(Boolean).join('/')
  const base = `/${owner}/${repo}/settings`

  useAgentPageContext({ label: `settings of ${fullName}`, owner, repo, details: { section: rest || 'general' } })

  if (!data.permissions?.admin) return <SettingsNotFound />

  const at = (...prefixes: string[]) => (prefixes.some((p) => (p === '' ? rest === '' : rest === p || rest.startsWith(p + '/'))) ? 'page' : undefined)
  const item = (to: string, label: string, Icon: React.ElementType, current: 'page' | undefined) => (
    <NavList.Item as={Link} to={`${base}${to}`} aria-current={current}>
      <NavList.LeadingVisual>
        <Icon />
      </NavList.LeadingVisual>
      {label}
    </NavList.Item>
  )

  return (
    <div className="container-xl">
      <div className="repo-settings-layout">
        <nav className="repo-settings-nav" aria-label="Repository settings">
          <NavList aria-label="Repository settings">
            {item('', 'General', GearIcon, at(''))}
            <NavList.Group title="Access">
              {item('/access', data.owner.type === 'Organization' ? 'Collaborators and teams' : 'Collaborators', PeopleIcon, at('access'))}
            </NavList.Group>
            <NavList.Group title="Code, planning, and automation">
              {item('/branches', 'Branches', GitBranchIcon, at('branches', 'branch_protection_rules'))}
              <NavList.Item defaultOpen={!!at('rules')}>
                <NavList.LeadingVisual>
                  <RepoPushIcon />
                </NavList.LeadingVisual>
                Rules
                <NavList.SubNav>
                  <NavList.Item as={Link} to={`${base}/rules`} aria-current={at('rules')}>
                    Rulesets
                  </NavList.Item>
                </NavList.SubNav>
              </NavList.Item>
              {item('/hooks', 'Webhooks', WebhookIcon, at('hooks'))}
            </NavList.Group>
            <NavList.Group title="Security">
              {item('/keys', 'Deploy keys', KeyIcon, at('keys'))}
              <NavList.Item defaultOpen={!!at('secrets', 'variables')}>
                <NavList.LeadingVisual>
                  <KeyAsteriskIcon />
                </NavList.LeadingVisual>
                Secrets and variables
                <NavList.SubNav>
                  <NavList.Item as={Link} to={`${base}/secrets/actions`} aria-current={at('secrets/actions', 'variables/actions')}>
                    Actions
                  </NavList.Item>
                </NavList.SubNav>
              </NavList.Item>
            </NavList.Group>
          </NavList>
        </nav>
        <div className="repo-settings-main">
          <Outlet context={ctx} />
        </div>
      </div>
    </div>
  )
}
