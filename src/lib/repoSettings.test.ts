import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROTECTION_FORM,
  MERGE_COMMIT_CHOICES,
  SQUASH_COMMIT_CHOICES,
  addTopics,
  collaboratorPermission,
  commitChoiceFor,
  confirmationMatches,
  describeRefConditions,
  directAccessSummary,
  isLastMergeMethod,
  isUpgradeMessage,
  isValidTopic,
  protectionFormFromRule,
  protectionInput,
  roleId,
  roleLabel,
  sameTopics,
  sanitizeRepoName,
  stripGraphqlPreamble,
  type ProtectionRule,
  EMPTY_WEBHOOK_FORM,
  actionsNameError,
  formatHeaders,
  formatPayload,
  isValidPayloadUrl,
  keyLastUsed,
  normalizeActionsName,
  sshFingerprint,
  sshKeyBlob,
  webhookConfig,
  webhookEvents,
  webhookEventsSummary,
  webhookFormFromHook,
  webhookStatus,
  type WebhookLike,
} from './repoSettings'

describe('commit message choices', () => {
  it('maps API title/message pairs to github.com options', () => {
    expect(commitChoiceFor(MERGE_COMMIT_CHOICES, 'MERGE_MESSAGE', 'PR_TITLE').label).toBe('Default message')
    expect(commitChoiceFor(MERGE_COMMIT_CHOICES, 'PR_TITLE', 'PR_BODY').label).toBe('Pull request title and description')
    expect(commitChoiceFor(SQUASH_COMMIT_CHOICES, 'COMMIT_OR_PR_TITLE', 'COMMIT_MESSAGES').label).toBe('Default message')
    expect(commitChoiceFor(SQUASH_COMMIT_CHOICES, 'PR_TITLE', 'COMMIT_MESSAGES').label).toBe('Pull request title and commit details')
    expect(commitChoiceFor(SQUASH_COMMIT_CHOICES, 'PR_TITLE', 'BLANK').label).toBe('Pull request title')
  })
  it('falls back to the default for pairs without an option', () => {
    expect(commitChoiceFor(MERGE_COMMIT_CHOICES, 'MERGE_MESSAGE', 'BLANK').id).toBe('default')
    expect(commitChoiceFor(SQUASH_COMMIT_CHOICES, undefined, undefined).id).toBe('default')
  })
})

describe('isLastMergeMethod', () => {
  it('locks only the single remaining method', () => {
    const one = { allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false }
    expect(isLastMergeMethod(one, 'allow_squash_merge')).toBe(true)
    expect(isLastMergeMethod(one, 'allow_merge_commit')).toBe(false)
    expect(isLastMergeMethod({ ...one, allow_rebase_merge: true }, 'allow_squash_merge')).toBe(false)
  })
})

