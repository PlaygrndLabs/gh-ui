// Desktop end-to-end scenario for `GH_UI_E2E=e2e/desktop.e2e.cjs electron .`
// (see scripts/e2e-desktop.sh, which prepares the fixtures and a throwaway profile).
//
// Every step runs inside the real renderer, through the real preload bridge and
// main-process IPC: git runs for real, sign-in goes through the login screen, and
// the wiki is cloned from GitHub by the Wiki tab itself.

const LOCAL = process.env.E2E_LOCAL_REPO
const PARENT = process.env.E2E_CLONE_PARENT
const j = JSON.stringify

const helpers = `
  const g = window.ghUi
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
  // A plain or modified click on a real link; each tab has its own router, so location.assign can't reach a page.
  const clickLink = (path, init = {}) => {
    const a = document.createElement('a')
    a.href = path
    a.textContent = init.text ?? ''
    document.body.append(a)
    a.dispatchEvent(new MouseEvent(init.type ?? 'click', { bubbles: true, cancelable: true, button: 0, ...init }))
    a.remove()
  }
  const tabs = () => [...document.querySelectorAll('.tab-list [role=tab]')]
  const tabTitles = () => tabs().map((t) => t.textContent.trim())
  const activeTab = () => document.querySelector('.tab-list [aria-selected=true]')
  const main = () => [...document.querySelectorAll('.app-main')].find((m) => m.getClientRects().length)
`

