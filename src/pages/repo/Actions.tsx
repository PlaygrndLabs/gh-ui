import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Banner, Button, ButtonGroup, Checkbox, Dialog, FormControl, IconButton, NavList, RelativeTime, Select, TextInput, useConfirm } from '@primer/react'
import { KebabHorizontalIcon, PlayIcon, SyncIcon, StopIcon, TrashIcon, FileCodeIcon, ChevronLeftIcon, ChevronRightIcon, SparkleFillIcon, WorkflowIcon, StopwatchIcon, CalendarIcon, SearchIcon } from '@primer/octicons-react'
import { parse as parseYaml } from 'yaml'
import { useGitHub, decodeBase64, errorMessage, type WorkflowRun, type Workflow } from '../../lib/github'
import { useRepo, useBranches, encodePath } from '../../lib/repo'
import { AgentOnly, useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { durationBetween } from '../../lib/format'
import { BranchPicker } from '../../components/BranchPicker'
import { CheckStatusIcon } from '../../components/Status'
import { Blankslate, ErrorBox, Loading } from '../../components/Bits'

const EVENT_LABEL: Record<string, string> = {
  push: 'pushed',
  pull_request: 'pull request',
  pull_request_target: 'pull request target',
  workflow_dispatch: 'manually run',
  schedule: 'scheduled',
  release: 'release',
  merge_group: 'merge queue',
  workflow_run: 'workflow run',
  repository_dispatch: 'repository dispatch',
}

export function useWorkflows(owner: string, repo: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'workflows', owner, repo],
    staleTime: 5 * 60_000,
    queryFn: async () => octokit.paginate(octokit.rest.actions.listRepoWorkflows, { owner, repo, per_page: 100 }),
  })
}

