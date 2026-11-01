// Pure helpers behind the repository settings pages (General, Collaborators, Branches, Rulesets, Webhooks, Deploy keys, Actions secrets and variables).

export interface CommitChoice {
  id: string
  label: string
  title: string
  message: string
}

/** github.com's "Default commit message" choices for merge commits, and the API title/message pair each stands for. */
export const MERGE_COMMIT_CHOICES: CommitChoice[] = [
  { id: 'default', label: 'Default message', title: 'MERGE_MESSAGE', message: 'PR_TITLE' },
  { id: 'title', label: 'Pull request title', title: 'PR_TITLE', message: 'BLANK' },
  { id: 'title-description', label: 'Pull request title and description', title: 'PR_TITLE', message: 'PR_BODY' },
]

export const SQUASH_COMMIT_CHOICES: CommitChoice[] = [
  { id: 'default', label: 'Default message', title: 'COMMIT_OR_PR_TITLE', message: 'COMMIT_MESSAGES' },
  { id: 'title', label: 'Pull request title', title: 'PR_TITLE', message: 'BLANK' },
  { id: 'title-commits', label: 'Pull request title and commit details', title: 'PR_TITLE', message: 'COMMIT_MESSAGES' },
  { id: 'title-description', label: 'Pull request title and description', title: 'PR_TITLE', message: 'PR_BODY' },
]

/** The choice a title/message pair stands for; pairs github.com has no option for (set through the API) read as the default. */
export function commitChoiceFor(choices: CommitChoice[], title?: string | null, message?: string | null): CommitChoice {
  return choices.find((c) => c.title === title && c.message === message) ?? choices[0]
}

export type MergeMethod = 'allow_merge_commit' | 'allow_squash_merge' | 'allow_rebase_merge'

/** github.com keeps at least one merge method enabled: the last checked one can't be unchecked. */
export function isLastMergeMethod(state: Record<MergeMethod, boolean | undefined>, method: MergeMethod) {
  const enabled = (Object.keys(state) as MergeMethod[]).filter((m) => state[m])
  return enabled.length === 1 && enabled[0] === method
}

// ---------------------------------------------------------------------------
// Topics

export const MAX_TOPICS = 20

/** github.com: lowercase letters, numbers and hyphens, starting with a letter or number, at most 50 characters. */
export function isValidTopic(topic: string) {
  return /^[a-z0-9][a-z0-9-]{0,49}$/.test(topic)
}

/**
 * Adds the topics typed into the topics field (separated by spaces or commas, as github.com takes them) to the
 * current list. Duplicates are dropped; invalid entries and those past the 20-topic limit come back as `rejected`.
 */
export function addTopics(current: string[], typed: string): { topics: string[]; rejected: string[] } {
  const topics = [...current]
  const rejected: string[] = []
  for (const raw of typed.split(/[\s,]+/)) {
    const t = raw.trim().toLowerCase()
    if (!t || topics.includes(t)) continue
    if (!isValidTopic(t) || topics.length >= MAX_TOPICS) rejected.push(t)
    else topics.push(t)
  }
  return { topics, rejected }
}

export function sameTopics(a: string[], b: string[]) {
  return a.length === b.length && a.every((t) => b.includes(t))
}

/** Octokit's GraphQL errors read "Request failed due to following response errors:\n - <message>"; keep the messages. */
export function stripGraphqlPreamble(message: string) {
  return message
    .replace(/^Request failed due to following response errors:\s*/, '')
    .replace(/^\s*-\s*/gm, '')
    .trim()
}

/** "Upgrade to GitHub Pro or make this repository public to enable this feature." and its organization variants. */
export function isUpgradeMessage(message: string) {
  return /upgrade to github/i.test(message)
}

/** Typed confirmations (danger zone, rename) must match exactly, ignoring surrounding whitespace. */
export function confirmationMatches(typed: string, expected: string) {
  return typed.trim() === expected
}

/** GitHub turns anything but letters, digits, '.', '-' and '_' in a repository name into '-'. */
export function sanitizeRepoName(name: string) {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-')
}

// ---------------------------------------------------------------------------
// Collaborators

export type RepoRole = 'read' | 'triage' | 'write' | 'maintain' | 'admin'

