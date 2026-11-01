import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Banner, BranchName, Button, Checkbox, Dialog, FormControl, IconButton, Select, TextInput, useConfirm } from '@primer/react'
import { ArrowSwitchIcon, EyeIcon, PencilIcon, RepoIcon, StarIcon, TriangleDownIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage, type Repo } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { compactNumber } from '../../../lib/format'
import {
  MERGE_COMMIT_CHOICES,
  SQUASH_COMMIT_CHOICES,
  commitChoiceFor,
  confirmationMatches,
  isLastMergeMethod,
  sanitizeRepoName,
  type MergeMethod,
} from '../../../lib/repoSettings'
import { BranchPicker } from '../../../components/BranchPicker'
import { SaveStatus, SettingsSubhead, useRepoUpdate, useSaveState, type RepoPatch } from './common'

type BoolField =
  | 'is_template'
  | 'web_commit_signoff_required'
  | 'has_wiki'
  | 'has_issues'
  | 'has_discussions'
  | 'has_projects'
  | MergeMethod
  | 'allow_update_branch'
  | 'allow_auto_merge'
  | 'delete_branch_on_merge'

/**
 * A github.com settings checkbox: saves as soon as it is toggled, showing a spinner and then a check. `locked` disables
 * it (the last enabled merge method can't be turned off).
 */