export function ActionsPage() {
  const { owner, repo, fullName, data } = useRepo()
  const { workflow: workflowParam } = useParams()
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const agent = useAgent()
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('page') || 1)
  const status = params.get('status') || ''
  const branch = params.get('branch') || ''
  const event = params.get('event') || ''
  const actor = params.get('actor') || ''

  const workflows = useWorkflows(owner, repo)
  const branches = useBranches(owner, repo)
  const selected = workflows.data?.find((w) => String(w.id) === workflowParam || w.path.endsWith(`/${workflowParam}`))

  useAgentPageContext({
    label: selected ? `Actions workflow “${selected.name}” in ${fullName}` : `Actions runs of ${fullName}`,
    owner,
    repo,
    details: { workflow: selected?.path, status, branch, event },
    suggestions: [
      { label: 'Explain recent failures', prompt: `Look at the most recent failed ${selected ? `"${selected.name}" ` : ''}workflow runs in ${fullName}${branch ? ` on ${branch}` : ''}. Group them by root cause and say which look flaky vs. real.` },
      { label: 'Re-run flaky failures', prompt: `Find recent failed workflow runs in ${fullName}${branch ? ` on ${branch}` : ''} that look flaky (network, timeouts, infrastructure) based on their logs, and re-run only their failed jobs. Tell me which you re-ran and why.` },
    ],
  })

  const runs = useQuery({
    queryKey: [key, 'runs', owner, repo, selected?.id ?? 'all', page, status, branch, event, actor],
    enabled: !workflowParam || !!selected,
    queryFn: async () => {
      const common = { owner, repo, per_page: 25, page, status: (status || undefined) as never, branch: branch || undefined, event: event || undefined, actor: actor || undefined }
      const res = selected ? await octokit.rest.actions.listWorkflowRuns({ ...common, workflow_id: selected.id }) : await octokit.rest.actions.listWorkflowRunsForRepo(common)
      return res.data
    },
    refetchInterval: (q) => (q.state.data?.workflow_runs.some((r) => r.status !== 'completed') ? 10_000 : false),
  })

  const setFilter = (k: string, v: string) =>
    setParams((p) => {
      if (v) p.set(k, v)
      else p.delete(k)
      p.delete('page')
      return p
    })
  // Same qualifiers github.com's "Search runs" box accepts.
  const query = [branch && `branch:${branch}`, status && `is:${status}`, event && `event:${event}`, actor && `actor:${actor}`].filter(Boolean).join(' ')
  const applyQuery = (text: string) =>
    setParams((p) => {
      const pick = (re: RegExp) => text.match(re)?.[1] ?? ''
      const next: Record<string, string> = { branch: pick(/\bbranch:(\S+)/), status: pick(/\b(?:is|status):(\S+)/), event: pick(/\bevent:(\S+)/), actor: pick(/\bactor:(\S+)/) }
      for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k))
      p.delete('page')
      return p
    })

  const canWrite = !!data.permissions?.push
  const refresh = () => void qc.invalidateQueries({ queryKey: [key, 'runs', owner, repo] })

  return (
    <div className="container-xl">
      <div className="layout-sidebar-left" style={{ gridTemplateColumns: '256px minmax(0,1fr)' }}>
        <div>
          <h2 className="section-title" style={{ fontSize: 20, marginBottom: 8 }}>
            Actions
          </h2>
          <NavList aria-label="Workflows">
            <NavList.Item as={Link} to={`/${owner}/${repo}/actions`} aria-current={!workflowParam ? 'page' : undefined}>
              All workflows
            </NavList.Item>
            <NavList.Group title="Workflows">
              {(workflows.data ?? []).map((w) => (
                <NavList.Item key={w.id} as={Link} to={`/${owner}/${repo}/actions/workflows/${w.path.split('/').pop()}`} aria-current={selected?.id === w.id ? 'page' : undefined}>
                  <NavList.LeadingVisual>
                    <WorkflowIcon />
                  </NavList.LeadingVisual>
                  {w.name}
                  {w.state !== 'active' && <NavList.TrailingVisual>off</NavList.TrailingVisual>}
                </NavList.Item>
              ))}
            </NavList.Group>
          </NavList>
        </div>
        <div style={{ minWidth: 0 }}>
          {selected && selected.state !== 'active' && <DisabledWorkflowBanner workflow={selected} canWrite={canWrite} />}
          <div className="flex-center gap-2 mb-3 wrap">
            <h2 style={{ margin: 0, fontSize: 24, fontWeight: 400 }} className="flex-1">
              {selected ? selected.name : 'All workflows'}
            </h2>
            <AgentOnly><Button size="small" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Summarize the health of ${selected ? `the "${selected.name}" workflow` : 'GitHub Actions'} in ${fullName}: recent pass rate, the failures and their causes.`)}>
              Ask agent
            </Button></AgentOnly>
            {/* Keyed so the chosen ref, inputs and open state don't carry over to another workflow. */}
            {selected && canWrite && <DispatchButton key={selected.id} owner={owner} repo={repo} workflow={selected} onDone={refresh} />}
          </div>
          <p className="fg-muted" style={{ margin: '-8px 0 12px' }}>
            {selected ? (
              // Like github.com, a workflow's page names its file under the title.
              <Link to={`/${owner}/${repo}/blob/${encodePath(data.default_branch)}/${encodePath(selected.path)}`}>{selected.path.split('/').pop()}</Link>
            ) : (
              'Showing runs from all workflows'
            )}
          </p>
          <RunSearch key={query} value={query} onSubmit={applyQuery} />
          <div className="Box">
            <div className="Box-header compact" style={{ flexWrap: 'wrap' }}>
              <span className="text-bold flex-1">{runs.data ? `${runs.data.total_count.toLocaleString()} workflow run${runs.data.total_count === 1 ? '' : 's'}` : 'Workflow runs'}</span>
              <RunFilter label="Event" value={event} options={Object.keys(EVENT_LABEL).map((e) => [e, e])} onChange={(v) => setFilter('event', v)} />
              <RunFilter label="Status" value={status} options={STATUS_OPTIONS} onChange={(v) => setFilter('status', v)} />
              <RunFilter label="Branch" value={branch} options={(branches.data ?? []).slice(0, 50).map((b) => [b.name, b.name])} onChange={(v) => setFilter('branch', v)} />
              <RunFilter label="Actor" value={actor} options={[[account.login, account.login]]} onChange={(v) => setFilter('actor', v)} />
            </div>
            {runs.isLoading || workflows.isLoading ? (
              <Loading />
            ) : runs.error ? (
              <div className="p-3">
                <ErrorBox error={runs.error} />
              </div>
            ) : runs.data?.workflow_runs.length ? (
              runs.data.workflow_runs.map((r) => <RunRow key={r.id} run={r} canWrite={canWrite} onChanged={refresh} />)
            ) : (
              <Blankslate icon={<PlayIcon size={24} />} title="No workflow runs">
                {workflows.data?.length ? 'Nothing matches these filters.' : 'This repository has no GitHub Actions workflows.'}
              </Blankslate>
            )}
          </div>
          {runs.data && runs.data.total_count > 25 && (
            <div className="flex-center mt-3" style={{ justifyContent: 'center' }}>
              <ButtonGroup>
                <Button leadingVisual={ChevronLeftIcon} disabled={page <= 1} onClick={() => setParams((p) => (p.set('page', String(page - 1)), p))}>
                  Previous
                </Button>
                <Button trailingVisual={ChevronRightIcon} disabled={page * 25 >= runs.data.total_count} onClick={() => setParams((p) => (p.set('page', String(page + 1)), p))}>
                  Next
                </Button>
              </ButtonGroup>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const STATUS_OPTIONS: Array<[string, string]> = [
  ['success', 'Success'],
  ['failure', 'Failure'],
  ['in_progress', 'In progress'],
  ['queued', 'Queued'],
  ['waiting', 'Waiting'],
  ['action_required', 'Action required'],
  ['cancelled', 'Cancelled'],
  ['skipped', 'Skipped'],
]

function RunSearch({ value, onSubmit }: { value: string; onSubmit(text: string): void }) {
  const [draft, setDraft] = useState(value)
  return (
    <form
      className="mb-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(draft)
      }}
    >
      <TextInput block leadingVisual={SearchIcon} placeholder="Search runs (branch:main is:failure event:push actor:octocat)" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Search runs" />
    </form>
  )
}

function RunFilter({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange(v: string): void }) {
  return (
    <ActionMenu>
      <ActionMenu.Button variant="invisible" size="small">
        {value ? `${label}: ${options.find(([v]) => v === value)?.[1] ?? value}` : label}
      </ActionMenu.Button>
      <ActionMenu.Overlay width="medium">
        <ActionList selectionVariant="single" style={{ maxHeight: 320, overflow: 'auto' }}>
          <ActionList.Item selected={!value} onSelect={() => onChange('')}>
            All
          </ActionList.Item>
          {options.map(([v, text]) => (
            <ActionList.Item key={v} selected={value === v} onSelect={() => onChange(v)}>
              {text}
            </ActionList.Item>
          ))}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

/** "Scheduled", "Commit 1a2b3c4 pushed by octocat", "Pull request #12 by octocat"… as on github.com. */
function triggerText(run: WorkflowRun) {
  const who = run.triggering_actor?.login ?? run.actor?.login ?? 'someone'
  const pr = run.pull_requests?.[0]?.number
  switch (run.event) {
    case 'schedule':
      return 'Scheduled'
    case 'push':
      return `Commit ${run.head_sha.slice(0, 7)} pushed by ${who}`
    case 'pull_request':
    case 'pull_request_target':
      return pr ? `Pull request #${pr} by ${who}` : `Pull request by ${who}`
    case 'workflow_dispatch':
      return `Manually run by ${who}`
    case 'merge_group':
      return `Merge group checks requested by ${who}`
    case 'workflow_run':
      return `Triggered via workflow run by ${who}`
    default:
      return `${EVENT_LABEL[run.event] ? `Triggered via ${EVENT_LABEL[run.event]}` : run.event} by ${who}`
  }
}

