// Rules for what the renderer may ask git to do. Kept separate from main.cjs so
// they can be unit tested (electron/git-policy.test.ts).
const fs = require('node:fs')
const path = require('node:path')

const HOST_RE = /^[a-z0-9.-]+$/i

/** Env that makes git use the signed-in token for https://<host> only. */
function gitAuthEnv(auth) {
  if (!auth || typeof auth.token !== 'string' || !HOST_RE.test(auth.host || '')) return {}
  const key = `credential.https://${auth.host}.helper`
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_UI_GIT_TOKEN"; }; f',
    GH_UI_GIT_TOKEN: auth.token,
  }
}

const GIT_BASE_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

// ---------------------------------------------------------------------------
// git allow-list. args[0] is always the subcommand, so global options (-c, -C, --git-dir…) can't appear.
//
// Each subcommand lists the options the app really uses, spelled the way it spells them. A list of forbidden options
// can't work: git accepts abbreviations (--upload-pa), joined short flags (-fu) and new options in every release.
//   flags:    options taken exactly       prefixes: options with a value after "="
//   valued:   options whose next argument is their value, and what that value may be
//   args:     'none', or 'any' for bare arguments such as a revision; they can never start with "-"
//   paths:    whether "--" and file paths may follow
const ANYTHING = /^/
const RULES = {
  status: { flags: ['--porcelain=v1', '-b', '-z', '--untracked-files=all'], args: 'none' },
  diff: { flags: ['--cached'], args: 'any', paths: true },
  log: { flags: ['--not'], prefixes: ['--format=', '--pretty=', '--remotes='], valued: { '-n': /^\d+$/ }, args: 'any', paths: true },
  show: { flags: ['--patch', '--diff-merges=first-parent', '--no-color'], prefixes: ['--format='], args: 'any' },
  branch: { flags: ['--all'], prefixes: ['--format='], args: 'any' },
  switch: { flags: ['-c', '--detach'], args: 'any' },
  add: { args: 'none', paths: true },
  restore: { flags: ['--staged', '--worktree'], prefixes: ['--source='], args: 'none', paths: true },
  reset: { flags: ['-q', '--soft'], args: 'any', paths: true },
  commit: { flags: ['--no-edit', '--amend'], valued: { '-m': ANYTHING }, args: 'none' },
  merge: { flags: ['--no-edit', '--squash', '--abort'], args: 'any' },
  rebase: { flags: ['--abort', '--continue'], args: 'any' },
  revert: { flags: ['--no-edit', '--abort'], args: 'any' },
  'cherry-pick': { flags: ['--abort'], args: 'any' },
  tag: { flags: ['--points-at'], args: 'any' },
  'rev-parse': { flags: ['--abbrev-ref', '-q', '--verify'], args: 'any' },
  'ls-tree': { flags: ['-r', '--name-only'], args: 'any' },
  // The first bare argument names a configured remote, never a URL or folder, which could connect anywhere or run its hooks.
  push: { flags: ['-u'], args: 'remote' },
  pull: { flags: ['--ff-only'], args: 'remote' },
  fetch: { flags: ['--prune'], args: 'remote' },
}
const ALLOWED_SUBCOMMANDS = new Set([...Object.keys(RULES), 'remote', 'config', 'stash', 'clean', 'worktree'])

/**
 * The environment for one command. Where the app names files, a path means that one file: otherwise discarding
 * app/[id]/page.tsx also matches app/i/page.tsx. Not for every command, because stash runs `git clean -- :/` internally
 * and a literal ":/" matches nothing, which would leave untracked files behind.
 */