function SettingCheckbox({ field, label, caption, locked, children }: { field: BoolField; label: string; caption?: ReactNode; locked?: boolean; children?: ReactNode }) {
  const { data } = useRepo()
  const update = useRepoUpdate()
  const [state, run] = useSaveState()
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checked = pending ?? !!data[field]
  const toggle = async (next: boolean) => {
    setPending(next)
    setError(null)
    try {
      const saved = await run(() => update({ [field]: next }))
      // GitHub answers 200 but keeps features the plan lacks (e.g. wikis on a private GitHub Free repository) off.
      if (!!saved[field] !== next) setError(`GitHub kept this setting ${next ? 'off' : 'on'}. The repository’s plan or visibility may not allow changing it.`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="settings-checkbox">
      <FormControl disabled={locked}>
        <Checkbox checked={checked} onChange={(e) => void toggle(e.target.checked)} />
        <FormControl.Label>
          {label}
          <SaveStatus state={state} />
        </FormControl.Label>
        {caption && <FormControl.Caption>{caption}</FormControl.Caption>}
      </FormControl>
      {error && <div className="fg-danger text-small settings-indent">{error}</div>}
      {children && <div className="settings-indent">{children}</div>}
    </div>
  )
}

export function GeneralSettings() {
  return (
    <>
      <SettingsSubhead title="General" />
      <RepositoryName />
      <SettingCheckbox
        field="is_template"
        label="Template repository"
        caption="Template repositories let users generate new repositories with the same directory structure and files."
      />
      <SettingCheckbox
        field="web_commit_signoff_required"
        label="Require contributors to sign off on web-based commits"
        caption="Enabling this setting will require contributors to sign off on commits made through GitHub’s web interface. Signing off is a way for contributors to affirm that their commit complies with the repository's terms, commonly the Developer Certificate of Origin (DCO)."
      />
      <DefaultBranch />
      <Features />
      <PullRequests />
      <DangerZone />
    </>
  )
}

function RepositoryName() {
  const { data } = useRepo()
  const update = useRepoUpdate()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [name, setName] = useState(data.name)
  const [error, setError] = useState<string | null>(null)
  const next = sanitizeRepoName(name)
  const rename = useMutation({
    mutationFn: () => update({ name: next }),
    onSuccess: (r) => navigate(`/${r.owner.login}/${r.name}/settings`, { replace: true }),
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <div className="settings-field">
      <FormControl>
        <FormControl.Label>Repository name</FormControl.Label>
        <div className="settings-inline-field">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} aria-describedby="rename-note" />
          <Button
            disabled={!next || next === data.name || rename.isPending}
            onClick={async () => {
              setError(null)
              const ok = await confirm({
                title: 'Rename this repository?',
                content: (
                  <>
                    <p className="settings-dialog-lead">
                      <strong>{data.name}</strong> will be renamed to <strong>{next}</strong>.
                    </p>
                    <p className="settings-dialog-tail">GitHub redirects web traffic and Git operations from the old name, but you should point local clones at the new URL.</p>
                  </>
                ),
                confirmButtonContent: 'I understand, rename this repository',
                confirmButtonType: 'danger',
                width: 'large',
              })
              if (ok) rename.mutate()
            }}
          >
            Rename
          </Button>
        </div>
        {next !== name.trim() && next && <FormControl.Caption id="rename-note">Your repository will be renamed to {next}.</FormControl.Caption>}
      </FormControl>
      {error && <div className="fg-danger text-small mt-1">{error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function DefaultBranch() {
  const { data } = useRepo()
  const [dialog, setDialog] = useState<'switch' | 'rename' | null>(null)
  return (
    <>
      <SettingsSubhead title="Default branch" spacious />
      <p className="settings-text">
        The default branch is considered the “base” branch in your repository, against which all pull requests and code commits are automatically made, unless you specify a different branch.
      </p>
      <div className="settings-default-branch">
        <BranchName as="span">{data.default_branch}</BranchName>
        <span className="ml-auto flex-center gap-1">
          <IconButton icon={PencilIcon} variant="invisible" aria-label="Rename branch" description="Rename branch" onClick={() => setDialog('rename')} />
          <IconButton icon={ArrowSwitchIcon} variant="invisible" aria-label="Switch to another branch" description="Switch to another branch" onClick={() => setDialog('switch')} />
        </span>
      </div>
      {dialog === 'switch' && <SwitchDefaultBranchDialog onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameDefaultBranchDialog onClose={() => setDialog(null)} />}
    </>
  )
}

function SwitchDefaultBranchDialog({ onClose }: { onClose(): void }) {
  const { owner, repo, data } = useRepo()
  const update = useRepoUpdate()
  const [branch, setBranch] = useState(data.default_branch)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => update({ default_branch: branch }),
    onSuccess: onClose,
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <Dialog
      title={confirming ? 'Update default branch' : 'Switch default branch to another branch'}
      onClose={onClose}
      footerButtons={
        confirming
          ? [{ content: 'I understand, update the default branch.', buttonType: 'danger', onClick: () => save.mutate(), disabled: save.isPending }]
          : [{ content: 'Update', buttonType: 'primary', onClick: () => setConfirming(true), disabled: branch === data.default_branch }]
      }
    >
      {confirming ? (
        <Banner variant="warning" hideTitle title="Warning" description="Changing your default branch can have unintended consequences that can affect new pull requests and clones." />
      ) : (
        <>
          <p className="settings-dialog-lead">
            Choose another branch to use as the default branch of <strong>{repo}</strong> instead of <strong>{data.default_branch}</strong>.
          </p>
          <BranchPicker owner={owner} repo={repo} value={branch} onChange={setBranch} includeTags={false} defaultBranch={data.default_branch} />
        </>
      )}
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}

function RenameDefaultBranchDialog({ onClose }: { onClose(): void }) {
  const { owner, repo, data } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const [name, setName] = useState(data.default_branch)
  const [error, setError] = useState<string | null>(null)
  const next = name.trim()
  const rename = useMutation({
    mutationFn: async () => octokit.rest.repos.renameBranch({ owner, repo, branch: data.default_branch, new_name: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [key] })
      onClose()
    },
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <Dialog
      title="Rename default branch"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: 'Rename branch', buttonType: 'primary', onClick: () => rename.mutate(), disabled: !next || next === data.default_branch || rename.isPending },
      ]}
    >
      <FormControl>
        <FormControl.Label>Rename {data.default_branch} to:</FormControl.Label>
        <TextInput block className="text-mono" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '-'))} autoFocus />
      </FormControl>
      <p className="text-small fg-muted settings-dialog-tail">
        Renaming this branch retargets open pull requests and updates branch protection rules that explicitly target it. It will not update your members’ local environments.
      </p>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------

function Features() {
  return (
    <>
      <SettingsSubhead title="Features" spacious />
      <SettingCheckbox field="has_wiki" label="Wikis" caption="Wikis host documentation for your repository." />
      <SettingCheckbox
        field="has_issues"
        label="Issues"
        caption="Issues integrate lightweight task tracking into your repository. Keep projects on track with issue labels and milestones, and reference them in commit messages."
      />
      <SettingCheckbox
        field="has_discussions"
        label="Discussions"
        caption="Discussions is the space for your community to have conversations, ask questions and post answers without opening an issue."
      />
      <SettingCheckbox
        field="has_projects"
        label="Projects"
        caption="Projects on GitHub are created at the repository owner's level (organization or user) and can be linked to a repository's Projects tab. Projects are suitable for cross-repository development efforts such as feature work, complex product roadmaps or even Issue triage."
      />
    </>
  )
}

function CommitMessageSelect({ kind, enabled }: { kind: 'merge' | 'squash'; enabled: boolean }) {
  const { data } = useRepo()
  const update = useRepoUpdate()
  const [state, run] = useSaveState()
  const [error, setError] = useState<string | null>(null)
  const choices = kind === 'merge' ? MERGE_COMMIT_CHOICES : SQUASH_COMMIT_CHOICES
  const current = kind === 'merge' ? commitChoiceFor(choices, data.merge_commit_title, data.merge_commit_message) : commitChoiceFor(choices, data.squash_merge_commit_title, data.squash_merge_commit_message)
  const save = async (id: string) => {
    const c = choices.find((x) => x.id === id)
    if (!c) return
    const patch = (kind === 'merge' ? { merge_commit_title: c.title, merge_commit_message: c.message } : { squash_merge_commit_title: c.title, squash_merge_commit_message: c.message }) as RepoPatch
    setError(null)
    try {
      await run(() => update(patch))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <FormControl disabled={!enabled}>
      <FormControl.Label>
        Default commit message
        <SaveStatus state={state} />
      </FormControl.Label>
      <FormControl.Caption>Presented when merging a pull request with {kind}.</FormControl.Caption>
      <Select value={current.id} onChange={(e) => void save(e.target.value)}>
        {choices.map((c) => (
          <Select.Option key={c.id} value={c.id}>
            {c.label}
          </Select.Option>
        ))}
      </Select>
      {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
    </FormControl>
  )
}

function PullRequests() {
  const { data } = useRepo()
  const methods = { allow_merge_commit: data.allow_merge_commit, allow_squash_merge: data.allow_squash_merge, allow_rebase_merge: data.allow_rebase_merge }
  const locked = (m: MergeMethod) => isLastMergeMethod(methods, m)
  return (
    <>
      <SettingsSubhead title="Pull Requests" spacious />
      <p className="settings-text">
        When merging pull requests, you can allow any combination of merge commits, squashing, or rebasing. At least one option must be enabled. If you have linear history requirement enabled on any protected branch, you must enable squashing or rebasing.
      </p>
      <div className="Box settings-merge-box">
        <div className="Box-row">
          <SettingCheckbox field="allow_merge_commit" label="Allow merge commits" caption="Add all commits from the head branch to the base branch with a merge commit." locked={locked('allow_merge_commit')}>
            <CommitMessageSelect kind="merge" enabled={!!data.allow_merge_commit} />
          </SettingCheckbox>
        </div>
        <div className="Box-row">
          <SettingCheckbox field="allow_squash_merge" label="Allow squash merging" caption="Combine all commits from the head branch into a single commit in the base branch." locked={locked('allow_squash_merge')}>
            <CommitMessageSelect kind="squash" enabled={!!data.allow_squash_merge} />
          </SettingCheckbox>
        </div>
        <div className="Box-row">
          <SettingCheckbox field="allow_rebase_merge" label="Allow rebase merging" caption="Add all commits from the head branch onto the base branch individually." locked={locked('allow_rebase_merge')} />
        </div>
      </div>
      <p className="settings-text spaced">Control how and when users are prompted to update their branches if there is a new commit on the base branch.</p>
      <SettingCheckbox
        field="allow_update_branch"
        label="Always suggest updating pull request branches"
        caption="Whenever there are new changes available in the base branch, present an “update branch” option in the pull request."
      />
      <p className="settings-text spaced">You can allow setting pull requests to merge automatically once all required reviews and status checks have passed.</p>
      <SettingCheckbox field="allow_auto_merge" label="Allow auto-merge" caption="Waits for merge requirements to be met and then merges automatically." />
      <p className="settings-text spaced">After pull requests are merged, you can have head branches deleted automatically.</p>
      <SettingCheckbox field="delete_branch_on_merge" label="Automatically delete head branches" caption="Deleted branches will still be able to be restored." />
    </>
  )
}

// ---------------------------------------------------------------------------
// Danger Zone

type DangerAction = 'public' | 'private' | 'archive' | 'unarchive' | 'transfer' | 'delete'

function DangerZone() {
  const { data } = useRepo()
  const [action, setAction] = useState<DangerAction | null>(null)
  const visibility = data.visibility ?? (data.private ? 'private' : 'public')
  const row = (title: string, text: ReactNode, button: ReactNode) => (
    <div className="Box-row danger-zone-row">
      <div className="flex-1">
        <strong>{title}</strong>
        <p className="danger-zone-text">{text}</p>
      </div>
      {button}
    </div>
  )
  return (
    <>
      <SettingsSubhead title="Danger Zone" spacious danger id="danger-zone" />
      <div className="Box danger-zone">
        {row(
          'Change repository visibility',
          `This repository is currently ${visibility}.`,
          <ActionMenu>
            <ActionMenu.Anchor>
              <Button variant="danger" trailingVisual={TriangleDownIcon} disabled={data.archived}>
                Change visibility
              </Button>
            </ActionMenu.Anchor>
            <ActionMenu.Overlay width="auto" align="end">
              <ActionList>
                {visibility !== 'public' && <ActionList.Item onSelect={() => setAction('public')}>Change to public</ActionList.Item>}
                {visibility !== 'private' && <ActionList.Item onSelect={() => setAction('private')}>Change to private</ActionList.Item>}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>,
        )}
        {row(
          'Transfer ownership',
          'Transfer this repository to another user or to an organization where you have the ability to create repositories.',
          <Button variant="danger" onClick={() => setAction('transfer')}>
            Transfer
          </Button>,
        )}
        {data.archived
          ? row(
              'Unarchive this repository',
              'Mark this repository as unarchived and read-write.',
              <Button variant="danger" onClick={() => setAction('unarchive')}>
                Unarchive this repository
              </Button>,
            )
          : row(
              'Archive this repository',
              'Mark this repository archived and read-only.',
              <Button variant="danger" onClick={() => setAction('archive')}>
                Archive this repository
              </Button>,
            )}
        {row(
          'Delete this repository',
          'Once you delete a repository, there is no going back. Please be certain.',
          <Button variant="danger" onClick={() => setAction('delete')}>
            Delete this repository
          </Button>,
        )}
      </div>
      {(action === 'public' || action === 'private') && <VisibilityDialog to={action} onClose={() => setAction(null)} />}
      {(action === 'archive' || action === 'unarchive') && <ArchiveDialog archive={action === 'archive'} onClose={() => setAction(null)} />}
      {action === 'transfer' && <TransferDialog onClose={() => setAction(null)} />}
      {action === 'delete' && <DeleteDialog onClose={() => setAction(null)} />}
    </>
  )
}

/** The repository card github.com's danger dialogs open with: icon, full name, stars and watchers. */
function RepoCard({ data }: { data: Repo }) {
  return (
    <div className="danger-repo-card">
      <RepoIcon size={24} className="fg-muted" />
      <div className="text-bold text-large text-break">{data.full_name}</div>
      <div className="flex-center gap-3 fg-muted text-small">
        <span className="flex-center gap-1">
          <StarIcon /> {compactNumber(data.stargazers_count)} {data.stargazers_count === 1 ? 'star' : 'stars'}
        </span>
        <span className="flex-center gap-1">
          <EyeIcon /> {compactNumber(data.subscribers_count)} {data.subscribers_count === 1 ? 'watcher' : 'watchers'}
        </span>
      </div>
    </div>
  )
}

/**
 * github.com's three-step confirmation (delete, visibility): "I want to…", then the effects, then the full name typed
 * into a box before the final button.
 */
function SteppedDangerDialog({
  title,
  intent,
  effects,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string
  intent: string
  effects: ReactNode
  confirmLabel: string
  pending: boolean
  error: string | null
  onConfirm(): void
  onClose(): void
}) {
  const { data, fullName } = useRepo()
  const [step, setStep] = useState(1)
  const [typed, setTyped] = useState('')
  const matches = confirmationMatches(typed, fullName)
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width="large"
      renderFooter={() => (
        <Dialog.Footer className="danger-dialog-footer">
          {step === 1 && (
            <Button block onClick={() => setStep(2)}>
              {intent}
            </Button>
          )}
          {step === 2 && (
            <Button block onClick={() => setStep(3)}>
              I have read and understand these effects
            </Button>
          )}
          {step === 3 && (
            <Button block variant="danger" disabled={!matches || pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </Dialog.Footer>
      )}
    >
      <RepoCard data={data} />
      {step === 2 && <div className="danger-dialog-effects">{effects}</div>}
      {step === 3 && (
        <FormControl className="mt-3">
          <FormControl.Label>
            To confirm, type “{fullName}” in the box below
          </FormControl.Label>
          <TextInput block value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
        </FormControl>
      )}
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}

function VisibilityDialog({ to, onClose }: { to: 'public' | 'private'; onClose(): void }) {
  const { fullName } = useRepo()
  const update = useRepoUpdate()
  const [error, setError] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: () => update({ visibility: to }),
    onSuccess: onClose,
    onError: (e) => setError(errorMessage(e)),
  })
  const effects =
    to === 'public'
      ? ['The code will be visible to everyone who can visit GitHub.', 'Anyone can fork your repository.', 'All push rulesets will be disabled.', 'Your changes will be published as activity.', 'Actions history and logs will be visible to everyone.', 'Stars and watchers for this repository will be erased.']
      : ['Stars and watchers for this repository will be erased, which will affect repository rankings.', 'Dependency graph and Dependabot alerts will remain enabled with permission to perform read-only analysis on this repository.', 'Code scanning will become unavailable unless Code Security is enabled for this repository.', 'Current forks will remain public and will be detached from this repository.']
  return (
    <SteppedDangerDialog
      title={`Make ${fullName} ${to}`}
      intent={`I want to make this repository ${to}`}
      effects={
        <Banner
          variant="warning"
          title="Changing the visibility of this repository"
          description={
            <ul className="danger-effects-list">
              {effects.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          }
        />
      }
      confirmLabel={`Make this repository ${to}`}
      pending={change.isPending}
      error={error}
      onConfirm={() => change.mutate()}
      onClose={onClose}
    />
  )
}

function DeleteDialog({ onClose }: { onClose(): void }) {
  const { owner, repo, fullName } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const remove = useMutation({
    mutationFn: async () => octokit.rest.repos.delete({ owner, repo }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: [key, 'repo', owner, repo] })
      navigate(`/${owner}`, { replace: true })
    },
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <SteppedDangerDialog
      title={`Delete ${fullName}`}
      intent="I want to delete this repository"
      effects={
        <Banner
          variant="critical"
          title="Unexpected bad things will happen if you don’t read this!"
          description={`This will permanently delete the ${fullName} repository, wiki, issues, comments, packages, secrets, workflow runs, and remove all collaborator associations.`}
        />
      }
      confirmLabel="Delete this repository"
      pending={remove.isPending}
      error={error}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  )
}

function ArchiveDialog({ archive, onClose }: { archive: boolean; onClose(): void }) {
  const { data, fullName } = useRepo()
  const update = useRepoUpdate()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: () => update({ archived: archive }),
    onSuccess: onClose,
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <Dialog
      title={archive ? 'Archive repository' : 'Unarchive repository'}
      onClose={onClose}
      width="large"
      renderFooter={() => (
        <Dialog.Footer className="danger-dialog-footer">
          <Button block variant="danger" disabled={!confirmationMatches(typed, fullName) || change.isPending} onClick={() => change.mutate()}>
            {archive ? 'I understand the consequences, archive this repository' : 'I understand the consequences, unarchive this repository'}
          </Button>
        </Dialog.Footer>
      )}
    >
      <RepoCard data={data} />
      <Banner
        className="mt-3"
        variant="warning"
        title={archive ? 'This repository will become read-only.' : 'This will make this repository writable again.'}
        description={
          archive
            ? 'You will still be able to fork the repository and unarchive it at any time. Before you archive, consider updating repository settings, closing open issues and pull requests, and noting the archive in your README.'
            : 'Once unarchived, issues, pull requests, labels, milestones, projects, wiki, releases, commits, tags, branches, reactions and comments can be created and edited again.'
        }
      />
      <FormControl className="mt-3">
        <FormControl.Label>
          To confirm, type “{fullName}” in the box below
        </FormControl.Label>
        <TextInput block value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
      </FormControl>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}

function TransferDialog({ onClose }: { onClose(): void }) {
  const { owner, repo, data, fullName } = useRepo()
  const { octokit } = useGitHub()
  const navigate = useNavigate()
  const [newOwner, setNewOwner] = useState('')
  const [newName, setNewName] = useState(repo)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const transfer = useMutation({
    mutationFn: async () => octokit.rest.repos.transfer({ owner, repo, new_owner: newOwner.trim(), ...(newName.trim() && newName.trim() !== repo ? { new_name: sanitizeRepoName(newName) } : {}) }),
    onSuccess: () => navigate(`/${owner}`, { replace: true }),
    onError: (e) => setError(errorMessage(e)),
  })
  const ready = !!newOwner.trim() && newOwner.trim().toLowerCase() !== owner.toLowerCase() && confirmationMatches(typed, fullName)
  return (
    <Dialog
      title="Transfer repository"
      onClose={onClose}
      width="large"
      renderFooter={() => (
        <Dialog.Footer className="danger-dialog-footer">
          <Button block variant="danger" disabled={!ready || transfer.isPending} onClick={() => transfer.mutate()}>
            I understand, transfer this repository.
          </Button>
        </Dialog.Footer>
      )}
    >
      <RepoCard data={data} />
      <p className="settings-dialog-tail mt-3">
        Transferring may be delayed until the new owner approves the transfer. Collaborators, issues, pull requests, stars and the wiki move with the repository; GitHub redirects links to the old location.
      </p>
      <div className="settings-transfer-fields">
        <FormControl>
          <FormControl.Label>New owner</FormControl.Label>
          <TextInput block value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="Specify an organization or username" autoComplete="off" />
        </FormControl>
        <FormControl>
          <FormControl.Label>Repository name</FormControl.Label>
          <TextInput block value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" />
        </FormControl>
      </div>
      <FormControl className="mt-3">
        <FormControl.Label>Type {fullName} to confirm.</FormControl.Label>
        <TextInput block value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </FormControl>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
