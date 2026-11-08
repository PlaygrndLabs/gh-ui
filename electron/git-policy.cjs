// Rules for what the renderer may ask git to do. Kept separate from main.cjs so
// they can be unit tested (electron/git-policy.test.ts).
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
// git allow-list. The renderer only ever runs these subcommands, and never with
// options that execute programs, write arbitrary files, or point git elsewhere.

const ALLOWED_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'switch', 'add', 'restore', 'reset', 'commit', 'push', 'pull', 'fetch', 'remote', 'config', 'rev-parse', 'stash', 'clean', 'ls-tree'])
// args[0] is always the subcommand, so global options (-c, -C, --git-dir…) can't
// appear; these are the per-command options that run programs, write files or destroy work.
const FORBIDDEN_FLAG = /^(--upload-pack|--receive-pack|--exec|--output|--ext-diff|--textconv|--template|--config|--git-dir|--work-tree|--separate-git-dir|--hard|--force|--force-with-lease|--mirror|--delete|-f|-d|-D)(=|$)/
const VALUE_FLAGS = new Set(['-m', '--message', '-F', '--format', '--pretty', '-n', '--max-count'])

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
  // Force-deleting one named branch is the only deletion; the page confirms it first.
  if (sub === 'branch' && rest[0] === '-D' && rest[1] === '--' && rest.length === 3) return
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
  const forceAllowed = sub === 'clean' // clean requires -f; it is limited to paths after --
  if (sub === 'clean' && !(rest[0] === '-f' && rest[1] === '--' && rest.length > 2)) throw new Error('Only `git clean -f -- <paths>` is allowed')
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--') break // everything after is a pathspec
    if (VALUE_FLAGS.has(a)) {
      i++ // skip the free-text value (commit message, format string)
      continue
    }
    if (a.startsWith('--format=') || a.startsWith('--pretty=') || a.startsWith('--source=')) continue
    if (FORBIDDEN_FLAG.test(a) && !(forceAllowed && a === '-f')) throw new Error(`git option ${a} is not allowed`)
  }
}

/** The folder a branch's worktree goes in, named after the repository and the branch. */
function worktreeFolder(repoName, branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\s\0-\x1f]/.test(branch)) throw new Error('Invalid branch name')
  return `${repoName}-${branch.replace(/[^\w.-]+/g, '-')}`
}

module.exports = { HOST_RE, gitAuthEnv, validateGitArgs, worktreeFolder, GIT_BASE_ENV }
