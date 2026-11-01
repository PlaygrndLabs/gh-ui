import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { validateGitArgs, gitAuthEnv } = require('./git-policy.cjs') as {
  validateGitArgs(args: string[]): void
  gitAuthEnv(auth?: { token: string; host: string }): Record<string, string>
}

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
  ])('allows %j', (args) => expect(() => validateGitArgs(args)).not.toThrow())

  it.each([
    [['config', 'core.sshCommand', 'evil']],
    [['fetch', '--upload-pack=touch /tmp/x']],
    [['push', '--receive-pack', 'x']],
    [['push', '--force']],
    [['diff', '--output=/etc/passwd']],
    [['reset', '--hard']],
    [['branch', '-D', 'main']],
    [['remote', 'add', 'x', 'y']],
    [['diff', '--no-index', '--', '/etc/passwd', 'x']],
    [['diff', '--no-index', '--', '/dev/null', '../../etc/passwd']],
    [['clean', '-fdx']],
    [['-c', 'core.pager=evil', 'log']],
  ])('rejects %j', (args) => expect(() => validateGitArgs(args)).toThrow())
})

describe('gitAuthEnv', () => {
  it('scopes the credential helper to the account host', () => {
    const env = gitAuthEnv({ token: 'ghp_x', host: 'github.com' })
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GI_UI_GIT_TOKEN).toBe('ghp_x')
    expect(env.GIT_CONFIG_VALUE_1).not.toContain('ghp_x')
  })
  it('ignores malformed hosts', () => {
    expect(gitAuthEnv({ token: 'x', host: 'evil.com; rm -rf /' })).toEqual({})
  })
})
