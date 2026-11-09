import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { checkoutPlan } from '../src/lib/checkout'

const require = createRequire(import.meta.url)
const { validateGitArgs, worktreeFolder, gitAuthEnv } = require('./git-policy.cjs') as {
  validateGitArgs(args: string[]): void
  worktreeFolder(repoName: string, branch: string): string
  gitAuthEnv(auth?: { token: string; host: string }): Record<string, string>
}

describe('worktreeFolder', () => {
  it('names the folder after the repository and branch', () => expect(worktreeFolder('web', 'feat/a#b')).toBe('web-feat-a-b'))
  it.each(['', '-x', 'a b', '--detach'])('refuses %j', (b) => expect(() => worktreeFolder('web', b)).toThrow())
})

describe('validateGitArgs', () => {
  it.each([
    [['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']],
    [['switch', '-c', 'feature/x']],
    [['commit', '-m', '--force is just text here', '-m', 'body']],
    [['restore', '--staged', '--worktree', '--source=HEAD', '--', 'src/a.ts']],
    [['log', '-n', '200', '--pretty=format:%H%x1f%s']],
    [['diff', '--no-index', '--', '/dev/null', 'src/new.ts']],
    [['clean', '-f', '--', 'tmp.txt']],
    [['push', '-u', 'origin', 'HEAD']],
    [['remote', 'get-url', 'origin']],
    [['ls-tree', '-r', '--name-only', 'HEAD']],
    [['worktree', 'list', '--porcelain']],
    // Every other command the app sends.
    [['status', '--porcelain=v1', '-z', '--untracked-files=all']],
    [['diff', 'HEAD', '--', 'a.ts']],
    [['diff', '--cached', '--', 'a.ts']],
    [['diff', '--cached']],
    [['log', '-n', '100', '--pretty=format:%H', 'main', '--not', '--remotes=origin', '--']],
    [['log', '-n', '100', '--pretty=format:%H', 'main..origin/main', '--']],
    [['log', '--format=%an%x09%aI', '--', 'Home.md']],
    [['show', '--format=%B%x1e', '--patch', '--no-color', 'abc123']],
    [['show', 'HEAD:Home.md']],
    [['branch', '--format=%(refname:short)']],
    [['branch', 'new-branch']],
    [['switch', 'main']],
    [['add', '--', 'a.ts', 'b.ts']],
    [['reset', '-q', '--', 'a.ts', 'b.ts']],
    [['commit', '-m', 'just a summary']],
    [['commit', '-m', '-starts with a dash']],
    [['push']],
    [['pull', '--ff-only']],
    [['pull', '--ff-only', 'origin', 'pull/7/head']],
    [['fetch', '--prune', 'origin']],
    [['fetch', 'origin', 'pull/7/head:pr-7']],
    [['fetch', 'origin', 'feat/x#1']],
    [['stash', 'push', '-u']],
    [['stash', 'pop']],
    [['stash', 'list', '--format=%s']],
    [['rev-parse', '--abbrev-ref', 'HEAD']],
    [['rev-parse', '--abbrev-ref', 'origin/HEAD']],
    [['branch', '--all', '--format=%(refname)%1f%(upstream:short)']],
    [['log', '-n', '200', '--pretty=format:%H', 'origin/release', '--']],
    [['reset', '--soft', 'HEAD~1']],
    [['merge', '--no-edit', 'origin/main']],
    [['merge', '--squash', 'topic']],
    [['merge', '--abort']],
    [['rebase', 'main']],
    [['rebase', '--continue']],
    [['rebase', '--abort']],
    [['commit', '--no-edit']],
    [['rev-parse', '-q', '--verify', 'MERGE_HEAD']],
    [['branch', '-m', '--', 'old', 'new']],
    [['branch', '-D', '--', 'old']],
    [['remote', 'add', 'origin', 'https://github.com/acme/web.git']],
    [['remote', 'add', 'gitlab', 'git@gitlab.com:acme/web.git']],
    [['remote', 'set-url', 'origin', 'ssh://git@gitlab.example/acme/web.git']],
    [['remote', 'remove', 'gitlab']],
    [['config', '--local', '--get', 'user.name']],
    [['config', '--local', 'user.email', 'me@example.com']],
    [['config', '--local', '--unset', 'user.email']],
  ])('allows %j', (args) => expect(() => validateGitArgs(args)).not.toThrow())

  it.each([
    [['config', 'core.sshCommand', 'evil']],
    [['remote', 'add', 'origin', 'ext::sh -c evil']],
    [['remote', 'add', '-evil', 'https://github.com/acme/web.git']],
    [['remote', 'set-url', 'origin', 'ext::sh -c evil']],
    [['remote', 'add', 'x', 'ssh://-oProxyCommand=evil/x']],
    [['config', '--local', 'core.sshCommand', 'evil']],
    [['config', '--global', 'user.name', 'x']],
    [['config', 'user.name', 'x']],
    [['remote', 'add', 'origin', '/etc']],
    [['fetch', '--upload-pack=touch /tmp/x']],
    [['push', '--receive-pack', 'x']],
    [['push', '--force']],
    [['diff', '--output=/etc/passwd']],
    [['reset', '--hard']],
    [['branch', '-D', 'main']],
    [['rebase', '--exec', 'evil', 'main']],
    [['rebase', '-x', 'evil', 'main']],
    [['merge', '-s', 'ours', 'main']],
    [['merge', '--strategy=evil', 'main']],
    [['branch', '-D', '--', 'a', 'b']],
    [['worktree', 'add', '--', '/tmp/x', 'main']],
    [['worktree', 'remove', '--', '/tmp/x']],
    [['worktree', 'list']],
    [['worktree', 'list', '--porcelain', '/tmp/x']],
    [['remote', 'add', 'x', 'y']],
    [['diff', '--no-index', '--', '/etc/passwd', 'x']],
    [['diff', '--no-index', '--', '/dev/null', '../../etc/passwd']],
    [['clean', '-fdx']],
    // What a list of forbidden options let through.
    [['fetch', '--upload-pa=touch /tmp/x']],
    [['pull', '--upload-pac', 'x']],
    [['push', '--receive-pa=x']],
    [['push', '-fu', 'origin', 'main']],
    [['push', 'origin', '+main']],
    [['push', 'origin', ':main']],
    [['push', '/tmp/evil', 'HEAD']],
    [['push', 'https://evil.example/x.git', 'HEAD']],
    [['push', '--', '/tmp/evil', 'HEAD']],
    [['fetch', '/tmp/evil']],
    [['switch', '--discard-changes', 'main']],
    [['reset', '--merge']],
    [['reset', '--keep', 'HEAD~1']],
    [['stash', 'clear']],
    [['stash', 'drop']],
    [['branch', '-fD', 'main']],
    [['branch', '-dr', 'origin/main']],
    [['log', '-n', '--output=/tmp/x']],
    [['log', '-O/etc/passwd']],
    [['commit', '--amend', '-m', 'x']],
    [['commit', '-F', '/etc/passwd']],
    [['add', '.git/config']],
    [['add', '-f', '--', 'x']],
    [['status', '--ignored']],
    [['-c', 'core.pager=evil', 'log']],
  ])('rejects %j', (args) => expect(() => validateGitArgs(args)).toThrow())
})

describe('gitAuthEnv', () => {
  it('scopes the credential helper to the account host', () => {
    const env = gitAuthEnv({ token: 'ghp_x', host: 'github.com' })
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GH_UI_GIT_TOKEN).toBe('ghp_x')
    expect(env.GIT_CONFIG_VALUE_1).not.toContain('ghp_x')
  })
  it('ignores malformed hosts', () => {
    expect(gitAuthEnv({ token: 'x', host: 'evil.com; rm -rf /' })).toEqual({})
  })
})

describe('checking out a pull request', () => {
  it.each([
    [{ number: 7, headRef: 'fix/x', fromFork: false }, 'main'],
    [{ number: 7, headRef: 'p', fromFork: true }, 'main'],
    [{ number: 7, headRef: 'p', fromFork: true }, 'pr-7'],
  ])('stays within what the policy allows (%#)', (target, current) => {
    for (const step of checkoutPlan(target, current).steps) expect(() => validateGitArgs(step)).not.toThrow()
  })
})