/** The roles github.com offers when adding people to an organization repository, with its descriptions. */
export const REPO_ROLES: Array<{ id: RepoRole; label: string; description: string }> = [
  { id: 'read', label: 'Read', description: 'Recommended for non-code contributors who want to view or discuss your project' },
  { id: 'triage', label: 'Triage', description: 'Recommended for contributors who need to manage issues and pull requests without write access' },
  { id: 'write', label: 'Write', description: 'Recommended for contributors who actively push to your project' },
  { id: 'maintain', label: 'Maintain', description: 'Recommended for project managers who need to manage the repository without access to sensitive or destructive actions' },
  { id: 'admin', label: 'Admin', description: 'Recommended for people who need full access to the project, including sensitive and destructive actions like managing security or deleting a repository' },
]

/** Collaborators report `role_name` (read/write/…), invitations `permissions`, and older payloads pull/push: one label for all. */
export function roleLabel(role: string | null | undefined) {
  const r = (role ?? '').toLowerCase()
  const id = r === 'pull' ? 'read' : r === 'push' ? 'write' : r
  return REPO_ROLES.find((x) => x.id === id)?.label ?? (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Read')
}

export function roleId(role: string | null | undefined): RepoRole {
  const label = roleLabel(role)
  return REPO_ROLES.find((x) => x.label === label)?.id ?? 'read'
}

/** PUT /collaborators takes the old permission names for the built-in roles. */
export function collaboratorPermission(role: RepoRole) {
  return role === 'read' ? 'pull' : role === 'write' ? 'push' : role
}

/** The "Direct access" box on github.com's Collaborators page. */
export function directAccessSummary(collaborators: number, invitations: number, ownerIsUser: boolean) {
  const who = collaborators === 1 ? '1 collaborator has' : `${collaborators} collaborators have`
  const invites = invitations ? ` ${invitations === 1 ? '1 invitation is' : `${invitations} invitations are`} pending.` : ''
  const tail = collaborators === 0 && ownerIsUser ? ' Only you can contribute to this repository.' : ''
  return `${who} access to this repository.${invites}${tail}`
}

// ---------------------------------------------------------------------------
// Classic branch protection rules

/** The fields gi-ui reads and writes on a BranchProtectionRule (GraphQL). */
export const PROTECTION_RULE_FIELDS = `id databaseId pattern
  requiresApprovingReviews requiredApprovingReviewCount dismissesStaleReviews requiresCodeOwnerReviews requireLastPushApproval
  requiresStatusChecks requiresStrictStatusChecks requiredStatusCheckContexts
  requiresConversationResolution requiresCommitSignatures requiresLinearHistory lockBranch isAdminEnforced
  allowsForcePushes allowsDeletions matchingRefs(first: 1) { totalCount }`

export interface ProtectionRule {
  id: string
  databaseId: number | null
  pattern: string
  requiresApprovingReviews: boolean
  requiredApprovingReviewCount: number | null
  dismissesStaleReviews: boolean
  requiresCodeOwnerReviews: boolean
  requireLastPushApproval: boolean
  requiresStatusChecks: boolean
  requiresStrictStatusChecks: boolean
  requiredStatusCheckContexts: Array<string | null> | null
  requiresConversationResolution: boolean
  requiresCommitSignatures: boolean
  requiresLinearHistory: boolean
  lockBranch: boolean
  isAdminEnforced: boolean
  allowsForcePushes: boolean
  allowsDeletions: boolean
  matchingRefs: { totalCount: number }
}

/** The rule form, shaped like github.com's checkboxes rather than the API fields. */
export interface ProtectionForm {
  pattern: string
  requirePullRequest: boolean
  requireApprovals: boolean
  approvalCount: number
  dismissStale: boolean
  requireCodeOwners: boolean
  requireLastPush: boolean
  requireStatusChecks: boolean
  strictStatusChecks: boolean
  statusChecks: string[]
  requireConversationResolution: boolean
  requireSignedCommits: boolean
  requireLinearHistory: boolean
  lockBranch: boolean
  enforceAdmins: boolean
  allowForcePushes: boolean
  allowDeletions: boolean
}

export const EMPTY_PROTECTION_FORM: ProtectionForm = {
  pattern: '',
  requirePullRequest: false,
  requireApprovals: true,
  approvalCount: 1,
  dismissStale: false,
  requireCodeOwners: false,
  requireLastPush: false,
  requireStatusChecks: false,
  strictStatusChecks: false,
  statusChecks: [],
  requireConversationResolution: false,
  requireSignedCommits: false,
  requireLinearHistory: false,
  lockBranch: false,
  enforceAdmins: false,
  allowForcePushes: false,
  allowDeletions: false,
}

export function protectionFormFromRule(rule: ProtectionRule): ProtectionForm {
  const count = rule.requiredApprovingReviewCount ?? 0
  return {
    pattern: rule.pattern,
    requirePullRequest: rule.requiresApprovingReviews,
    // A pull request rule with 0 required approvals is "Require a pull request" without "Require approvals".
    requireApprovals: !rule.requiresApprovingReviews || count > 0,
    approvalCount: Math.max(1, count),
    dismissStale: rule.dismissesStaleReviews,
    requireCodeOwners: rule.requiresCodeOwnerReviews,
    requireLastPush: rule.requireLastPushApproval,
    requireStatusChecks: rule.requiresStatusChecks,
    strictStatusChecks: rule.requiresStrictStatusChecks,
    statusChecks: (rule.requiredStatusCheckContexts ?? []).filter((c): c is string => !!c),
    requireConversationResolution: rule.requiresConversationResolution,
    requireSignedCommits: rule.requiresCommitSignatures,
    requireLinearHistory: rule.requiresLinearHistory,
    lockBranch: rule.lockBranch,
    enforceAdmins: rule.isAdminEnforced,
    allowForcePushes: rule.allowsForcePushes,
    allowDeletions: rule.allowsDeletions,
  }
}

/** The create/updateBranchProtectionRule input for a form; options under an unchecked parent are sent switched off. */
export function protectionInput(form: ProtectionForm) {
  const pr = form.requirePullRequest
  const checks = form.requireStatusChecks
  return {
    pattern: form.pattern.trim(),
    requiresApprovingReviews: pr,
    requiredApprovingReviewCount: pr && form.requireApprovals ? form.approvalCount : 0,
    dismissesStaleReviews: pr && form.dismissStale,
    requiresCodeOwnerReviews: pr && form.requireCodeOwners,
    requireLastPushApproval: pr && form.requireLastPush,
    requiresStatusChecks: checks,
    requiresStrictStatusChecks: checks && form.strictStatusChecks,
    requiredStatusCheckContexts: checks ? form.statusChecks : [],
    requiresConversationResolution: form.requireConversationResolution,
    requiresCommitSignatures: form.requireSignedCommits,
    requiresLinearHistory: form.requireLinearHistory,
    lockBranch: form.lockBranch,
    isAdminEnforced: form.enforceAdmins,
    allowsForcePushes: form.allowForcePushes,
    allowsDeletions: form.allowDeletions,
  }
}

// ---------------------------------------------------------------------------
// Rulesets

export const ENFORCEMENT_LABEL: Record<string, string> = { active: 'Active', evaluate: 'Evaluate', disabled: 'Disabled' }

/** Ruleset ref conditions as github.com lists them: "Default", "All branches", or the patterns without refs/heads/. */
export function describeRefConditions(target: string | undefined, include: string[] = [], exclude: string[] = []) {
  const all = target === 'tag' ? 'All tags' : 'All branches'
  const name = (p: string) => (p === '~DEFAULT_BRANCH' ? 'Default' : p === '~ALL' ? all : p.replace(/^refs\/(heads|tags)\//, ''))
  const parts = include.map(name)
  const excluded = exclude.map(name)
  if (!parts.length && !excluded.length) return ''
  return `${parts.join(', ') || 'Nothing'}${excluded.length ? ` (excluding ${excluded.join(', ')})` : ''}`
}

// ---------------------------------------------------------------------------
// Webhooks

/** The individual events github.com offers under "Let me select individual events.", in its (alphabetical) order. */
export const WEBHOOK_EVENTS: Array<{ id: string; label: string; description: string }> = [
  { id: 'branch_protection_rule', label: 'Branch protection rules', description: 'Branch protection rule created, deleted or edited.' },
  { id: 'create', label: 'Branch or tag creation', description: 'Branch or tag created.' },
  { id: 'delete', label: 'Branch or tag deletion', description: 'Branch or tag deleted.' },
  { id: 'check_run', label: 'Check runs', description: 'Check run is created, requested, rerequested, or completed.' },
  { id: 'check_suite', label: 'Check suites', description: 'Check suite is requested, rerequested, or completed.' },
  { id: 'member', label: 'Collaborator add, remove, or changed', description: 'Collaborator added to, removed from, or has changed permissions for a repository.' },
  { id: 'commit_comment', label: 'Commit comments', description: 'Commit or diff commented on.' },
  { id: 'deployment_status', label: 'Deployment statuses', description: 'Deployment status updated from the API.' },
  { id: 'deployment', label: 'Deployments', description: 'Repository was deployed.' },
  { id: 'discussion_comment', label: 'Discussion comments', description: 'Discussion comment created, edited, or deleted.' },
  { id: 'discussion', label: 'Discussions', description: 'Discussion created, edited, pinned, unpinned, locked, unlocked, transferred, answered, unanswered, labeled, unlabeled, had its category changed, or was deleted.' },
  { id: 'fork', label: 'Forks', description: 'Repository forked.' },
  { id: 'issue_comment', label: 'Issue comments', description: 'Issue comment created, edited, or deleted.' },
  { id: 'issues', label: 'Issues', description: 'Issue opened, edited, deleted, transferred, pinned, unpinned, closed, reopened, assigned, unassigned, labeled, unlabeled, milestoned, demilestoned, locked, or unlocked.' },
  { id: 'label', label: 'Labels', description: 'Label created, edited or deleted.' },
  { id: 'milestone', label: 'Milestones', description: 'Milestone created, closed, opened, edited, or deleted.' },
  { id: 'page_build', label: 'Page builds', description: 'Pages site built.' },
  { id: 'pull_request_review_comment', label: 'Pull request review comments', description: 'Pull request diff comment created, edited, or deleted.' },
  { id: 'pull_request_review_thread', label: 'Pull request review threads', description: 'A pull request review thread was resolved or unresolved.' },
  { id: 'pull_request_review', label: 'Pull request reviews', description: 'Pull request review submitted, edited, or dismissed.' },
  {
    id: 'pull_request',
    label: 'Pull requests',
    description:
      'Pull request assigned, auto merge disabled, auto merge enabled, closed, converted to draft, demilestoned, dequeued, edited, enqueued, labeled, locked, milestoned, opened, ready for review, reopened, review request removed, review requested, synchronized, unassigned, unlabeled, or unlocked.',
  },
  { id: 'push', label: 'Pushes', description: 'Git push to a repository.' },
  { id: 'release', label: 'Releases', description: 'Release created, edited, published, unpublished, or deleted.' },
  { id: 'star', label: 'Stars', description: 'A star is created or deleted from a repository.' },
  { id: 'status', label: 'Statuses', description: 'Commit status updated from the API.' },
  { id: 'public', label: 'Visibility changes', description: 'Repository changes from private to public.' },
  { id: 'watch', label: 'Watches', description: 'User stars a repository.' },
  { id: 'gollum', label: 'Wiki', description: 'Wiki page updated.' },
  { id: 'workflow_job', label: 'Workflow jobs', description: 'Workflow job queued, waiting, in progress, or completed on a repository.' },
  { id: 'workflow_run', label: 'Workflow runs', description: 'Workflow run requested or completed on a repository.' },
]

export type WebhookEventChoice = 'push' | 'all' | 'custom'

export interface WebhookForm {
  url: string
  contentType: 'form' | 'json'
  /** null keeps the saved secret (edit page); a string replaces it ('' removes it). */
  secret: string | null
  insecureSsl: boolean
  eventChoice: WebhookEventChoice
  events: string[]
  active: boolean
}

export const EMPTY_WEBHOOK_FORM: WebhookForm = { url: '', contentType: 'form', secret: '', insecureSsl: false, eventChoice: 'push', events: ['push'], active: true }

export interface WebhookLike {
  active: boolean
  events: string[]
  config: { url?: string; content_type?: string; insecure_ssl?: string | number; secret?: string }
}

/** The form for a saved hook. github.com's radios: exactly ["push"] is "Just the push event", ["*"] is "Send me everything". */
export function webhookFormFromHook(hook: WebhookLike): WebhookForm {
  const events = hook.events
  const eventChoice: WebhookEventChoice = events.includes('*') ? 'all' : events.length === 1 && events[0] === 'push' ? 'push' : 'custom'
  return {
    url: hook.config.url ?? '',
    contentType: hook.config.content_type === 'json' ? 'json' : 'form',
    secret: null,
    insecureSsl: String(hook.config.insecure_ssl ?? '0') === '1',
    eventChoice,
    events: events.filter((e) => e !== '*'),
    active: hook.active,
  }
}

/** The events a form subscribes to; individual events keep ones gi-ui doesn't list (set through the API). */
export function webhookEvents(form: WebhookForm) {
  if (form.eventChoice === 'all') return ['*']
  if (form.eventChoice === 'push') return ['push']
  return [...new Set(form.events)]
}

/** create/updateWebhook config for a form. The secret is left out while unchanged, so the saved one stays. */
export function webhookConfig(form: WebhookForm) {
  return {
    url: form.url.trim(),
    content_type: form.contentType,
    insecure_ssl: form.insecureSsl ? '1' : '0',
    ...(form.secret !== null ? { secret: form.secret } : {}),
  }
}

/** The events in parentheses after a hook's URL on github.com's list: "push", "all events", "issues and push", "5 events". */
export function webhookEventsSummary(events: string[]) {
  if (events.includes('*')) return 'all events'
  if (events.length === 0) return 'no events'
  if (events.length === 1) return events[0]
  if (events.length === 2) return `${events[0]} and ${events[1]}`
  return `${events.length} events`
}

export type WebhookStatus = 'inactive' | 'never' | 'success' | 'failure'

/** A hook's state for the list icon, from its last_response ({ code: null, status: "unused" } before any delivery). */
export function webhookStatus(active: boolean, last: { code: number | null; status: string | null } | null | undefined): WebhookStatus {
  if (!active) return 'inactive'
  if (!last || last.code == null || last.status === 'unused') return 'never'
  return last.code >= 200 && last.code < 300 ? 'success' : 'failure'
}

/** Payload URLs github.com accepts: absolute http(s) URLs. */
export function isValidPayloadUrl(url: string) {
  try {
    const u = new URL(url.trim())
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/** Pretty-prints a delivery's JSON payload or body; anything else is shown as sent. */
export function formatPayload(payload: unknown) {
  if (payload == null) return ''
  if (typeof payload === 'string') {
    try {
      return JSON.stringify(JSON.parse(payload), null, 2)
    } catch {
      return payload
    }
  }
  return JSON.stringify(payload, null, 2)
}

/** HTTP headers as "Name: value" lines, as the Recent Deliveries view shows them. */
export function formatHeaders(headers: Record<string, unknown> | null | undefined) {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Deploy keys

/** The base64 key blob of an OpenSSH public key line ("ssh-ed25519 AAAA… comment"), or null when it isn't one. */
export function sshKeyBlob(key: string): { type: string; blob: string } | null {
  const m = key.trim().match(/^((?:sk-)?(?:ssh|ecdsa)-[\w@.-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/)
  return m ? { type: m[1], blob: m[2] } : null
}

/** OpenSSH's SHA256 fingerprint ("SHA256:…", unpadded base64), which github.com lists under each key. */
export async function sshFingerprint(key: string) {
  const parsed = sshKeyBlob(key)
  if (!parsed) return null
  const bin = atob(parsed.blob)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let s = ''
  for (const b of digest) s += String.fromCharCode(b)
  return `SHA256:${btoa(s).replace(/=+$/, '')}`
}

/** github.com's "Last used within the last …" wording for a key (null last_used: "Never used"). */
export function keyLastUsed(lastUsed: string | null | undefined, now = Date.now()) {
  if (!lastUsed) return 'Never used'
  const days = (now - new Date(lastUsed).getTime()) / 86_400_000
  if (days <= 7) return 'Last used within the last week'
  if (days <= 30) return `Last used within the last ${Math.ceil(days / 7)} weeks`
  if (days <= 365) return `Last used within the last ${Math.ceil(days / 30)} months`
  return 'Last used more than a year ago'
}

// ---------------------------------------------------------------------------
// Actions secrets and variables

/**
 * GitHub's naming rules for secrets and variables (names are stored uppercase): letters, numbers and underscores, not
 * starting with a number or the GITHUB_ prefix. Returns the problem, or null for a valid name.
 */
export function actionsNameError(name: string, kind: 'secret' | 'variable') {
  const n = name.trim()
  if (!n) return null
  if (/\s/.test(n)) return `${kind === 'secret' ? 'Secret' : 'Variable'} names can only contain alphanumeric characters ([a-z], [A-Z], [0-9]) or underscores (_). Spaces are not allowed.`
  if (!/^[A-Za-z0-9_]+$/.test(n)) return `${kind === 'secret' ? 'Secret' : 'Variable'} names can only contain alphanumeric characters ([a-z], [A-Z], [0-9]) or underscores (_).`
  if (/^[0-9]/.test(n)) return `${kind === 'secret' ? 'Secret' : 'Variable'} names cannot start with a number.`
  if (/^GITHUB_/i.test(n)) return `${kind === 'secret' ? 'Secret' : 'Variable'} names must not start with GITHUB_.`
  return null
}

/** The name as GitHub stores it. */
export function normalizeActionsName(name: string) {
  return name.trim().toUpperCase()
}