function RunRow({ run, canWrite, onChanged }: { run: WorkflowRun; canWrite: boolean; onChanged(): void }) {
  const { owner, repo } = useRepo()
  const { octokit } = useGitHub()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => (setError(null), onChanged()),
    onError: (e) => setError(errorMessage(e)),
  })
  const failed = run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out'
  return (
    <div className="run-row">
      <CheckStatusIcon status={run.status} conclusion={run.conclusion} />
      <div style={{ minWidth: 0 }}>
        <Link to={`/${owner}/${repo}/actions/runs/${run.id}`} className="text-bold fg-default text-break">
          {run.display_title}
        </Link>
        <div className="text-small fg-muted">
          <strong>{run.name}</strong> #{run.run_number}
          {run.run_attempt && run.run_attempt > 1 ? ` (attempt ${run.run_attempt})` : ''}: {triggerText(run)}
        </div>
        {error && <div className="text-small fg-danger">{error}</div>}
      </div>
      <div className="hide-sm" style={{ minWidth: 0 }}>
        {run.head_branch && (
          <span className="branch-pill">
            {run.head_repository && run.head_repository.full_name !== run.repository.full_name ? `${run.head_repository.owner.login}:${run.head_branch}` : run.head_branch}
          </span>
        )}
      </div>
      <div className="hide-sm text-small fg-muted">
        <div className="flex-center gap-1">
          <CalendarIcon size={14} /> <RelativeTime date={new Date(run.run_started_at ?? run.created_at)} />
        </div>
        <div className="flex-center gap-1">
          {/* A run waiting for approval never started, so github.com says so instead of a duration. */}
          <StopwatchIcon size={14} /> {run.conclusion === 'action_required' ? 'Action required' : durationBetween(run.run_started_at ?? run.created_at, run.status === 'completed' ? run.updated_at : null)}
        </div>
      </div>
      <ActionMenu>
        <ActionMenu.Anchor>
          <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="Run actions" />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay align="end" width="medium">
          <ActionList>
            {canWrite && run.status === 'completed' && (
              <>
                <ActionList.Item onSelect={() => act.mutate(() => octokit.rest.actions.reRunWorkflow({ owner, repo, run_id: run.id }))}>
                  <ActionList.LeadingVisual>
                    <SyncIcon />
                  </ActionList.LeadingVisual>
                  Re-run all jobs
                </ActionList.Item>
                {failed && (
                  <ActionList.Item onSelect={() => act.mutate(() => octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: run.id }))}>
                    <ActionList.LeadingVisual>
                      <SyncIcon />
                    </ActionList.LeadingVisual>
                    Re-run failed jobs
                  </ActionList.Item>
                )}
              </>
            )}
            {canWrite && run.status !== 'completed' && (
              <ActionList.Item onSelect={() => act.mutate(() => octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: run.id }))}>
                <ActionList.LeadingVisual>
                  <StopIcon />
                </ActionList.LeadingVisual>
                Cancel run
              </ActionList.Item>
            )}
            <ActionList.LinkItem as={Link} to={`/${owner}/${repo}/blob/${encodePath(run.head_sha)}/${encodePath(run.path.split('@')[0])}`}>
              <ActionList.LeadingVisual>
                <FileCodeIcon />
              </ActionList.LeadingVisual>
              View workflow file
            </ActionList.LinkItem>
            {canWrite && run.status === 'completed' && (
              <>
                <ActionList.Divider />
                <ActionList.Item
                  variant="danger"
                  onSelect={async () => {
                    if (await confirm({ title: 'Delete workflow run?', content: `Run #${run.run_number} of ${run.name} and its logs will be deleted.`, confirmButtonType: 'danger', confirmButtonContent: 'Delete' }))
                      act.mutate(() => octokit.rest.actions.deleteWorkflowRun({ owner, repo, run_id: run.id }))
                  }}
                >
                  <ActionList.LeadingVisual>
                    <TrashIcon />
                  </ActionList.LeadingVisual>
                  Delete workflow run
                </ActionList.Item>
              </>
            )}
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
    </div>
  )
}

