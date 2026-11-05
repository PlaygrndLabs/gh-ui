// Desktop end-to-end scenario for `GH_UI_E2E=e2e/desktop.e2e.cjs electron .`
// (see scripts/e2e-desktop.sh, which prepares the fixtures and a throwaway profile).
//
// Every step runs inside the real renderer, through the real preload bridge and
// main-process IPC: git runs for real, sign-in goes through the login screen, and
// the wiki is cloned from GitHub by the Wiki tab itself.

const path = require('node:path')
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
  // A repository's tab reads "repo - branch"; most steps only care which repository.
  const tabName = (t) => t.textContent.trim().split(' - ')[0]
  const tabTitles = () => tabs().map(tabName)
  const activeTab = () => document.querySelector('.tab-list [aria-selected=true]')
  const main = () => [...document.querySelectorAll('.app-main')].find((m) => m.getClientRects().length)
  // The page in the active tab, as saved: every tab's URL is written to storage as it changes.
  const savedActiveUrl = () => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('gh-ui:tabs:'))
    const saved = key ? JSON.parse(localStorage.getItem(key)) : null
    return saved?.tabs.find((t) => t.id === saved.activeId)?.url ?? ''
  }
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
      await until(() => document.querySelector('.ws-header'))
      return { clicked: true, signInMs: Date.now() - started }
    `,
  },
  {
    name: 'signed in: account stored through the native secret store',
    js: `${helpers}
      await until(() => document.querySelector('.ws-header'))
      const accounts = JSON.parse((await g.secrets.get('accounts')) || '[]')
      const r = { tabs: tabTitles(), header: !!document.querySelector('.ws-header'), accounts: accounts.map((a) => a.login + ' via ' + a.method) }
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
      await until(() => tabTitles()[1] === 'jq')
      await until(() => main()?.querySelector('.ws-branch-head'))
      // The window's own URL never moves: pages live in each tab's router.
      const r = { tabs: tabTitles(), active: tabName(activeTab()), windowUrl: location.pathname }
      r.fail = !(r.tabs.length === 2 && r.active === 'jq' && r.windowUrl === '/')
      return r
    `,
  },
  {
    name: 'pull requests: list beside chat beside code, with every state in view',
    screenshot: 'pull-request',
    js: `${helpers}
      clickLink('/jqlang/jq/pulls')
      const row = await until(() => main()?.querySelector('.ws-list-row'), 20000)
      if (!row) return { fail: true, error: 'no pull request list', text: main()?.innerText.slice(0, 200) }
      await until(() => main()?.querySelector('.ws-pr-thread .timeline-comment'), 20000)
      await until(() => main()?.querySelector('.ws-pr-files .file-diff'), 20000)
      const m = main()
      const r = {
        pulls: m.querySelectorAll('.ws-list-row').length,
        chat: !!m.querySelector('.ws-pr-thread .timeline-comment'),
        merge: !!m.querySelector('#pr-merge .merge-box'),
        files: !!m.querySelector('.ws-pr-files .file-diff'),
        tree: !!m.querySelector('.ws-pr-files .files-tree'),
        reviewButton: !!byText('button', 'Review changes') || !!byText('button', 'Finish your review'),
        status: m.querySelector('.ws-status-bar')?.innerText.replace(/\\s+/g, ' '),
        copyLink: m.innerHTML.includes('Copy pull request link'),
      }
      r.fail = !(r.pulls > 0 && r.chat && r.merge && r.files && r.tree && r.reviewButton && /files viewed/.test(r.status) && r.copyLink)
      return r
    `,
  },
  {
    name: 'pull requests: commits and one commit’s changes',
    js: `${helpers}
      const link = [...main().querySelectorAll('.ws-pr-code .ws-tab')].find((a) => a.textContent.includes('Commits'))
      link.click()
      const commit = await until(() => main().querySelector('.ws-pr-code .ws-list-row'), 15000)
      commit?.click()
      const diff = await until(() => main().querySelector('.ws-pr-code .file-diff'), 15000)
      const r = { commit: !!commit, diff: !!diff }
      r.fail = !(r.commit && r.diff)
      byText('.ws-pr-code a', 'Show all changes')?.click()
      return r
    `,
  },
  {
    name: 'actions: runs beside the chosen run',
    screenshot: 'actions',
    js: `${helpers}
      ;[...document.querySelectorAll('.ws-tabs a')].filter((a) => a.getClientRects().length).find((a) => a.textContent.includes('Actions')).click()
      const row = await until(() => main()?.querySelector('.ws-list-row.is-selected'), 20000)
      await until(() => main()?.querySelector('.run-title'), 20000)
      const r = { selected: !!row, title: main()?.querySelector('.run-title')?.innerText.slice(0, 80), copy: !!main()?.innerHTML.includes('Copy link to this run') }
      r.fail = !(r.selected && r.title && r.copy)
      return r
    `,
  },
  {
    name: 'a repository only on GitHub shows its branches and commits',
    screenshot: 'github-only',
    js: `${helpers}
      clickLink('/jqlang/jq')
      await until(() => main()?.querySelector('.ws-branch-head'), 15000)
      await until(() => main()?.querySelector('.ws-section .ws-row'), 15000)
      await until(() => main()?.querySelector('.file-diff'), 15000)
      const text = main().innerText
      const r = { sidebar: main().querySelectorAll('.ws-list').length, commits: main().querySelectorAll('.ws-section .ws-row').length, diff: !!main().querySelector('.file-diff'), toolbar: !!byText('.ws-seg-value', 'Clone repository') }
      r.fail = !(r.sidebar === 0 && r.commits > 0 && r.diff && r.toolbar)
      return r
    `,
  },
  {
    name: 'the top menu picks a branch of a repository only on GitHub, and the tab title follows',
    js: `${helpers}
      const seg = () => [...document.querySelectorAll('.ws-header .ws-seg-branch')].find((s) => s.getClientRects().length)
      await until(() => activeTab().textContent.trim().startsWith('jq - '), 10000)
      const before = activeTab().textContent.trim()
      seg().click()
      const items = await until(() => { const l = [...document.querySelectorAll('[role=menuitemradio]')]; return l.length > 1 && l }, 8000)
      if (!items) return { fail: true, error: 'no branch menu', before }
      const item = items.find((i) => i.getAttribute('aria-checked') !== 'true')
      const name = item.textContent.trim().replace(/(Default branch|On GitHub)$/, '').trim()
      if (!item) return { fail: true, error: 'branch not in menu', name, items: items.length }
      item.click()
      const moved = await until(() => activeTab().textContent.trim() === 'jq - ' + name, 5000)
      const row = await until(() => main()?.querySelector('.ws-branch-title')?.textContent.includes(name), 5000)
      const r = { before, name, title: activeTab().textContent.trim(), seg: seg().innerText, row: !!row }
      r.fail = !(moved && row && seg().innerText.includes(name))
      return r
    `,
  },
  {
    name: 'tabs: Cmd-click stays in the repository’s tab, and another repository opens in the background',
    js: `${helpers}
      clickLink('/jqlang/jq/issues', { metaKey: true })
      clickLink('/PlaygrndLabs/gh-ui/pull/2', { metaKey: true, text: 'Some pull request' })
      await until(() => tabs().length === 3)
      await until(() => main()?.innerText.includes('Issues') || location.pathname !== '/', 5000)
      const r = { tabs: tabTitles(), active: tabName(activeTab()) }
      r.fail = !(r.tabs.length === 3 && r.active === 'jq' && r.tabs[2] === 'gh-ui')
      return r
    `,
  },
  {
    name: 'tabs: a link can open no tab outside the app',
    js: `${helpers}
      clickLink('/..//evil.example/x', { metaKey: true })
      await until(() => tabs().length === 4, 2000)
      // It resolves to a path that names another host, so the most it can open is a dashboard.
      const r = { tabs: tabTitles() }
      r.fail = !(r.tabs.length === 4 && r.tabs.filter((t) => t === 'New tab').length === 2) || r.tabs.some((t) => t.includes('evil'))
      tabs()[r.tabs.lastIndexOf('New tab')].parentElement.querySelector('.tab-close').click()
      await until(() => tabs().length === 3, 2000)
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
      const header = [...document.querySelectorAll('.ws-header')].filter((h) => h.getClientRects().length).length
      const before = document.activeElement
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
      const inputs = [...document.querySelectorAll('input[aria-label="Search or jump to"]')]
      const focused = inputs.filter((i) => i === document.activeElement)
      const r = { active: tabName(activeTab()), shown, header, searchBoxes: inputs.length, focusVisible: focused[0]?.getClientRects().length > 0 }
      r.fail = !(r.active === 'New tab' && shown === 1 && header === 1 && r.focusVisible)
      focused[0]?.blur(); before?.focus?.()
      return r
    `,
  },
  {
    name: 'a new tab offers repositories to open',
    screenshot: 'start-page',
    js: `${helpers}
      await until(() => main()?.querySelector('.ws-home .ws-picker-row'), 10000)
      const r = { title: main()?.querySelector('.ws-home-title')?.textContent, rows: main()?.querySelectorAll('.ws-picker-row').length, top: main()?.innerText.includes('Top repositories'), home: !!main()?.querySelector('.dashboard-main'), clone: !![...main().querySelectorAll('.ws-picker-actions button')].find((b) => b.textContent.includes('Clone')) }
      r.fail = !(r.title && r.rows > 0 && !r.top && r.home && !r.clone)
      return r
    `,
  },
  {
    name: 'the inbox lists what needs attention across repositories',
    screenshot: 'inbox',
    js: `${helpers}
      const button = [...document.querySelectorAll('.ws-tool')].filter((b) => b.getClientRects().length).find((b) => b.textContent.includes('Inbox'))
      button.click()
      const panel = await until(() => document.querySelector('.ws-inbox'), 5000)
      await until(() => document.querySelector('.ws-inbox .ws-list-row, .ws-inbox .ws-note, .ws-inbox .error-box'), 15000)
      const r = { panel: !!panel, rows: document.querySelectorAll('.ws-inbox .ws-list-row').length, text: panel?.innerText.slice(0, 160), error: !!document.querySelector('.ws-inbox .error-box') }
      r.fail = !(r.panel && !r.error)
      await sleep(100)
      return r
    `,
  },
  {
    name: 'closing the inbox',
    js: `${helpers}
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(200)
      if (document.querySelector('.ws-inbox')) [...document.querySelectorAll('.ws-tool')].filter((b) => b.getClientRects().length).find((b) => b.textContent.includes('Inbox')).click()
      await until(() => !document.querySelector('.ws-inbox'), 2000)
      return { closed: !document.querySelector('.ws-inbox') }
    `,
  },
  {
    name: 'tabs: Cmd+9 goes to the last tab, which mounts on first show',
    accelerator: 'CmdOrCtrl+9',
    js: `${helpers}
      await until(() => activeTab() === tabs()[tabs().length - 1])
      await until(() => (main()?.innerText.length ?? 0) > 50, 15000)
      const r = { active: tabName(activeTab()), chars: main()?.innerText.length }
      r.fail = !(r.active === 'gh-ui' && r.chars > 50)
      return r
    `,
  },
  {
    name: 'tabs: Cmd+W closes',
    accelerator: 'CmdOrCtrl+W',
    js: `${helpers}
      await until(() => tabs().length === 2)
      const r = { afterClose: tabTitles() }
      r.fail = r.afterClose.length !== 2
      return r
    `,
  },
  {
    name: 'tabs: Cmd+Shift+T reopens',
    accelerator: 'CmdOrCtrl+Shift+T',
    js: `${helpers}
      await until(() => tabs().length === 3)
      const r = { tabs: tabTitles(), active: tabName(activeTab()) }
      r.fail = !(r.tabs.length === 3 && r.active === 'gh-ui')
      return r
    `,
  },
  {
    name: 'tabs: navigate inside the active tab',
    js: `${helpers}
      clickLink('/PlaygrndLabs/gh-ui/releases')
      const url = await until(() => savedActiveUrl() === '/PlaygrndLabs/gh-ui/releases' && savedActiveUrl(), 5000)
      const r = { url, tabs: tabTitles() }
      r.fail = !(url && r.tabs.length === 3)
      return r
    `,
  },
  {
    name: 'tabs: Back acts on the active tab only',
    accelerator: 'CmdOrCtrl+[',
    js: `${helpers}
      const url = await until(() => savedActiveUrl().endsWith('/pull/2') && savedActiveUrl(), 5000)
      const r = { url, tabs: tabTitles(), active: tabName(activeTab()) }
      r.fail = !(url && r.active === 'gh-ui' && r.tabs[0] === 'New tab' && r.tabs[1] === 'jq')
      return r
    `,
  },
  {
    name: 'tabs: a link to another repository moves to its tab instead of opening another',
    js: `${helpers}
      clickLink('/jqlang/jq/releases')
      await until(() => tabName(activeTab()) === 'jq', 5000)
      const r = { tabs: tabTitles(), active: tabName(activeTab()), url: await until(() => savedActiveUrl() === '/jqlang/jq/releases' && savedActiveUrl(), 5000) }
      r.fail = !(r.tabs.length === 3 && r.active === 'jq' && r.url)
      clickLink('/PlaygrndLabs/gh-ui/pull/2')
      await until(() => tabName(activeTab()) === 'gh-ui', 5000)
      return r
    `,
  },
  {
    name: 'tabs: the state is saved per account',
    js: `${helpers}
      const accounts = JSON.parse((await g.secrets.get('accounts')) || '[]')
      const saved = JSON.parse(localStorage.getItem('gh-ui:tabs:' + accounts[0].id))
      const r = { saved: saved.tabs.map((t) => t.url), closed: saved.closed.length, active: saved.tabs.find((t) => t.id === saved.activeId)?.url }
      r.fail = !(r.saved.length === 3 && r.saved[1].startsWith('/jqlang/jq') && r.active === '/PlaygrndLabs/gh-ui/pull/2')
      return r
    `,
  },
  {
    name: 'tabs: a form with text in it',
    accelerator: 'CmdOrCtrl+T',
    js: `${helpers}
      await until(() => tabs().length === 4)
      // The repository has a tab, so the link goes there and leaves the new tab behind.
      clickLink('/PlaygrndLabs/gh-ui/issues/new')
      const title = await until(() => main()?.querySelector('input[aria-label="Title"]'))
      if (!title) return { fail: true, error: 'no issue form', text: main()?.innerText.slice(0, 120) }
      tabs()[tabs().length - 1].parentElement.querySelector('.tab-close').click()
      await until(() => tabs().length === 3)
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
      await until(() => tabs().length === 4)
      await sleep(3000)
      return { tabs: tabTitles() }
    `,
  },
  {
    name: 'tabs: the page navigated while it was hidden',
    accelerator: 'Ctrl+Shift+Tab',
    js: `${helpers}
      await until(() => tabName(activeTab()) === 'gh-ui', 3000)
      await until(() => !main()?.querySelector('input[aria-label="Title"]'), 3000)
      const r = { form: !!main().querySelector('input[aria-label="Title"]'), posts: window.__posts, active: tabName(activeTab()) }
      window.fetch = window.__fetch
      r.fail = r.form || r.posts !== 1 || r.active !== 'gh-ui'
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
      r.fail = !(r.tabs.length === 1 && r.tabs[0] === 'New tab')
      return r
    `,
  },
  {
    name: 'open the Wiki tab of jqlang/jq',
    js: `${helpers}
      // The wiki starts switched off; a change made elsewhere arrives as a storage event.
      localStorage.setItem('gh-ui:features', JSON.stringify({ wiki: true }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'gh-ui:features' }))
      await sleep(500)
      clickLink('/jqlang/jq/wiki')
      return true
    `,
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
      return { cloning: true, tab: tabName(activeTab()) }
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
    name: 'a folder with no GitHub repository opens in its own tab',
    js: `${helpers}
      const repos = await g.repos.list()
      const local = repos.find((r) => r.path === ${j(LOCAL)})
      clickLink('/local/' + local.id)
      await until(() => tabs().length === 2, 5000)
      return { repos: repos.map((r) => r.name), tabs: tabTitles() }
    `,
    waitMs: 1500,
  },
  {
    name: 'local repo view and its toolbar',
    screenshot: 'local-repo',
    js: `${helpers}
      await until(() => (main()?.innerText ?? '').includes('scratch.txt'))
      await until(() => byText('.ws-seg-value', 'Publish repository'), 5000)
      const text = main()?.innerText ?? ''
      const r = {
        showsUntracked: text.includes('scratch.txt'),
        commitButton: !!byText('button', 'Commit to main'),
        branch: !!byText('.ws-seg-value', 'main'),
        sync: !!byText('.ws-seg-value', 'Publish repository'),
        navigation: [...document.querySelectorAll('.ws-tabs')].filter((n) => n.getClientRects().length).map((n) => n.innerText.includes('Branches'))[0],
      }
      r.fail = !(r.showsUntracked && r.commitButton && r.branch && r.sync && r.navigation)
      return r
    `,
  },
  {
    name: 'branches: stage, commit and undo through the page',
    screenshot: 'branches-commit',
    js: `${helpers}
      const box = () => main().querySelector('input[aria-label="Stage scratch.txt"]')
      await until(box)
      box().click()
      await until(() => box()?.checked)
      const summary = main().querySelector('input[aria-label="Commit summary"]')
      setInput(summary, 'Add scratch')
      await sleep(200)
      byText('button', 'Commit 1 file').click()
      const row = await until(() => [...main().querySelectorAll('.ws-section[aria-label="Only on this Mac"] .ws-row')].find((c) => c.textContent.includes('Add scratch')))
      const r = { committed: !!row, cleared: !box() }
      await until(() => main().querySelector('.file-diff'))
      r.diffShown = !!main().querySelector('.file-diff')
      r.fail = !(r.committed && r.cleared && r.diffShown)
      return r
    `,
  },
  {
    name: 'branches: undo puts the commit back into the changes',
    js: `${helpers}
      byText('button', 'Undo last commit').click()
      const entry = await until(() => main().querySelector('input[aria-label="Stage scratch.txt"]'))
      const summary = main().querySelector('input[aria-label="Commit summary"]').value
      const r = { entry: !!entry, stagedAgain: entry?.checked, summary }
      r.fail = !(r.entry && r.stagedAgain && r.summary === 'Add scratch')
      return r
    `,
  },
  {
    name: 'branches: create a branch, and switch back from the top menu',
    js: `${helpers}
      const seg = [...document.querySelectorAll('button.ws-seg-branch')].find((b) => b.getClientRects().length)
      seg.click()
      const field = await until(() => document.querySelector('input[aria-label="Filter or name a new branch"]'), 3000)
      setInput(field, 'side')
      const create = await until(() => byText('[role^=menuitem]', 'Create branch side'), 3000)
      create.click()
      const created = await until(() => byText('.ws-seg-value', 'side'), 10000)
      ;[...document.querySelectorAll('.ws-header .ws-seg-branch')].find((x) => x.getClientRects().length).click()
      const main0 = await until(() => byText('[role^=menuitem]', 'main'), 5000)
      main0?.click()
      const r = { created: !!created, sidebar: !main()?.querySelector('.ws-branch') }
      r.switched = !!(await until(() => byText('.ws-seg-value', 'main'), 10000))
      r.fail = !(r.created && r.switched)
      return r
    `,
  },
  {
    name: 'panes: drag a divider with the real pointer',
    inputJs: `${helpers}
      const handle = [...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length)
      window.__width = Number(handle.getAttribute('aria-valuenow'))
      window.__pointer = []
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, (e) => window.__pointer.push(type + ':' + e.clientX), true)
      const box = handle.getBoundingClientRect()
      const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + 40)
      return [
        { type: 'mouseMove', x, y },
        { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
        { type: 'mouseMove', x: x + 30, y, button: 'left' },
        { type: 'mouseMove', x: x + 60, y, button: 'left' },
        { type: 'mouseUp', x: x + 60, y, button: 'left', clickCount: 1 },
      ]
    `,
    js: `${helpers}
      const handle = [...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length)
      // Synthetic input can arrive late or merged in a window that isn't on screen, so how far it got can vary.
      await until(() => Number(handle.getAttribute('aria-valuenow')) === window.__width + 60, 3000)
      const r = { before: window.__width, after: Number(handle.getAttribute('aria-valuenow')), pointer: window.__pointer }
      r.fail = !(r.after > r.before && r.after <= r.before + 60)
      return r
    `,
  },
  {
    name: 'panes: arrow keys, collapse, restore, and remembering',
    js: `${helpers}
      const handle = () => [...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length)
      const before = Number(handle().getAttribute('aria-valuenow'))
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await sleep(100)
      const after = Number(handle().getAttribute('aria-valuenow'))
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const strip = await until(() => document.querySelector('[aria-label="Show Timeline"]'), 2000)
      const saved = JSON.parse(localStorage.getItem('gh-ui:pane:branch-timeline'))
      strip?.click()
      await until(() => !document.querySelector('[aria-label="Show Timeline"]'), 2000)
      const r = { before, after, strip: !!strip, saved }
      r.fail = !(after === before + 20 && r.strip && saved.collapsed === 'first')
      return r
    `,
  },
  {
    name: 'a folder without GitHub asks to publish for pull requests',
    js: `${helpers}
      const tab = [...document.querySelectorAll('.ws-tabs a')].filter((a) => a.getClientRects().length).find((a) => a.textContent.includes('Pull requests'))
      tab.click()
      const shown = await until(() => main()?.innerText.includes('to use pull requests'), 5000)
      const r = { shown: !!shown, button: !!byText('button', 'Publish repository') }
      r.fail = !(r.shown && r.button)
      ;[...document.querySelectorAll('.ws-tabs a')].filter((a) => a.getClientRects().length).find((a) => a.textContent.includes('Branches')).click()
      await until(() => main()?.querySelector('.ws-branch-head'), 5000)
      return r
    `,
  },
  {
    name: 'the repository picker lists folders and opens one',
    js: `${helpers}
      document.querySelector('.ws-tab-add').click()
      await until(() => document.querySelector('.ws-picker-row'), 5000)
      const names = [...document.querySelectorAll('.ws-picker-name')].map((n) => n.textContent.trim())
      const r = { names, hasFolder: names.includes('e2e-local'), hasVisited: names.includes('jqlang/jq') }
      r.fail = !(r.hasFolder && r.hasVisited)
      byText('.ws-picker-main', 'e2e-local')?.click()
      await until(() => !document.querySelector('.ws-picker'), 3000)
      r.tabs = tabTitles()
      r.fail = r.fail || r.tabs.length !== 2
      return r
    `,
  },
  {
    name: 'a folder’s tab reads repo - branch',
    js: `${helpers}
      const title = await until(() => activeTab().textContent.trim() === 'e2e-local - main', 8000)
      return { title: activeTab().textContent.trim(), fail: !title }
    `,
  },
  {
    name: 'a branch’s sections are tabs, and the details follow them',
    screenshot: 'branch-tabs',
    js: `${helpers}
      const tab = (name) => [...main().querySelectorAll('.ws-branch-tabs [role=tab]')].find((t) => t.textContent.includes(name))
      const names = [...main().querySelectorAll('.ws-branch-tabs [role=tab]')].map((t) => t.textContent.trim())
      const opened = main().querySelector('.ws-branch-tabs [aria-selected=true]')?.textContent
      tab('On GitHub').click()
      const github = await until(() => main().innerText.includes('isn’t on GitHub yet'), 3000)
      tab('On this Mac').click()
      const rows = await until(() => main().querySelectorAll('.ws-section[aria-label="Only on this Mac"] .ws-row').length, 3000)
      const sections = main().querySelectorAll('.ws-section').length
      const title = await until(() => activeTab().textContent.trim() === 'e2e-local - main', 3000)
      const r = { names, opened, github: !!github, rows, sections, title: activeTab().textContent.trim() }
      r.fail = !(names.length === 3 && github && rows > 0 && sections === 1 && title)
      return r
    `,
  },
  {
    name: 'panes: dragging well past the edge hides a pane, with the real pointer',
    inputJs: `${helpers}
      const box = [...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length).getBoundingClientRect()
      const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + 40)
      window.__width = Number([...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length).getAttribute('aria-valuenow'))
      const end = Math.max(2, x - 400)
      window.__log = []
      const h = [...document.querySelectorAll('.ws-divider-handle')].find((el) => el.getClientRects().length)
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) h.addEventListener(type, (e) => window.__log.push(type + ':' + e.clientX))
      return [
        { type: 'mouseMove', x, y },
        { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
        { type: 'mouseMove', x: end + 40, y, button: 'left' },
        { type: 'mouseMove', x: end, y, button: 'left' },
        { type: 'mouseUp', x: end, y, button: 'left', clickCount: 1 },
        { type: 'mouseMove', x: end + 1, y },
      ]
    `,
    js: `${helpers}
      // A window that isn't on screen can hold back the real release, so send it if it hasn't come.
      await sleep(500)
      if (!window.__log.some((l) => l.startsWith('pointerup'))) [...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length)?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 2 }))
      const strip = await until(() => document.querySelector('[aria-label="Show Timeline"]'), 4000)
      return { strip: !!strip, buttons: document.querySelectorAll('.ws-divider-button').length, width: window.__width, log: window.__log, handles: [...document.querySelectorAll('.ws-divider-handle')].filter((h) => h.getClientRects().length).map((h) => h.getAttribute('aria-label') + '=' + h.getAttribute('aria-valuenow')), fail: !strip }
    `,
  },
  {
    name: 'panes: dragging out of the strip brings the pane back',
    js: `${helpers}
      const strip = document.querySelector('[aria-label="Show Timeline"]')
      const box = strip.getBoundingClientRect()
      strip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: box.left }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + 240 }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: box.left + 240 }))
      const gone = await until(() => !document.querySelector('[aria-label="Show Timeline"]'), 4000)
      const width = Number([...document.querySelectorAll('.ws-divider-handle')].find((h) => h.getClientRects().length)?.getAttribute('aria-valuenow'))
      return { gone: !!gone, width, fail: !(gone && width >= 180) }
    `,
  },
  {
    name: 'the toolbar clones, and a folder that already holds the repository opens instead',
    screenshot: 'clone-existing',
    js: `${helpers}
      const repo = (await g.repos.list()).find((r) => r.name === 'e2e-local')
      await g.git(repo.id, ['remote', 'add', 'origin', 'https://github.com/acme/e2e.git'])
      ;[...document.querySelectorAll('.ws-tool')].find((t) => t.getClientRects().length && t.textContent.includes('Clone')).click()
      const dlg = await until(() => document.querySelector('[role=dialog]'), 5000)
      if (!dlg) return { fail: true, error: 'no clone dialog' }
      const inputs = [...dlg.querySelectorAll('input')]
      setInput(inputs.find((i) => i.placeholder.startsWith('Choose a parent')), ${j(path.dirname(LOCAL || '/'))})
      setInput(inputs[inputs.length - 1], 'e2e-local')
      setInput(inputs.find((i) => i.placeholder.startsWith('https://')), 'https://github.com/other/thing.git')
      const other = await until(() => dlg.innerText.includes('clone of another repository'), 5000)
      const disabled = byText('[role=dialog] button', 'Clone')?.disabled
      setInput(inputs.find((i) => i.placeholder.startsWith('https://')), 'git@github.com:acme/e2e.git')
      const same = await until(() => dlg.innerText.includes('already cloned at'), 5000)
      const open = byText('[role=dialog] button', 'Open existing folder')
      open?.click()
      const closed = await until(() => !document.querySelector('[role=dialog]'), 5000)
      // Its origin now makes this folder a GitHub repository, so the tab moved there and keeps its branch.
      const title = await until(() => activeTab().textContent.trim() === 'e2e - main', 8000)
      const r = { other: !!other, disabled, same: !!same, open: !!open, closed: !!closed, title: activeTab().textContent.trim() }
      r.fail = !(other && disabled && same && open && closed && title)
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
