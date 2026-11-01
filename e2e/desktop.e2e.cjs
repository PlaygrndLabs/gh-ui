// Desktop end-to-end scenario for `GI_UI_E2E=e2e/desktop.e2e.cjs electron .`
// (see scripts/e2e-desktop.sh, which prepares the fixtures and a throwaway profile).
//
// Every step runs inside the real renderer, through the real preload bridge and
// main-process IPC: git runs for real, sign-in goes through the login screen, and
// the wiki is cloned from GitHub by the Wiki tab itself.

const LOCAL = process.env.E2E_LOCAL_REPO
const PARENT = process.env.E2E_CLONE_PARENT
const j = JSON.stringify

const helpers = `
  const g = window.giUi
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(text))
  const setInput = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (check, ms = 20000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const v = check(); if (v) return v; await sleep(250) }
    return null
  }
`

exports.steps = [
  {
    name: 'local repo: status, stage, commit, history, policy',
    js: `${helpers}
      const repo = await g.repos.add(${j(LOCAL)})
      const before = await g.git(repo.id, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
      await g.git(repo.id, ['add', '--', 'notes.md'])
      const commit = await g.git(repo.id, ['commit', '-m', 'Add notes', '-m', 'Written by the gi-ui e2e test'])
      const log = await g.git(repo.id, ['log', '-n', '2', '--pretty=format:%s'])
      const after = await g.git(repo.id, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      const preview = await g.git(repo.id, ['diff', '--no-index', '--', '/dev/null', 'scratch.txt'])
      let forceBlocked = false
      try { await g.git(repo.id, ['push', '--force']) } catch { forceBlocked = true }
      let escapeBlocked = false
      try { await g.git(repo.id, ['diff', '--no-index', '--', '/dev/null', '../../../../etc/hosts']) } catch { escapeBlocked = true }
      const r = {
        notesUntrackedBefore: before.stdout.includes('?? notes.md'),
        commitExit: commit.code,
        log: log.stdout.split('\\n'),
        notesCommitted: !after.stdout.includes('notes.md'),
        untrackedPreview: preview.stdout.includes('+hello from scratch'),
        forceBlocked,
        escapeBlocked,
      }
      r.fail = !(r.notesUntrackedBefore && r.commitExit === 0 && r.log[0] === 'Add notes' && r.notesCommitted && r.untrackedPreview && forceBlocked && escapeBlocked)
      return r
    `,
  },
  {
    name: 'sign in through the login screen (GitHub CLI session)',
    js: `${helpers}
      const button = byText('button', 'Use GitHub CLI session')
      if (!button) return { fail: true, error: 'login button not found at ' + location.pathname }
      const started = Date.now()
      button.click()
      await until(() => location.pathname !== '/login')
      return { clicked: true, signInMs: Date.now() - started }
    `,
  },
  {
    name: 'signed in: account stored through the native secret store',
    js: `${helpers}
      await until(() => document.querySelector('.AppHeader'))
      const accounts = JSON.parse((await g.secrets.get('accounts')) || '[]')
      const r = { path: location.pathname, header: !!document.querySelector('.AppHeader'), accounts: accounts.map((a) => a.login + ' via ' + a.method) }
      r.fail = !(r.header && accounts.length === 1 && accounts[0].method === 'gh-cli')
      return r
    `,
  },
  {
    name: 'open the Wiki tab of jqlang/jq',
    js: `location.assign('/jqlang/jq/wiki'); return true`,
    waitMs: 1500,
  },
  {
    name: 'clone the wiki from the Wiki tab',
    js: `${helpers}
      const input = await until(() => document.querySelector('input[aria-label="Parent folder"]'))
      if (!input) return { fail: true, error: 'clone form not shown', path: location.pathname, historyLength: history.length, text: document.querySelector('main')?.innerText.slice(0, 120) }
      setInput(input, ${j(PARENT)})
      await sleep(300)
      const button = byText('button', 'Clone wiki')
      if (!button || button.disabled) return { fail: true, error: 'clone button not ready' }
      button.click()
      return { cloning: true, at: location.pathname }
    `,
  },
  {
    name: 'wiki pages render from the local clone',
    js: `${helpers}
      // The page list may start collapsed (jq has a custom _Sidebar), but its rows are still rendered.
      const page = () => document.querySelector('.wk-content > div:first-child .markdown-body')
      await until(() => document.querySelectorAll('.wk-pages li.wk-page-row').length > 3 && page(), 60000)
      const pages = [...document.querySelectorAll('.wk-pages li.wk-page-row:not(.wk-more)')].map((li) => li.textContent.trim()).filter(Boolean)
      const title = document.querySelector('.wk-header h1')?.textContent
      const body = page()?.innerText ?? ''
      const r = { pageCount: pages.length, firstPages: pages.slice(0, 5), title, renderedChars: body.length, sample: body.slice(0, 120) }
      r.fail = !(pages.length > 3 && title && body.length > 200)
      return r
    `,
  },
  {
    name: 'Local repositories page lists both repos and shows changes',
    js: `${helpers}
      const repos = await g.repos.list()
      const local = repos.find((r) => r.path === ${j(LOCAL)})
      location.assign('/local/' + local.id)
      return { repos: repos.map((r) => r.name) }
    `,
    waitMs: 1500,
  },
  {
    name: 'local repo view',
    js: `${helpers}
      await until(() => (document.querySelector('main')?.innerText ?? '').includes('scratch.txt'))
      const text = document.querySelector('main')?.innerText ?? ''
      const r = {
        listsWiki: text.includes('jq.wiki'),
        showsUntracked: text.includes('scratch.txt'),
        commitButton: !!byText('button', 'Commit'),
        branch: text.includes('main'),
      }
      r.fail = !(r.listsWiki && r.showsUntracked && r.commitButton)
      return r
    `,
  },
  {
    name: 'cleanup: forget repos and account in the test profile',
    js: `${helpers}
      for (const r of await g.repos.list()) await g.repos.remove(r.id)
      await g.secrets.delete('accounts')
      return { remaining: (await g.repos.list()).length }
    `,
  },
]
