import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { checkoutPlan } from '../src/lib/checkout'

const require = createRequire(import.meta.url)
const { validateGitArgs, worktreeFolder, gitAuthEnv, reorderCommits } = require('./git-policy.cjs') as {
  reorderCommits(git: (args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>, order: unknown): Promise<{ code: number }>
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
    [['switch', '--detach', 'abc123']],
    [['commit', '--amend', '-m', 'x']],
    [['revert', '--no-edit', 'abc123']],
    [['revert', '--abort']],
    [['cherry-pick', 'abc123']],
    [['cherry-pick', '--abort']],
    [['tag', 'v1', 'abc123']],
    [['tag', '--points-at', 'abc123']],
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
    [['tag', '-d', 'v1']],
    [['tag', '-f', 'v1', 'abc123']],
    [['cherry-pick', '-x', 'abc123']],
    [['revert', '-n', 'abc123']],
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

describe('reordering commits', () => {
  const [a, b, c, base] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(40))
  /** A branch whose newest commits are a, b and c, in that order, on top of base. */
  function fakeGit(log = `${a} ${b}\n${b} ${c}\n${c} ${base}`, rebase = { code: 0, stdout: '', stderr: '' }) {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = []
    const git = async (args: string[], env: Record<string, string>) => {
      calls.push({ args, env })
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return { code: 0, stdout: '/nowhere/.git\n', stderr: '' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${base}\n`, stderr: '' }
      if (args[0] === 'log') return { code: 0, stdout: log, stderr: '' }
      if (args.includes('-i')) return rebase
      return { code: 0, stdout: '', stderr: '' }
    }
    return { git, calls, rebase: () => calls.find((call) => call.args.includes('-i')) }
  }

  it('asks only for the order: the todo holds picks of the checked commits, oldest first', async () => {
    const { git, rebase } = fakeGit()
    await reorderCommits(git, [b, a, c])
    expect(rebase()!.env.GH_UI_REBASE_TODO).toBe(`pick ${a}\npick ${b}`)
    expect(rebase()!.args).toEqual(['-c', 'rebase.updateRefs=false', 'rebase', '-i', '--empty=keep', c])
    expect(rebase()!.env.GIT_EDITOR).toBe('true')
  })

  it('always uses the same editor command', async () => {
    const { git, rebase } = fakeGit()
    await reorderCommits(git, [c, b, a])
    expect(rebase()!.env.GIT_SEQUENCE_EDITOR).toBe(`printf '%s\\n' "$GH_UI_REBASE_TODO" >`)
  })

  it.each([
    ['not a list', 'abc'],
    ['one commit', [a]],
    ['a short id', [a, 'abc123']],
    ['a ref name', [a, 'main']],
    ['a line of its own', [a, `${b}\nexec touch /tmp/x`]],
    ['an upper-case id', [a, b.toUpperCase()]],
    ['a repeat', [a, a]],
    ['something else', [a, 1]],
  ])('refuses %s before running git', async (_what, order) => {
    const { git, calls } = fakeGit()
    await expect(reorderCommits(git, order)).rejects.toThrow('Invalid commit order')
    expect(calls).toEqual([])
  })

  it.each([
    ['fewer commits than asked for', `${a} ${b}`],
    ['a commit not among them', `${a} ${b}\n${b} ${c}\n${base} x`],
    ['a merge', `${a} ${b} ${c}\n${b} ${c}\n${c} ${base}`],
  ])('refuses %s without rebasing', async (_what, log) => {
    const { git, rebase } = fakeGit(log)
    await expect(reorderCommits(git, [c, b, a])).rejects.toThrow(/changed/)
    expect(rebase()).toBeUndefined()
  })

  it('looks only at commits not on the upstream', async () => {
    const { git, calls } = fakeGit()
    await reorderCommits(git, [b, a, c])
    expect(calls.find((call) => call.args[0] === 'log')!.args).toEqual(['log', '-n', '3', '--pretty=format:%H %P', 'HEAD', '--not', base, '--'])
  })

  it('keeps a rebase that stopped on a conflict, and undoes one that stopped for anything else', async () => {
    const failed = { code: 1, stdout: '', stderr: 'nope' }
    const conflicted = fakeGit(undefined, failed)
    const git = async (args: string[], env: Record<string, string>) => (args[0] === 'ls-files' ? { code: 0, stdout: '100644 x 1\tf\n', stderr: '' } : conflicted.git(args, env))
    await reorderCommits(git, [c, b, a])
    expect(conflicted.calls.some((call) => call.args.includes('--abort'))).toBe(false)

    const other = fakeGit(undefined, failed)
    await reorderCommits(other.git, [c, b, a])
    expect(other.calls.some((call) => call.args.join(' ') === 'rebase --abort')).toBe(true)
  })

  it.each([
    [['rebase', '-i', 'HEAD~2']],
    [['rebase', '--interactive', 'HEAD~2']],
    [['rebase', '--exec', 'touch /tmp/x', 'HEAD~2']],
    [['rebase', '--root']],
  ])('keeps %j off the allow-list', (args) => expect(() => validateGitArgs(args)).toThrow())
})
