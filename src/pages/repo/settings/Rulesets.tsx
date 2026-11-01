import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Banner, Button, Label } from '@primer/react'
import { GitBranchIcon, LinkExternalIcon, RepoPushIcon, TagIcon, TriangleDownIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { openExternal } from '../../../lib/platform'
import { webUrl } from '../../../lib/links'
import { plural } from '../../../lib/format'
import { ENFORCEMENT_LABEL, describeRefConditions } from '../../../lib/repoSettings'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { SettingsSubhead, needsUpgrade } from './common'

interface RulesetRow {
  id: number
  name: string
  target: string
  enforcement: string
  sourceType: string
  source: string
  rules: number | null
  targets: string
}

const ENFORCEMENT_VARIANT: Record<string, 'success' | 'attention' | 'secondary'> = { active: 'success', evaluate: 'attention', disabled: 'secondary' }
const TARGET_ICON: Record<string, React.ElementType> = { branch: GitBranchIcon, tag: TagIcon, push: RepoPushIcon }

/** /settings/rules: the repository's rulesets (including ones inherited from the organization), read-only. */
export function RulesetsSettings() {
  const { owner, repo } = useRepo()
  const { octokit, key, account } = useGitHub()
  const site = (path: string) => webUrl(account.host, `/${owner}/${repo}/settings/rules${path}`)

  const rulesets = useQuery({
    queryKey: [key, 'rulesets', owner, repo],
    retry: (n, e) => !needsUpgrade(e) && n < 2,
    queryFn: async () => {
      const list = await octokit.paginate(octokit.rest.repos.getRepoRulesets, { owner, repo, per_page: 100, includes_parents: true })
      // The list has no conditions or rules; each ruleset's own endpoint does.
      const details = await Promise.all(list.map((r) => octokit.rest.repos.getRepoRuleset({ owner, repo, ruleset_id: r.id, includes_parents: true }).then((d) => d.data).catch(() => null)))
      return list.map((r, i): RulesetRow => {
        const d = details[i]
        const refName = (d?.conditions as { ref_name?: { include?: string[]; exclude?: string[] } } | null | undefined)?.ref_name
        return {
          id: r.id,
          name: r.name,
          target: r.target ?? 'branch',
          enforcement: r.enforcement,
          sourceType: r.source_type ?? 'Repository',
          source: r.source,
          rules: d?.rules ? d.rules.length : null,
          targets: describeRefConditions(r.target, refName?.include, refName?.exclude),
        }
      })
    },
  })

  const newMenu = (
    <ActionMenu>
      <ActionMenu.Anchor>
        <Button variant="primary" trailingVisual={TriangleDownIcon}>
          New ruleset
        </Button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="auto" align="end">
        <ActionList>
          <ActionList.Item onSelect={() => openExternal(site('/new?target=branch&enforcement=disabled'))}>
            <ActionList.LeadingVisual>
              <GitBranchIcon />
            </ActionList.LeadingVisual>
            New branch ruleset
            <ActionList.TrailingVisual>
              <LinkExternalIcon />
            </ActionList.TrailingVisual>
          </ActionList.Item>
          <ActionList.Item onSelect={() => openExternal(site('/new?target=tag&enforcement=disabled'))}>
            <ActionList.LeadingVisual>
              <TagIcon />
            </ActionList.LeadingVisual>
            New tag ruleset
            <ActionList.TrailingVisual>
              <LinkExternalIcon />
            </ActionList.TrailingVisual>
          </ActionList.Item>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )

  return (
    <>
      <SettingsSubhead title="Rulesets" actions={newMenu} />
      {rulesets.isLoading ? (
        <Loading />
      ) : rulesets.error ? (
        needsUpgrade(rulesets.error) ? (
          <Banner variant="upsell" title="Rulesets are not available for this repository" description={errorMessage(rulesets.error)} />
        ) : (
          <ErrorBox error={rulesets.error} title="Could not load rulesets" />
        )
      ) : rulesets.data!.length === 0 ? (
        <div className="Box">
          <Blankslate icon={<RepoPushIcon size={24} />} title="You haven't created any rulesets">
            Define whether collaborators can delete or force push and set requirements for any pushes, such as passing status checks or a linear commit history.
          </Blankslate>
        </div>
      ) : (
        <div className="Box">
          {rulesets.data!.map((r) => {
            const Icon = TARGET_ICON[r.target] ?? GitBranchIcon
            const fromOrg = r.sourceType !== 'Repository'
            return (
              <div key={r.id} className="Box-row ruleset-row">
                <Icon className="fg-muted ruleset-icon" />
                <div className="flex-1">
                  <div className="flex-center gap-2 wrap">
                    <a
                      href={site(`/${r.id}`)}
                      className="text-bold fg-default"
                      onClick={(e) => {
                        e.preventDefault()
                        openExternal(fromOrg ? webUrl(account.host, `/organizations/${r.source}/settings/rules/${r.id}`) : site(`/${r.id}`))
                      }}
                    >
                      {r.name}
                    </a>
                    <Label variant={ENFORCEMENT_VARIANT[r.enforcement] ?? 'secondary'}>{ENFORCEMENT_LABEL[r.enforcement] ?? r.enforcement}</Label>
                  </div>
                  <div className="text-small fg-muted">
                    {[r.rules !== null ? plural(r.rules, 'rule') : null, r.targets ? `targeting ${r.targets}` : `${r.target} ruleset`, fromOrg ? `managed by ${r.source}` : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <LinkExternalIcon className="fg-muted" aria-label="Opens on GitHub" />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