const DISABLED_REASON: Record<string, string> = {
  disabled_manually: 'This workflow was disabled manually.',
  disabled_inactivity: "This scheduled workflow is disabled because there hasn't been activity in this repository for at least 60 days.",
  disabled_fork: 'This workflow is disabled because it comes from a fork.',
}

function DisabledWorkflowBanner({ workflow, canWrite }: { workflow: Workflow; canWrite: boolean }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const enable = useMutation({
    mutationFn: () => octokit.rest.actions.enableWorkflow({ owner, repo, workflow_id: workflow.id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [key, 'workflows', owner, repo] }),
  })
  return (
    <div className="mb-3">
      <Banner
        variant="warning"
        title={DISABLED_REASON[workflow.state] ?? 'This workflow is disabled.'}
        description={enable.error ? errorMessage(enable.error) : undefined}
        primaryAction={
          canWrite && workflow.state !== 'deleted' ? (
            <Banner.PrimaryAction onClick={() => enable.mutate()} disabled={enable.isPending}>
              Enable workflow
            </Banner.PrimaryAction>
          ) : undefined
        }
      />
    </div>
  )
}

interface DispatchInput {
  description?: string
  required?: boolean
  default?: string | boolean | number
  type?: 'string' | 'choice' | 'boolean' | 'number' | 'environment'
  options?: string[]
}