exports.steps = [
  {
    name: 'local repo: status, stage, commit, history, policy',
    js: `${helpers}
      const repo = await g.repos.add(${j(LOCAL)})
      const before = await g.git(repo.id, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
      await g.git(repo.id, ['add', '--', 'notes.md'])
      const commit = await g.git(repo.id, ['commit', '-m', 'Add notes', '-m', 'Written by the gh-ui e2e test'])
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
      await until(() => document.querySelector('.AppHeader'))
      return { clicked: true, signInMs: Date.now() - started }
    `,
  },
  {
    name: 'signed in: account stored through the native secret store',
    js: `${helpers}
      await until(() => document.querySelector('.AppHeader'))
      const accounts = JSON.parse((await g.secrets.get('accounts')) || '[]')
      const r = { tabs: tabTitles(), header: !!document.querySelector('.AppHeader'), accounts: accounts.map((a) => a.login + ' via ' + a.method) }
      r.fail = !(r.header && accounts.length === 1 && accounts[0].method === 'gh-cli' && r.tabs.length === 1)
      return r
    `,
  },
  {
    name: 'tabs: Cmd+T opens a dashboard tab, and a plain link stays in the active tab',
    accelerator: 'CmdOrCtrl+T',
    js: `${helpers}
      await until(() => tabs().length === 2)
      clickLink('/jqlang/jq')
      await until(() => tabTitles()[1] === 'jqlang/jq')
      await until(() => main()?.innerText.includes('README'))
      // The window's own URL never moves: pages live in each tab's router.
      const r = { tabs: tabTitles(), active: activeTab().textContent.trim(), windowUrl: location.pathname }
      r.fail = !(r.tabs.length === 2 && r.active === 'jqlang/jq' && r.windowUrl === '/')
      return r
    `,
  },
  {
    name: 'tabs: Cmd-click opens in the background, in order, next to the current tab',
    js: `${helpers}
      clickLink('/jqlang/jq/issues', { metaKey: true })
      clickLink('/PlaygrndLabs/gh-ui/pull/2', { metaKey: true, text: 'Some pull request' })
      await until(() => tabs().length === 4)
      const r = { tabs: tabTitles(), active: activeTab().textContent.trim() }
      r.fail = !(r.tabs.length === 4 && r.active === 'jqlang/jq' && r.tabs[2] === 'Issues · jq' && r.tabs[3] === '#2 Some pull request')
      return r
    `,
  },
  {
    name: 'tabs: a link can open no tab outside the app',
    js: `${helpers}
      clickLink('/..//evil.example/x', { metaKey: true })
      await until(() => tabs().length === 5, 2000)
      // It resolves to a path that names another host, so the most it can open is a dashboard.
      const r = { tabs: tabTitles() }
      r.fail = !(r.tabs.length === 5 && r.tabs[4] === 'Dashboard') || r.tabs.some((t) => t.includes('evil'))
      tabs()[r.tabs.lastIndexOf('Dashboard')].parentElement.querySelector('.tab-close').click()
      await until(() => tabs().length === 4, 2000)
      return r
    `,
  },
  {
    name: 'tabs: Cmd+1 switches, one page shows at a time, and the / shortcut acts in the visible tab',
    accelerator: 'CmdOrCtrl+1',
    js: `${helpers}
      await until(() => activeTab() === tabs()[0])
      // The tab's listeners come back with its effects, just after it paints.
      await sleep(300)
      const shown = [...document.querySelectorAll('.app-main')].filter((m) => m.getClientRects().length).length
      const header = [...document.querySelectorAll('.AppHeader')].filter((h) => h.getClientRects().length).length
      const before = document.activeElement
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
      const inputs = [...document.querySelectorAll('input[aria-label="Search or jump to"]')]
      const focused = inputs.filter((i) => i === document.activeElement)
      const r = { active: activeTab().textContent.trim(), shown, header, searchBoxes: inputs.length, focusVisible: focused[0]?.getClientRects().length > 0 }
      r.fail = !(r.active === 'Dashboard' && shown === 1 && header === 1 && r.focusVisible)
      focused[0]?.blur(); before?.focus?.()
      return r
    `,
  },
  {
    name: 'tabs: Cmd+9 goes to the last tab, which mounts on first show and names itself',
    accelerator: 'CmdOrCtrl+9',
    js: `${helpers}
      await until(() => activeTab() === tabs()[tabs().length - 1])
      await until(() => /^#2 (?!Some)/.test(activeTab().textContent.trim()), 15000)
      const r = { active: activeTab().textContent.trim() }
      r.fail = !/^#2 (?!Some)/.test(r.active)
      return r
    `,
  },
  {
    name: 'tabs: Cmd+W closes',
    accelerator: 'CmdOrCtrl+W',
    js: `${helpers}
      await until(() => tabs().length === 3)
      const r = { afterClose: tabTitles() }
      r.fail = r.afterClose.length !== 3
      return r
    `,
  },
  {
    name: 'tabs: Cmd+Shift+T reopens',
    accelerator: 'CmdOrCtrl+Shift+T',
    js: `${helpers}
      await until(() => tabs().length === 4)
      const r = { tabs: tabTitles(), active: activeTab().textContent.trim() }
      r.fail = !(r.tabs.length === 4 && /^#2 /.test(r.active))
      return r
    `,
  },
  {
    name: 'tabs: navigate inside the active tab',
    js: `${helpers}
      clickLink('/jqlang/jq/releases')
      await until(() => activeTab().textContent.trim() === 'Releases · jq')
      return { active: activeTab().textContent.trim() }
    `,
  },
  {
    name: 'tabs: Back acts on the active tab only',
    accelerator: 'CmdOrCtrl+[',
    js: `${helpers}
      await until(() => /^#?1\b/.test(activeTab().textContent.trim()))
      const r = { tabs: tabTitles(), active: activeTab().textContent.trim() }
      r.fail = !(/^#2 /.test(r.active) && r.tabs[0] === 'Dashboard' && r.tabs[1] === 'jqlang/jq')
      return r
    `,
  },
  {
    name: 'tabs: the state is saved per account',
    js: `${helpers}
      const accounts = JSON.parse((await g.secrets.get('accounts')) || '[]')
      const saved = JSON.parse(localStorage.getItem('gh-ui:tabs:' + accounts[0].id))
      const r = { saved: saved.tabs.map((t) => t.url), closed: saved.closed.length, active: saved.tabs.find((t) => t.id === saved.activeId)?.url }
      r.fail = !(r.saved.length === 4 && r.saved[1] === '/jqlang/jq' && r.active === '/PlaygrndLabs/gh-ui/pull/2')
      return r
    `,
  },
  {
    name: 'tabs: a form with text in it',
    accelerator: 'CmdOrCtrl+T',
    js: `${helpers}
      await until(() => tabs().length === 5)
      clickLink('/PlaygrndLabs/gh-ui/issues/new')
      const title = await until(() => main()?.querySelector('input[aria-label="Title"]'))
      if (!title) return { fail: true, error: 'no issue form', text: main()?.innerText.slice(0, 120) }
      setInput(title, 'e2e draft')
      await sleep(200)
      return { value: title.value }
    `,
  },
  {
    name: 'tabs: Cmd+W asks before discarding unsent text',
    accelerator: 'CmdOrCtrl+W',
    js: `${helpers}
      const dialog = await until(() => document.querySelector('[role=alertdialog]'), 3000)
      if (!dialog) return { fail: true, error: 'closed without asking', tabs: tabTitles() }
      const count = tabs().length
      ;[...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click()
      await until(() => !document.querySelector('[role=alertdialog]'))
      const r = { kept: main().querySelector('input[aria-label="Title"]')?.value, tabs: tabs().length }
      r.fail = !(r.kept === 'e2e draft' && r.tabs === count)
      return r
    `,
  },
  {
    name: 'tabs: submit a form, with nothing reaching GitHub',
    js: `${helpers}
      window.__fetch = window.fetch
      window.__posts = 0
      window.fetch = async (url, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' || String(url).endsWith('/graphql')) return window.__fetch(url, init)
        window.__posts++
        await sleep(2000)
        return new Response(JSON.stringify({ number: 1 }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      ;[...main().querySelectorAll('button')].find((b) => b.textContent.includes('Submit new issue')).click()
      await until(() => window.__posts === 1, 3000)
      return { posts: window.__posts }
    `,
  },
  {
    name: 'tabs: leave while the request is under way',
    accelerator: 'CmdOrCtrl+T',
    js: `${helpers}
      await until(() => tabs().length === 6)
      await sleep(3000)
      return { tabs: tabTitles() }
    `,
  },
  {
    name: 'tabs: the page navigated while it was hidden',
    accelerator: 'Ctrl+Shift+Tab',
    js: `${helpers}
      await until(() => activeTab().textContent.startsWith('#1'), 3000)
      await until(() => !main()?.querySelector('input[aria-label="Title"]'), 3000)
      const r = { form: !!main().querySelector('input[aria-label="Title"]'), posts: window.__posts, active: activeTab().textContent.trim() }
      window.fetch = window.__fetch
      r.fail = r.form || r.posts !== 1 || !r.active.startsWith('#1')
      return r
    `,
  },
  {
    name: 'tabs: close all but the first, for the rest of the scenario',
    js: `${helpers}
      for (let i = tabs().length - 1; i > 0; i--) { tabs()[i].parentElement.querySelector('.tab-close').click(); await sleep(100) }
      await until(() => tabs().length === 1)
      return { tabs: tabTitles() }
    `,
  },
  {
    name: 'closing the last tab leaves a dashboard, not an empty window',
    accelerator: 'CmdOrCtrl+W',
    js: `${helpers}
      await sleep(300)
      const r = { tabs: tabTitles() }
      r.fail = !(r.tabs.length === 1 && r.tabs[0] === 'Dashboard')
      return r
    `,
  },
  {
    name: 'open the Wiki tab of jqlang/jq',
    js: `${helpers} clickLink('/jqlang/jq/wiki'); return true`,
    waitMs: 1500,
  },
  {
    name: 'clone the wiki from the Wiki tab',
    js: `${helpers}
      const input = await until(() => document.querySelector('input[aria-label="Parent folder"]'))
      if (!input) return { fail: true, error: 'clone form not shown', tab: activeTab()?.textContent, text: main()?.innerText.slice(0, 120) }
      setInput(input, ${j(PARENT)})
      await sleep(300)
      const button = byText('button', 'Clone wiki')
      if (!button || button.disabled) return { fail: true, error: 'clone button not ready' }
      button.click()
      return { cloning: true, tab: activeTab().textContent.trim() }
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
      clickLink('/local/' + local.id)
      return { repos: repos.map((r) => r.name) }
    `,
    waitMs: 1500,
  },
  {
    name: 'local repo view',
    js: `${helpers}
      await until(() => (main()?.innerText ?? '').includes('scratch.txt'))
      const text = main()?.innerText ?? ''
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