const gitCommandEnv = (sub) => ({
  ...GIT_BASE_ENV,
  ...(sub === 'clean' || RULES[sub]?.paths ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
  // Nobody is at a terminal to edit the message of a commit a rebase replays.
  ...(sub === 'rebase' ? { GIT_EDITOR: 'true' } : {}),
})

// One ref, or source:destination. No leading "+" (forces the update) and no leading ":" (deletes the remote branch).
const REFSPEC = /^[^\s:+~^?*[\\-][^\s:~^?*[\\]*(:[^\s:~^?*[\\]+)?$/
const STASH_FORMS = [['push', '-u'], ['pop']]

function validateOptions(sub, rest) {
  const { flags = [], prefixes = [], valued = {}, args: kind, paths } = RULES[sub]
  const bare = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--') {
      if (!paths) throw new Error(`git ${sub} does not take paths`)
      break
    }
    if (Object.hasOwn(valued, a)) {
      const value = rest[++i]
      if (value === undefined || !valued[a].test(value)) throw new Error(`git option ${a} needs a value`)
    } else if (a.startsWith('-')) {
      if (!flags.includes(a) && !prefixes.some((p) => a.startsWith(p))) throw new Error(`git option ${a} is not allowed`)
    } else bare.push(a)
  }
  if (kind === 'none' && bare.length) throw new Error(`git ${sub} does not take ${bare[0]}`)
  if (kind === 'remote') {
    const [remote, ...refspecs] = bare
    if (remote !== undefined && !REMOTE_NAME.test(remote)) throw new Error(`${remote} is not a remote's name`)
    for (const refspec of refspecs) if (!REFSPEC.test(refspec)) throw new Error(`Refspec ${refspec} is not allowed`)
  }
}

const IDENTITY_KEYS = new Set(['user.name', 'user.email'])
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]*$/
// A remote's URL decides what git connects to. These can't run anything, unlike ext:: or a path to a hook-laden folder.
const REMOTE_URL = [/^https:\/\/[^\s-][^\s]*$/, /^ssh:\/\/[\w.]+[^\s]*$/, /^[\w.][\w.-]*@[\w.][\w.-]*:[\w.~/-]+$/]
const safeRemoteUrl = (url) => REMOTE_URL.some((re) => re.test(url))

function validateRemoteArgs(rest) {
  const [action, name, url] = rest
  if (action === '-v' && rest.length === 1) return
  if (action === 'get-url' && rest.length === 2 && REMOTE_NAME.test(name)) return
  if (action === 'remove' && rest.length === 2 && REMOTE_NAME.test(name)) return
  if ((action === 'add' || action === 'set-url') && rest.length === 3 && REMOTE_NAME.test(name) && safeRemoteUrl(url)) return
  throw new Error('That `git remote` command is not allowed')
}

function validateGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) throw new Error('Invalid git arguments')
  const [sub, ...rest] = args
  if (!ALLOWED_SUBCOMMANDS.has(sub)) throw new Error(`git ${sub} is not allowed`)
  if (sub === 'remote') return validateRemoteArgs(rest)
  // Adding and removing name folders outside the repository, so those have their own channels.
  if (sub === 'worktree') {
    if (rest.length !== 2 || rest[0] !== 'list' || rest[1] !== '--porcelain') throw new Error('Only `git worktree list --porcelain` is allowed')
    return
  }
  // Force-deleting one named branch is the only deletion; the page confirms it first.
  if (sub === 'branch' && rest[0] === '-D' && rest[1] === '--' && rest.length === 3) return
  if (sub === 'branch' && rest[0] === '-m' && rest[1] === '--' && rest.length === 4) return
  if (sub === 'stash') {
    const listing = rest.length === 2 && rest[0] === 'list' && rest[1].startsWith('--format=')
    if (!listing && !STASH_FORMS.some((form) => form.join('\0') === rest.join('\0'))) throw new Error('That `git stash` command is not allowed')
    return
  }
  // Only this repository's commit identity; any other setting could make git run a program.
  if (sub === 'config') {
    const ok = rest.length === 3 && rest[0] === '--local' && ['--get', '--unset'].includes(rest[1]) && IDENTITY_KEYS.has(rest[2])
    const set = rest.length === 3 && rest[0] === '--local' && IDENTITY_KEYS.has(rest[1]) && !rest[2].startsWith('-')
    if (!ok && !set) throw new Error('Only a repository\'s user.name and user.email can be changed')
    return
  }
  if (sub === 'diff' && rest.includes('--no-index')) {
    // Only "new file" previews: git diff --no-index -- /dev/null <repo-relative path>
    const target = rest[3]
    const ok = rest.length === 4 && rest[0] === '--no-index' && rest[1] === '--' && rest[2] === '/dev/null' && target && !path.isAbsolute(target) && !target.split(/[\\/]/).includes('..')
    if (!ok) throw new Error('Unsupported diff --no-index usage')
    return
  }
  if (sub === 'clean') {
    if (!(rest[0] === '-f' && rest[1] === '--' && rest.length > 2)) throw new Error('Only `git clean -f -- <paths>` is allowed')
    return
  }
  validateOptions(sub, rest)
}