function DispatchButton({ owner, repo, workflow, onDone }: { owner: string; repo: string; workflow: Workflow; onDone(): void }) {
  const { data } = useRepo()
  const { octokit, key } = useGitHub()
  const [open, setOpen] = useState(false)
  const [ref, setRef] = useState(data.default_branch)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const specAt = (at: string) => ({
    queryKey: [key, 'workflow-spec', owner, repo, workflow.path, at],
    queryFn: async () => {
      const res = await octokit.rest.repos.getContent({ owner, repo, path: workflow.path, ref: at })
      if (Array.isArray(res.data) || res.data.type !== 'file') return null
      const doc = parseYaml(decodeBase64(res.data.content)) as { on?: unknown; true?: unknown } | null
      // YAML 1.1 parsers read a bare `on:` key as boolean true.
      const on = doc?.on ?? doc?.true
      if (!on) return null
      if (on === 'workflow_dispatch' || (Array.isArray(on) && on.includes('workflow_dispatch'))) return { inputs: {} as Record<string, DispatchInput> }
      if (typeof on === 'object' && on && 'workflow_dispatch' in on) {
        const wd = (on as Record<string, { inputs?: Record<string, DispatchInput> } | null>).workflow_dispatch
        return { inputs: wd?.inputs ?? {} }
      }
      return null
    },
  })
  // The button follows the default branch, like github.com; the dialog follows the chosen ref.
  const spec = useQuery(specAt(data.default_branch))
  const refSpec = useQuery({ ...specAt(ref), placeholderData: keepPreviousData })

  const inputs = useMemo(() => Object.entries(refSpec.data?.inputs ?? {}), [refSpec.data])
  // What an input shows, and so what it is sent as.
  const effective = (name: string, input: DispatchInput) => {
    const v = values[name] ?? (input.default !== undefined ? String(input.default) : input.type === 'boolean' ? 'false' : '')
    return input.type === 'choice' && input.options?.length && !input.options.some((o) => String(o) === v) ? String(input.options[0]) : v
  }

  const dispatch = useMutation({
    mutationFn: async () => {
      const payload = Object.fromEntries(inputs.map(([n, i]) => [n, effective(n, i)]).filter(([, v]) => v !== ''))
      await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: workflow.id, ref, inputs: payload })
    },
    onSuccess: () => {
      setOpen(false)
      // The run takes a moment to appear.
      setTimeout(onDone, 2500)
    },
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <>
      {spec.data && (
        <Button size="small" variant="primary" leadingVisual={PlayIcon} onClick={() => setOpen(true)}>
          Run workflow
        </Button>
      )}
      {open && (
        <Dialog
          title={`Run ${workflow.name}`}
          onClose={() => setOpen(false)}
          footerButtons={[
            { content: 'Cancel', onClick: () => setOpen(false) },
            { content: 'Run workflow', buttonType: 'primary', onClick: () => dispatch.mutate(), disabled: dispatch.isPending || !refSpec.data || refSpec.isPlaceholderData },
          ]}
        >
          <div className="mb-3">
            <div className="text-bold mb-1">Use workflow from</div>
            <BranchPicker owner={owner} repo={repo} value={ref} onChange={(r) => (setRef(r), setError(null))} defaultBranch={data.default_branch} />
          </div>
          {refSpec.error ? (
            <ErrorBox error={refSpec.error} title={`Could not load ${workflow.path} at ${ref}`} />
          ) : refSpec.data === null && !refSpec.isPlaceholderData ? (
            <div className="fg-muted">
              {workflow.path} at {ref} has no workflow_dispatch trigger, so it can't be run from there.
            </div>
          ) : !refSpec.data ? (
            <Loading />
          ) : (
            inputs.map(([name, input]) => {
              const value = effective(name, input)
              const set = (v: string) => setValues((s) => ({ ...s, [name]: v }))
              return (
                <FormControl key={name} required={input.required} className="mb-2">
                  <FormControl.Label>{input.description || name}</FormControl.Label>
                  {input.type === 'boolean' ? (
                    <Checkbox checked={value === 'true'} onChange={(e) => set(e.target.checked ? 'true' : 'false')} />
                  ) : input.type === 'choice' && input.options ? (
                    <Select value={value} onChange={(e) => set(e.target.value)}>
                      {input.options.map((o) => (
                        <Select.Option key={o} value={o}>
                          {o}
                        </Select.Option>
                      ))}
                    </Select>
                  ) : (
                    <TextInput block value={value} onChange={(e) => set(e.target.value)} type={input.type === 'number' ? 'number' : 'text'} />
                  )}
                </FormControl>
              )
            })
          )}
          {error && <div className="error-box mt-2">{error}</div>}
        </Dialog>
      )}
    </>
  )
}
