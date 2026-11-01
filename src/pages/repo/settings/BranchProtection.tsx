import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, Banner, Button, Checkbox, FormControl, IconButton, Select, TextInput, useConfirm } from '@primer/react'
import { GitBranchIcon, SearchIcon, XIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { plural } from '../../../lib/format'
import { openExternal } from '../../../lib/platform'
import { webUrl } from '../../../lib/links'
import { EMPTY_PROTECTION_FORM, PROTECTION_RULE_FIELDS, protectionFormFromRule, protectionInput, type ProtectionForm, type ProtectionRule } from '../../../lib/repoSettings'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { SettingsSubhead, graphqlErrorMessage, needsUpgrade } from './common'

function useProtectionRules() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'branch-protection-rules', owner, repo],
    queryFn: async () => {
      const res: { repository: { id: string; branchProtectionRules: { nodes: ProtectionRule[] } } } = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ id branchProtectionRules(first:100){ nodes{ ${PROTECTION_RULE_FIELDS} } } } }`,
        { owner, repo },
      )
      return { repositoryId: res.repository.id, rules: res.repository.branchProtectionRules.nodes }
    },
  })
}

/**
 * Whether the plan allows branch protection here: private repositories on GitHub Free answer even a read of the
 * default branch's protection with "Upgrade to GitHub Pro…" (an unprotected branch is a plain 404).
 */
function useProtectionAvailable() {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'branch-protection-available', owner, repo],
    enabled: data.private,
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      try {
        await octokit.rest.repos.getBranchProtection({ owner, repo, branch: data.default_branch })
        return { available: true, message: '' }
      } catch (e) {
        return needsUpgrade(e) ? { available: false, message: errorMessage(e) } : { available: true, message: '' }
      }
    },
  })
}

function UpgradeBanner({ message }: { message: string }) {
  return <Banner className="mb-3" variant="upsell" title="Protect your most important branches" description={message} />
}

/** /settings/branches: the classic branch protection rules, as on github.com. */
export function BranchProtectionSettings() {
  const { owner, repo } = useRepo()
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const rules = useProtectionRules()
  const available = useProtectionAvailable()
  const [error, setError] = useState<string | null>(null)
  const base = `/${owner}/${repo}/settings`

  const remove = useMutation({
    mutationFn: async (id: string) => octokit.graphql(`mutation($id:ID!){ deleteBranchProtectionRule(input:{branchProtectionRuleId:$id}){ clientMutationId } }`, { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [key, 'branch-protection-rules', owner, repo] }),
    onError: (e) => setError(graphqlErrorMessage(e)),
  })

  return (
    <>
      <SettingsSubhead
        title="Branch protection rules"
        actions={
          <span className="flex-center gap-2">
            <Button onClick={() => openExternal(webUrl(account.host, `/${owner}/${repo}/settings/rules/new?target=branch&enforcement=disabled`))}>Add branch ruleset</Button>
            <Button as={Link} to={`${base}/branch_protection_rules/new`}>
              Add classic branch protection rule
            </Button>
          </span>
        }
        description="Define branch rules to disable force pushing, prevent branches from being deleted, or require pull requests before merging."
      />
      {available.data && !available.data.available && <UpgradeBanner message={available.data.message} />}
      {error && <div className="error-box mb-3">{error}</div>}
      {rules.isLoading ? (
        <Loading />
      ) : rules.error ? (
        <ErrorBox error={rules.error} title="Could not load branch protection rules" />
      ) : rules.data!.rules.length === 0 ? (
        <div className="Box">
          <Blankslate icon={<GitBranchIcon size={24} />} title="Classic branch protections have not been configured">
            Define branch protection rules to disable force pushing, prevent branches from being deleted, or optionally require status checks before merging.
          </Blankslate>
        </div>
      ) : (
        <div className="Box">
          {rules.data!.rules.map((r) => (
            <div key={r.id} className="Box-row protection-rule-row">
              <div className="flex-1">
                <div className="text-bold text-break">{r.pattern}</div>
                <div className="text-small fg-muted">Currently applies to {plural(r.matchingRefs.totalCount, 'branch', 'branches')}</div>
              </div>
              <Button size="small" as={Link} to={`${base}/branch_protection_rules/${r.databaseId}`}>
                Edit
              </Button>
              <Button
                size="small"
                variant="danger"
                disabled={remove.isPending}
                onClick={async () => {
                  setError(null)
                  const ok = await confirm({
                    title: 'Delete branch protection rule?',
                    content: (
                      <>
                        Are you sure you want to delete the <strong>{r.pattern}</strong> branch protection rule? Matching branches will no longer be protected by it.
                      </>
                    ),
                    confirmButtonContent: 'I understand, delete this rule.',
                    confirmButtonType: 'danger',
                    width: 'large',
                  })
                  if (ok) remove.mutate(r.id)
                }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** A rule checkbox with github.com's description; its nested options show only while it is checked. */
function RuleOption({ label, caption, checked, onChange, children }: { label: string; caption: ReactNode; checked: boolean; onChange(v: boolean): void; children?: ReactNode }) {
  return (
    <div className="protection-option">
      <FormControl>
        <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <FormControl.Label>{label}</FormControl.Label>
        <FormControl.Caption>{caption}</FormControl.Caption>
      </FormControl>
      {checked && children && <div className="protection-suboptions">{children}</div>}
    </div>
  )
}

/** Check names seen on the default branch's head commit, offered when adding required status checks. */
function useKnownChecks(enabled: boolean) {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'known-checks', owner, repo, data.default_branch],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [runs, status] = await Promise.all([
        octokit.rest.checks.listForRef({ owner, repo, ref: data.default_branch, per_page: 100 }).catch(() => null),
        octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: data.default_branch, per_page: 100 }).catch(() => null),
      ])
      const names = [...(runs?.data.check_runs.map((r) => r.name) ?? []), ...(status?.data.statuses.map((s) => s.context) ?? [])]
      return [...new Set(names)].sort((a, b) => a.localeCompare(b))
    },
  })
}

function StatusChecksPicker({ value, onChange }: { value: string[]; onChange(next: string[]): void }) {
  const [query, setQuery] = useState('')
  const known = useKnownChecks(true)
  const q = query.trim()
  const suggestions = useMemo(() => (known.data ?? []).filter((n) => !value.includes(n) && n.toLowerCase().includes(q.toLowerCase())).slice(0, 10), [known.data, value, q])
  const add = (name: string) => {
    if (name && !value.includes(name)) onChange([...value, name])
    setQuery('')
  }
  return (
    <div className="protection-checks">
      <TextInput
        block
        leadingVisual={SearchIcon}
        placeholder="Search for status checks in the last week for this repository"
        aria-label="Search for status checks"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(q)
          }
        }}
      />
      {q && (
        <ActionList className="protection-check-suggestions" aria-label="Status checks">
          {suggestions.map((s) => (
            <ActionList.Item key={s} onSelect={() => add(s)}>
              {s}
            </ActionList.Item>
          ))}
          {!suggestions.includes(q) && !value.includes(q) && <ActionList.Item onSelect={() => add(q)}>Add “{q}”</ActionList.Item>}
        </ActionList>
      )}
      <div className="Box mt-2">
        <div className="Box-header compact text-bold">Status checks that are required.</div>
        {value.length === 0 ? (
          <div className="Box-row fg-muted">No checks have been added</div>
        ) : (
          value.map((c) => (
            <div key={c} className="Box-row protection-check-row">
              <span className="flex-1 text-break">{c}</span>
              <IconButton icon={XIcon} size="small" variant="invisible" aria-label={`Remove ${c}`} onClick={() => onChange(value.filter((x) => x !== c))} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** /settings/branch_protection_rules/new and /settings/branch_protection_rules/:id (the rule's database id). */
export function BranchProtectionRulePage() {
  const { id } = useParams()
  const rules = useProtectionRules()
  const rule = id && id !== 'new' ? rules.data?.rules.find((r) => String(r.databaseId) === id) : undefined
  if (rules.isLoading) return <Loading />
  if (rules.error) return <ErrorBox error={rules.error} title="Could not load branch protection rules" />
  if (id && id !== 'new' && !rule) return <ErrorBox error={new Error('This branch protection rule no longer exists.')} title="Branch protection rule not found" />
  return <RuleForm key={rule?.id ?? 'new'} repositoryId={rules.data!.repositoryId} rule={rule} />
}

function RuleForm({ repositoryId, rule }: { repositoryId: string; rule?: ProtectionRule }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [form, setForm] = useState<ProtectionForm>(() => (rule ? protectionFormFromRule(rule) : EMPTY_PROTECTION_FORM))
  const [error, setError] = useState<unknown>(null)
  const set = <K extends keyof ProtectionForm>(k: K) => (v: ProtectionForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const back = `/${owner}/${repo}/settings/branches`

  const save = useMutation({
    mutationFn: async () => {
      const input = protectionInput(form)
      if (rule)
        await octokit.graphql(`mutation($input:UpdateBranchProtectionRuleInput!){ updateBranchProtectionRule(input:$input){ branchProtectionRule{ id } } }`, {
          input: { branchProtectionRuleId: rule.id, ...input },
        })
      else
        await octokit.graphql(`mutation($input:CreateBranchProtectionRuleInput!){ createBranchProtectionRule(input:$input){ branchProtectionRule{ id } } }`, {
          input: { repositoryId, ...input },
        })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'branch-protection-rules', owner, repo] })
      void qc.invalidateQueries({ queryKey: [key, 'branches', owner, repo] })
      navigate(back)
    },
    onError: setError,
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <SettingsSubhead title="Branch protection rule" />
      <FormControl required className="protection-pattern">
        <FormControl.Label>Branch name pattern</FormControl.Label>
        <TextInput value={form.pattern} onChange={(e) => set('pattern')(e.target.value)} autoFocus={!rule} />
        {rule && <FormControl.Caption>Applies to {plural(rule.matchingRefs.totalCount, 'branch', 'branches')}.</FormControl.Caption>}
      </FormControl>

      <h3 className="protection-heading">Protect matching branches</h3>
      <RuleOption
        label="Require a pull request before merging"
        caption="When enabled, all commits must be made to a non-protected branch and submitted via a pull request before they can be merged into a branch that matches this rule."
        checked={form.requirePullRequest}
        onChange={set('requirePullRequest')}
      >
        <RuleOption
          label="Require approvals"
          caption="When enabled, pull requests targeting a matching branch require a number of approvals and no changes requested before they can be merged."
          checked={form.requireApprovals}
          onChange={set('requireApprovals')}
        >
          <FormControl>
            <FormControl.Label>Required number of approvals before merging</FormControl.Label>
            <Select value={String(form.approvalCount)} onChange={(e) => set('approvalCount')(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <Select.Option key={n} value={String(n)}>
                  {n}
                </Select.Option>
              ))}
            </Select>
          </FormControl>
        </RuleOption>
        <RuleOption
          label="Dismiss stale pull request approvals when new commits are pushed"
          caption="New reviewable commits pushed to a matching branch will dismiss pull request review approvals."
          checked={form.dismissStale}
          onChange={set('dismissStale')}
        />
        <RuleOption
          label="Require review from Code Owners"
          caption="Require an approved review in pull requests including files with a designated code owner."
          checked={form.requireCodeOwners}
          onChange={set('requireCodeOwners')}
        />
        <RuleOption
          label="Require approval of the most recent reviewable push"
          caption="Whether the most recent reviewable push must be approved by someone other than the person who pushed it."
          checked={form.requireLastPush}
          onChange={set('requireLastPush')}
        />
      </RuleOption>
      <RuleOption
        label="Require status checks to pass before merging"
        caption="Choose which status checks must pass before branches can be merged into a branch that matches this rule. When enabled, commits must first be pushed to another branch, then merged or pushed directly to a branch that matches this rule after status checks have passed."
        checked={form.requireStatusChecks}
        onChange={set('requireStatusChecks')}
      >
        <RuleOption
          label="Require branches to be up to date before merging"
          caption="This ensures pull requests targeting a matching branch have been tested with the latest code. This setting will not take effect unless at least one status check is enabled (see below)."
          checked={form.strictStatusChecks}
          onChange={set('strictStatusChecks')}
        />
        <StatusChecksPicker value={form.statusChecks} onChange={set('statusChecks')} />
      </RuleOption>
      <RuleOption
        label="Require conversation resolution before merging"
        caption="When enabled, all conversations on code must be resolved before a pull request can be merged into a branch that matches this rule."
        checked={form.requireConversationResolution}
        onChange={set('requireConversationResolution')}
      />
      <RuleOption label="Require signed commits" caption="Commits pushed to matching branches must have verified signatures." checked={form.requireSignedCommits} onChange={set('requireSignedCommits')} />
      <RuleOption label="Require linear history" caption="Prevent merge commits from being pushed to matching branches." checked={form.requireLinearHistory} onChange={set('requireLinearHistory')} />
      <RuleOption label="Lock branch" caption="Branch is read-only. Users cannot push to the branch." checked={form.lockBranch} onChange={set('lockBranch')} />
      <RuleOption
        label="Do not allow bypassing the above settings"
        caption="The above settings will apply to administrators and custom roles with the “bypass branch protections” permission."
        checked={form.enforceAdmins}
        onChange={set('enforceAdmins')}
      />

      <h3 className="protection-heading">Rules applied to everyone including administrators</h3>
      <RuleOption label="Allow force pushes" caption="Permit force pushes for all users with push access." checked={form.allowForcePushes} onChange={set('allowForcePushes')} />
      <RuleOption label="Allow deletions" caption="Allow users with push access to delete matching branches." checked={form.allowDeletions} onChange={set('allowDeletions')} />

      {!!error &&
        (needsUpgrade(error) ? (
          <UpgradeBanner message={graphqlErrorMessage(error)} />
        ) : (
          <div className="error-box mb-3">{graphqlErrorMessage(error)}</div>
        ))}
      <div className="protection-actions">
        <Button type="submit" variant="primary" disabled={!form.pattern.trim() || save.isPending} loading={save.isPending}>
          {rule ? 'Save changes' : 'Create'}
        </Button>
        <Button as={Link} to={back}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