// ---------------------------------------------------------------------------
// Reordering commits. An interactive rebase needs a sequence editor, and a command the renderer could name is a
// command it could run, so `rebase -i` stays off the allow-list above. The renderer says only what order it wants.

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
// Git runs this through a shell with the todo file's path added on the end. The list arrives by the environment, so the
// command itself never changes, and the list only ever holds ids that passed the checks below.
const WRITE_TODO = `printf '%s\\n' "$GH_UI_REBASE_TODO" >`
const IN_PROGRESS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
const STALE = 'These commits have changed since you picked one up. Check the history and try again.'

/**
 * Puts the newest commits in `order` (newest first), which must be those same commits. They all have to be unpushed and
 * on a straight line, because a rebase rewrites them and would flatten a merge. Commits below the lowest one that moves
 * are left alone. A conflict stops in git's rebase state to continue or abort; any other failure puts everything back.
 * `git` runs one command: (args, env) => { code, stdout, stderr }.
 */
async function reorderCommits(git, order) {
  if (!Array.isArray(order) || order.length < 2 || !order.every((sha) => typeof sha === 'string' && COMMIT_ID.test(sha)) || new Set(order).size !== order.length) throw new Error('Invalid commit order')

  const gitDir = (await git(['rev-parse', '--absolute-git-dir'], GIT_BASE_ENV)).stdout.trim()
  if (!gitDir || IN_PROGRESS.some((name) => fs.existsSync(path.join(gitDir, name)))) throw new Error('Finish what’s in progress in this folder first.')

  const upstream = (await git(['rev-parse', '-q', '--verify', '@{upstream}'], GIT_BASE_ENV)).stdout.trim()
  const log = await git(['log', '-n', String(order.length), '--pretty=format:%H %P', 'HEAD', '--not', upstream || '--remotes', '--'], GIT_BASE_ENV)
  const current = log.stdout.split('\n').filter(Boolean).map((line) => line.trim().split(' '))
  const same = current.length === order.length && current.every(([sha, ...parents]) => order.includes(sha) && parents.length <= 1)
  if (!same) throw new Error(STALE)

  // The oldest commits that stay where they are don't need rewriting.
  let moved = order.length
  while (moved > 0 && order[moved - 1] === current[moved - 1][0]) moved--
  if (!moved) return { code: 0, stdout: '', stderr: '' }

  const parent = current[moved - 1][1]
  const todo = order.slice(0, moved).reverse().map((sha) => `pick ${sha}`).join('\n')
  // Keeping emptied commits means a reorder never loses one or stops with nothing to resolve. Other branches stay put: the
  // todo written here has no update-ref lines for them. As config, because older git doesn't know the option.
  const res = await git(['-c', 'rebase.updateRefs=false', 'rebase', '-i', '--empty=keep', parent ?? '--root'], { ...gitCommandEnv('rebase'), GIT_SEQUENCE_EDITOR: WRITE_TODO, GH_UI_REBASE_TODO: todo })
  if (res.code !== 0 && !(await git(['ls-files', '-u'], GIT_BASE_ENV)).stdout.trim()) await git(['rebase', '--abort'], gitCommandEnv('rebase'))
  return res
}

/** The folder a branch's worktree goes in, named after the repository and the branch. */
function worktreeFolder(repoName, branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\s\0-\x1f]/.test(branch)) throw new Error('Invalid branch name')
  return `${repoName}-${branch.replace(/[^\w.-]+/g, '-')}`
}

module.exports = { HOST_RE, gitAuthEnv, validateGitArgs, worktreeFolder, gitCommandEnv, reorderCommits, GIT_BASE_ENV }