describe('topics', () => {
  it('validates github.com topic names', () => {
    expect(isValidTopic('react')).toBe(true)
    expect(isValidTopic('web-components2')).toBe(true)
    expect(isValidTopic('-leading')).toBe(false)
    expect(isValidTopic('Upper')).toBe(false)
    expect(isValidTopic('a'.repeat(51))).toBe(false)
  })
  it('splits on spaces and commas, lowercases and drops duplicates', () => {
    expect(addTopics(['react'], 'TypeScript, react  vite')).toEqual({ topics: ['react', 'typescript', 'vite'], rejected: [] })
    expect(addTopics([], 'ok bad_topic')).toEqual({ topics: ['ok'], rejected: ['bad_topic'] })
  })
  it('stops at 20 topics', () => {
    const full = Array.from({ length: 20 }, (_, i) => `t${i}`)
    expect(addTopics(full, 'one-more')).toEqual({ topics: full, rejected: ['one-more'] })
  })
  it('compares topic lists without order', () => {
    expect(sameTopics(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameTopics(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('confirmations and names', () => {
  it('requires the exact text', () => {
    expect(confirmationMatches(' acme/web ', 'acme/web')).toBe(true)
    expect(confirmationMatches('Acme/web', 'acme/web')).toBe(false)
  })
  it('sanitizes repository names like GitHub', () => {
    expect(sanitizeRepoName('my new repo!')).toBe('my-new-repo-')
    expect(sanitizeRepoName('ok.name_1')).toBe('ok.name_1')
  })
})

describe('API error messages', () => {
  it('keeps only the GraphQL error messages', () => {
    expect(stripGraphqlPreamble("Request failed due to following response errors:\n - Could not resolve to a node with the global id of 'X'")).toBe("Could not resolve to a node with the global id of 'X'")
    expect(stripGraphqlPreamble('Request failed due to following response errors:\n - one\n - two')).toBe('one\ntwo')
    expect(stripGraphqlPreamble('Not Found')).toBe('Not Found')
  })
  it('recognizes the plan upgrade answer', () => {
    expect(isUpgradeMessage('Upgrade to GitHub Pro or make this repository public to enable this feature.')).toBe(true)
    expect(isUpgradeMessage('Resource not accessible by integration')).toBe(false)
  })
})

describe('collaborator roles', () => {
  it('labels role names from every payload shape', () => {
    expect(roleLabel('write')).toBe('Write')
    expect(roleLabel('push')).toBe('Write')
    expect(roleLabel('pull')).toBe('Read')
    expect(roleLabel('admin')).toBe('Admin')
    expect(roleLabel('security-manager')).toBe('Security-manager')
    expect(roleId('push')).toBe('write')
  })
  it('sends the legacy permission names to the collaborators endpoint', () => {
    expect(collaboratorPermission('read')).toBe('pull')
    expect(collaboratorPermission('write')).toBe('push')
    expect(collaboratorPermission('maintain')).toBe('maintain')
  })
  it('summarizes direct access', () => {
    expect(directAccessSummary(0, 0, true)).toBe('0 collaborators have access to this repository. Only you can contribute to this repository.')
    expect(directAccessSummary(1, 2, true)).toBe('1 collaborator has access to this repository. 2 invitations are pending.')
  })
})

const rule = (over: Partial<ProtectionRule> = {}): ProtectionRule => ({
  id: 'BPR_1',
  databaseId: 1,
  pattern: 'main',
  requiresApprovingReviews: false,
  requiredApprovingReviewCount: 0,
  dismissesStaleReviews: false,
  requiresCodeOwnerReviews: false,
  requireLastPushApproval: false,
  requiresStatusChecks: false,
  requiresStrictStatusChecks: false,
  requiredStatusCheckContexts: [],
  requiresConversationResolution: false,
  requiresCommitSignatures: false,
  requiresLinearHistory: false,
  lockBranch: false,
  isAdminEnforced: false,
  allowsForcePushes: false,
  allowsDeletions: false,
  matchingRefs: { totalCount: 1 },
  ...over,
})

describe('branch protection form', () => {
  it('reads a pull request rule without approvals', () => {
    const form = protectionFormFromRule(rule({ requiresApprovingReviews: true, requiredApprovingReviewCount: 0 }))
    expect(form).toMatchObject({ requirePullRequest: true, requireApprovals: false, approvalCount: 1 })
    expect(protectionInput(form)).toMatchObject({ requiresApprovingReviews: true, requiredApprovingReviewCount: 0 })
  })
  it('round-trips a full rule', () => {
    const full = rule({
      pattern: 'release/*',
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 2,
      dismissesStaleReviews: true,
      requiresCodeOwnerReviews: true,
      requiresStatusChecks: true,
      requiresStrictStatusChecks: true,
      requiredStatusCheckContexts: ['test', null, 'lint'],
      requiresLinearHistory: true,
      allowsDeletions: true,
    })
    expect(protectionInput(protectionFormFromRule(full))).toEqual({
      pattern: 'release/*',
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 2,
      dismissesStaleReviews: true,
      requiresCodeOwnerReviews: true,
      requireLastPushApproval: false,
      requiresStatusChecks: true,
      requiresStrictStatusChecks: true,
      requiredStatusCheckContexts: ['test', 'lint'],
      requiresConversationResolution: false,
      requiresCommitSignatures: false,
      requiresLinearHistory: true,
      lockBranch: false,
      isAdminEnforced: false,
      allowsForcePushes: false,
      allowsDeletions: true,
    })
  })
  it('switches off options under an unchecked parent', () => {
    const input = protectionInput({ ...EMPTY_PROTECTION_FORM, pattern: ' gi-ui-test/* ', dismissStale: true, strictStatusChecks: true, statusChecks: ['ci'] })
    expect(input).toMatchObject({
      pattern: 'gi-ui-test/*',
      requiresApprovingReviews: false,
      requiredApprovingReviewCount: 0,
      dismissesStaleReviews: false,
      requiresStrictStatusChecks: false,
      requiredStatusCheckContexts: [],
    })
  })
})

describe('describeRefConditions', () => {
  it('names special targets and strips ref prefixes', () => {
    expect(describeRefConditions('branch', ['~DEFAULT_BRANCH', 'refs/heads/release/*'])).toBe('Default, release/*')
    expect(describeRefConditions('tag', ['~ALL'], ['refs/tags/tmp-*'])).toBe('All tags (excluding tmp-*)')
    expect(describeRefConditions('branch')).toBe('')
  })
})

describe('webhooks', () => {
  const hook = (events: string[], config: WebhookLike['config'] = { url: 'https://example.com/h', content_type: 'json', insecure_ssl: '0', secret: '********' }) => ({ active: true, events, config })

  it('reads github.com’s event radios from a hook', () => {
    expect(webhookFormFromHook(hook(['push'])).eventChoice).toBe('push')
    expect(webhookFormFromHook(hook(['*'])).eventChoice).toBe('all')
    const custom = webhookFormFromHook(hook(['issues', 'push']))
    expect(custom.eventChoice).toBe('custom')
    expect(custom.events).toEqual(['issues', 'push'])
    expect(custom.contentType).toBe('json')
    expect(custom.secret).toBeNull()
    expect(webhookFormFromHook(hook(['push'], { url: 'http://x', insecure_ssl: 1 })).insecureSsl).toBe(true)
  })

  it('builds events and config, leaving an unchanged secret out', () => {
    expect(webhookEvents({ ...EMPTY_WEBHOOK_FORM, eventChoice: 'all' })).toEqual(['*'])
    expect(webhookEvents({ ...EMPTY_WEBHOOK_FORM, eventChoice: 'push', events: ['issues'] })).toEqual(['push'])
    expect(webhookEvents({ ...EMPTY_WEBHOOK_FORM, eventChoice: 'custom', events: ['issues', 'issues', 'fork'] })).toEqual(['issues', 'fork'])
    expect(webhookConfig({ ...EMPTY_WEBHOOK_FORM, url: ' https://a.test/x ', secret: null })).toEqual({ url: 'https://a.test/x', content_type: 'form', insecure_ssl: '0' })
    expect(webhookConfig({ ...EMPTY_WEBHOOK_FORM, url: 'https://a.test', secret: 'abc', insecureSsl: true, contentType: 'json' })).toEqual({
      url: 'https://a.test',
      content_type: 'json',
      insecure_ssl: '1',
      secret: 'abc',
    })
  })

  it('summarizes events and delivery state like the list', () => {
    expect(webhookEventsSummary(['push'])).toBe('push')
    expect(webhookEventsSummary(['*'])).toBe('all events')
    expect(webhookEventsSummary(['issues', 'push'])).toBe('issues and push')
    expect(webhookEventsSummary(['a', 'b', 'c'])).toBe('3 events')
    expect(webhookStatus(false, { code: 200, status: 'active' })).toBe('inactive')
    expect(webhookStatus(true, { code: null, status: 'unused' })).toBe('never')
    expect(webhookStatus(true, { code: 204, status: 'active' })).toBe('success')
    expect(webhookStatus(true, { code: 502, status: 'active' })).toBe('failure')
  })

  it('validates payload URLs and formats deliveries', () => {
    expect(isValidPayloadUrl('https://example.com/gi-ui-test')).toBe(true)
    expect(isValidPayloadUrl('ftp://example.com')).toBe(false)
    expect(isValidPayloadUrl('example.com')).toBe(false)
    expect(formatPayload('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(formatPayload('a=1')).toBe('a=1')
    expect(formatPayload({ zen: 'x' })).toBe('{\n  "zen": "x"\n}')
    expect(formatHeaders({ Accept: '*/*', 'X-List': ['a', 'b'] })).toBe('Accept: */*\nX-List: a, b')
  })
})

describe('deploy keys', () => {
  const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQF/bXOgvmmSgoPAsjzUFtom4FLqBnITPY2HVv9+IQ4 gi-ui-test'

  it('computes OpenSSH’s SHA256 fingerprint', async () => {
    // ssh-keygen -lf: 256 SHA256:LkLN8f4siSgfl9CsmY475VSxoaWmIrzVAGuU4pe7ww8 gi-ui-test (ED25519)
    expect(await sshFingerprint(pub)).toBe('SHA256:LkLN8f4siSgfl9CsmY475VSxoaWmIrzVAGuU4pe7ww8')
    expect(sshKeyBlob(pub)?.type).toBe('ssh-ed25519')
    expect(sshKeyBlob('not a key')).toBeNull()
    expect(await sshFingerprint('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeNull()
  })

  it('words last use like github.com', () => {
    const now = Date.parse('2026-10-31T00:00:00Z')
    expect(keyLastUsed(null, now)).toBe('Never used')
    expect(keyLastUsed('2026-10-29T00:00:00Z', now)).toBe('Last used within the last week')
    expect(keyLastUsed('2026-10-15T00:00:00Z', now)).toBe('Last used within the last 3 weeks')
    expect(keyLastUsed('2026-07-01T00:00:00Z', now)).toBe('Last used within the last 5 months')
    expect(keyLastUsed('2024-01-01T00:00:00Z', now)).toBe('Last used more than a year ago')
  })
})

describe('actions secret and variable names', () => {
  it('applies GitHub’s naming rules', () => {
    expect(actionsNameError('GI_UI_TEST_SECRET', 'secret')).toBeNull()
    expect(actionsNameError('', 'secret')).toBeNull()
    expect(actionsNameError('my var', 'variable')).toMatch(/Spaces are not allowed/)
    expect(actionsNameError('a-b', 'secret')).toMatch(/alphanumeric/)
    expect(actionsNameError('1ABC', 'secret')).toMatch(/cannot start with a number/)
    expect(actionsNameError('github_token', 'variable')).toMatch(/GITHUB_/)
    expect(normalizeActionsName(' gi_ui_test_var ')).toBe('GI_UI_TEST_VAR')
  })
})
