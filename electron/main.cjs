// gh-ui desktop shell. Serves the built SPA over app://gh-ui (so the router
// and absolute asset paths work like on the web) and exposes a narrow IPC surface:
// encrypted secrets, the gh CLI token, CORS-free requests to GitHub hosts, and
// allow-listed git commands inside repositories the user registered.

const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, safeStorage, Menu, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { pathToFileURL } = require('node:url')

// Only outside a packaged app: anything that can set the environment could otherwise point the window, and with it
// the whole bridge, at a page of its choosing.
const DEV_URL = app.isPackaged ? undefined : process.env.GH_UI_DEV_URL
const DIST = path.join(__dirname, '..', 'dist')
const APP_ORIGIN = 'app://gh-ui'
const isMac = process.platform === 'darwin'

// Tests run against a throwaway profile so they never touch real accounts or repos.
if (process.env.GH_UI_USER_DATA) app.setPath('userData', path.resolve(process.env.GH_UI_USER_DATA))

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

// GUI apps on macOS don't inherit the shell PATH; make git/gh/code findable.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(require('node:os').homedir(), '.local/bin')]
const ENV_PATH = [...new Set([...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_PATH])].filter(Boolean).join(path.delimiter)

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

// ---------------------------------------------------------------------------
// Persistent state in userData

const dataFile = (name) => path.join(app.getPath('userData'), name)

async function readJson(name, fallback) {
  let raw
  try {
    raw = await fsp.readFile(dataFile(name), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw e // Unreadable isn't empty: answering "nothing there" here would let the next write replace it.
  }
  try {
    return JSON.parse(raw)
  } catch {
    // Kept to one side, because the next write would otherwise replace whatever could still be saved from it.
    await fsp.rename(dataFile(name), dataFile(`${name}.corrupt-${Date.now()}`)).catch(() => {})
    return fallback
  }
}

async function writeJson(name, value) {
  await fsp.mkdir(app.getPath('userData'), { recursive: true })
  const tmp = dataFile(`${name}.tmp`)
  // Flushed before the rename, so a crash leaves the old file or the new one and never an empty one.
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flush: true })
  await fsp.rename(tmp, dataFile(name))
}

const fileQueues = new Map()

/** Read, change, write, one at a time per file: two changes at once would otherwise each save over the other. */
function updateJson(name, fallback, change) {
  const result = (fileQueues.get(name) ?? Promise.resolve()).then(async () => {
    const next = change(await readJson(name, fallback))
    await writeJson(name, next)
    return next
  })
  fileQueues.set(name, result.catch(() => {}))
  return result
}

// Secrets: encrypted with the OS keychain via safeStorage when available. A throwaway
// test profile (GH_UI_USER_DATA) skips the keychain so automated runs never prompt.
const canEncrypt = () => !process.env.GH_UI_USER_DATA && safeStorage.isEncryptionAvailable()

async function secretsGet(key) {
  const store = await readJson('secrets.json', {})
  const entry = store[key]
  if (!entry) return null
  if (entry.enc) {
    if (!canEncrypt()) return null
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
  }
  return entry.value
}

async function secretsSet(key, value) {
  const entry = canEncrypt()
    ? { enc: true, value: safeStorage.encryptString(String(value)).toString('base64') }
    : { enc: false, value: String(value) }
  await updateJson('secrets.json', {}, (store) => ({ ...store, [key]: entry }))
}

async function secretsDelete(key) {
  await updateJson('secrets.json', {}, ({ [key]: _removed, ...rest }) => rest)
}

// ---------------------------------------------------------------------------
// Process helpers

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 5 * 60_000, cwd: opts.cwd, env: { ...process.env, PATH: ENV_PATH, ...opts.env } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code !== 1 ? err.message : '')) })
      },
    )
  })
}

const { HOST_RE, gitAuthEnv, validateGitArgs, worktreeFolder, gitCommandEnv, GIT_BASE_ENV } = require('./git-policy.cjs')

// ---------------------------------------------------------------------------
// Local repository registry

// Every git command looks its repository up, and only this file's own code changes the list, so it's read once.
let reposCache = null

async function listRepos() {
  return (reposCache ??= await readJson('repos.json', []))
}

async function changeRepos(change) {
  reposCache = await updateJson('repos.json', [], change)
}

async function addRepo(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Choose an absolute folder path')
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: GIT_BASE_ENV, timeout: 20_000 })
  if (top.code !== 0) throw new Error(`${dir} is not a git repository`)
  const root = path.resolve(top.stdout.trim())
  let repo
  await changeRepos((repos) => {
    repo = repos.find((r) => r.path === root)
    if (repo) return repos
    repo = { id: crypto.randomUUID(), path: root, name: path.basename(root), addedAt: Date.now() }
    return [...repos, repo]
  })
  return repo
}

async function repoById(id) {
  const repo = (await listRepos()).find((r) => r.id === id)
  if (!repo) throw new Error('Unknown repository')
  return repo
}

function isSafeRemote(url) {
  return typeof url === 'string' && (/^https:\/\/[^\s]+$/.test(url) || /^git@[\w.-]+:[\w./-]+$/.test(url) || /^ssh:\/\/[^\s]+$/.test(url)) && !url.startsWith('-')
}

// ---------------------------------------------------------------------------
// HTTP for GitHub endpoints without CORS

function isPrivateHost(host) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  // An IPv6 address: loopback, unique-local, link-local, or an IPv4 address written as one.
  if (name.includes(':')) return name === '::' || name === '::1' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name) || name.startsWith('::ffff:')
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(name) || /^172\.(1[6-9]|2\d|3[01])\./.test(name)
}

async function httpRequest(req) {
  const url = new URL(req.url)
  if (url.protocol !== 'https:' || isPrivateHost(url.hostname)) throw new Error('Only public https URLs are allowed')
  const headers = { 'user-agent': 'gh-ui', ...(req.headers || {}) }
  // body is a string, or a Uint8Array for binary uploads (release assets to uploads.github.com).
  let res = await net.fetch(url.toString(), { method: req.method || 'GET', headers, body: req.body, redirect: 'manual' })
  // Follow one redirect (Actions logs → pre-signed blob URL) without the token.
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    const next = new URL(res.headers.get('location'), url)
    if (next.protocol !== 'https:' || isPrivateHost(next.hostname)) throw new Error('Refusing a redirect to a non-public address')
    res = await net.fetch(next.toString(), { headers: { 'user-agent': 'gh-ui' } })
  }
  const outHeaders = {}
  res.headers.forEach((v, k) => (outHeaders[k] = v))
  return { status: res.status, headers: outHeaders, body: await res.text() }
}

// ---------------------------------------------------------------------------
// IPC

/** Only the app's own top-level page may use the bridge; a frame or anything navigated-to gets nothing. */
function fromApp(e) {
  const frame = e.senderFrame
  return !!frame && frame === e.sender.mainFrame && isAppUrl(frame.url)
}

function registerIpc() {
  const handle = (channel, listener) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromApp(e)) throw new Error('Not allowed')
      return listener(e, ...args)
    })

  handle('secrets:get', (_e, key) => secretsGet(String(key)))
  handle('secrets:set', (_e, key, value) => secretsSet(String(key), value))
  handle('secrets:delete', (_e, key) => secretsDelete(String(key)))
  handle('secrets:isEncrypted', () => canEncrypt())

  handle('gh:token', async (_e, host) => {
    if (!HOST_RE.test(host || '')) return { error: 'Invalid host' }
    const res = await run('gh', ['auth', 'token', '--hostname', host], { timeout: 15_000 })
    if (res.code !== 0) return { error: (res.stderr || 'gh is not installed or not signed in').trim() }
    return { token: res.stdout.trim() }
  })

  handle('http', (_e, req) => httpRequest(req))

  handle('shell:openExternal', async (_e, url) => {
    const u = new URL(String(url))
    if (['https:', 'http:', 'mailto:'].includes(u.protocol)) await shell.openExternal(u.toString())
  })

  // A Homebrew install keeps its record in the Caskroom. Nothing outside these fixed paths is touched.
  handle('app:installKind', () =>
    process.platform === 'darwin' && ['/opt/homebrew/Caskroom/gh-ui', '/usr/local/Caskroom/gh-ui', '/opt/homebrew/Caskroom/github-ui', '/usr/local/Caskroom/github-ui'].some((dir) => fs.existsSync(dir)) ? 'homebrew' : 'direct',
  )
  handle('app:openTerminal', async () => {
    if (process.platform === 'darwin') await shell.openPath('/System/Applications/Utilities/Terminal.app')
  })

  // A right-click menu drawn by the system. Items are plain data from the page: an id and a label each, or a separator.
  handle('menu:popup', (e, items) => showContextMenu(e.sender, items))

  handle('dialog:pickDirectory', async (e, title) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  handle('repos:list', () => listRepos())
  handle('repos:add', (_e, dir) => addRepo(dir))
  handle('repos:remove', async (_e, id) => {
    await changeRepos((repos) => repos.filter((r) => r.id !== id))
  })
  // What's already at the place a clone would go, so the dialog can say before anything runs.
  handle('repos:cloneTarget', async (_e, parentDir, name) => {
    if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir) || typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') return { exists: false }
    const dest = path.join(parentDir, name)
    const stat = await fsp.stat(dest).catch(() => null)
    if (!stat) return { exists: false, path: dest }
    if (!stat.isDirectory()) return { exists: true, path: dest, isRepo: false, origin: null }
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dest, env: GIT_BASE_ENV })
    const isRepo = top.code === 0 && top.stdout.trim() === (await fsp.realpath(dest))
    const origin = isRepo ? await run('git', ['remote', 'get-url', 'origin'], { cwd: dest, env: GIT_BASE_ENV }) : null
    return { exists: true, path: dest, isRepo, origin: origin?.code === 0 ? origin.stdout.trim() : null }
  })
  handle('repos:clone', async (_e, url, parentDir, name, auth) => {
    if (!isSafeRemote(url)) throw new Error('Enter an https:// or SSH clone URL')
    if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid folder name')
    if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir)) throw new Error('Choose a parent folder')
    const stat = await fsp.stat(parentDir).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`${parentDir} does not exist`)
    const dest = path.join(parentDir, name)
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`)
    const res = await run('git', ['clone', '--', url, dest], { env: { ...GIT_BASE_ENV, ...gitAuthEnv(auth) }, timeout: 30 * 60_000 })
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'git clone failed')
    return addRepo(dest)
  })

  // Its own channel, as cloning is: the renderer's git commands never name a folder outside their repository.
  handle('repos:addWorktree', async (_e, repoId, parentDir, branch) => {
    const repo = await repoById(repoId)
    const name = worktreeFolder(repo.name, branch)
    if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir)) throw new Error('Choose a parent folder')
    const dest = path.join(parentDir, name)
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`)
    const res = await run('git', ['worktree', 'add', '--', dest, branch], { cwd: repo.path, env: GIT_BASE_ENV })
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree add failed')
    return addRepo(dest)
  })

  handle('git', async (_e, repoId, args, auth) => {
    const repo = await repoById(repoId)
    validateGitArgs(args)
    const network = ['push', 'pull', 'fetch'].includes(args[0])
    return run('git', args, { cwd: repo.path, env: { ...gitCommandEnv(args[0]), ...(network ? gitAuthEnv(auth) : {}) } })
  })

  handle('repo:reveal', async (_e, repoId) => shell.showItemInFolder((await repoById(repoId)).path))
  handle('repo:openTerminal', async (_e, repoId) => {
    const repo = await repoById(repoId)
    if (isMac) await run('open', ['-a', 'Terminal', repo.path], { timeout: 15_000 })
    else await shell.openPath(repo.path)
  })
  handle('menu:state', (_e, state) => setRepoMenuState(state))
  handle('repo:openEditor', async (_e, repoId) => {
    const repo = await repoById(repoId)
    const res = await run('code', [repo.path], { timeout: 15_000 })
    if (res.code !== 0) await shell.openPath(repo.path)
  })
}

// ---------------------------------------------------------------------------
// Window and menu

let mainWindow = null

function sendMenu(action) {
  mainWindow?.webContents.send('menu', action)
}

let repoMenuState = null

/** Only the focused tab's repository decides what these menus offer, so the menu is rebuilt when that changes. */
function setRepoMenuState(state) {
  const flag = (name) => state?.[name] === true
  const next = state && typeof state === 'object'
    ? { folder: flag('folder'), github: flag('github'), remote: flag('remote'), branch: flag('branch'), upstream: flag('upstream'), changes: flag('changes'), onMain: flag('onMain'), busy: flag('busy'), main: String(state.main ?? '').slice(0, 100) }
    : null
  if (JSON.stringify(next) === JSON.stringify(repoMenuState)) return
  repoMenuState = next
  buildMenu()
}

/**
 * GitHub Desktop's menus and shortcuts, apart from a few that would take a key this app already uses: Reopen Tab has
 * Cmd+Shift+T, Toggle Agent Cmd+Shift+A, Close Window Cmd+Shift+W, and Cmd+I is italic in the comment box.
 */
function repoMenus() {
  const s = repoMenuState ?? {}
  const item = (label, action, enabled, accelerator) => ({ label, accelerator, enabled: !!enabled, click: () => sendMenu(`repo:${action}`) })
  const idle = s.folder && !s.busy
  const onBranch = idle && s.branch
  const separator = { type: 'separator' }
  return [
    {
      label: 'Repository',
      submenu: [
        item('Push', 'push', s.remote && s.branch, 'CmdOrCtrl+P'),
        item('Pull', 'pull', s.upstream, 'CmdOrCtrl+Shift+P'),
        item('Fetch', 'fetch', s.remote, 'CmdOrCtrl+Alt+T'),
        item('Remove…', 'remove', s.folder),
        separator,
        item('View on GitHub', 'view-github', s.github, 'CmdOrCtrl+Shift+G'),
        item('Open in Terminal', 'terminal', s.folder, 'Ctrl+`'),
        item(isMac ? 'Show in Finder' : 'Show in Folder', 'finder', s.folder, 'CmdOrCtrl+Shift+F'),
        item('Open in Editor', 'editor', s.folder, 'CmdOrCtrl+Alt+A'),
        separator,
        item('Create Issue on GitHub', 'create-issue', s.github),
        separator,
        item('New Worktree…', 'new-worktree', onBranch, 'CmdOrCtrl+Alt+W'),
        separator,
        item('Repository Settings…', 'settings', s.folder),
      ],
    },
    {
      label: 'Branch',
      submenu: [
        item('New Branch…', 'new-branch', idle, 'CmdOrCtrl+Shift+N'),
        item('Rename…', 'rename', onBranch && !s.onMain, 'CmdOrCtrl+Shift+R'),
        item('Delete…', 'delete', onBranch && !s.onMain && s.main, 'CmdOrCtrl+Shift+D'),
        separator,
        item('Discard All Changes…', 'discard-all', idle && s.changes, 'CmdOrCtrl+Shift+Backspace'),
        item('Stash All Changes', 'stash-all', idle && s.changes, 'CmdOrCtrl+Shift+S'),
        separator,
        item(`Update from ${s.main || 'Default Branch'}`, 'update-from-main', onBranch && s.main && !s.onMain, 'CmdOrCtrl+Shift+U'),
        item('Merge into Current Branch…', 'merge', onBranch, 'CmdOrCtrl+Shift+M'),
        item('Squash and Merge into Current Branch…', 'squash', onBranch, 'CmdOrCtrl+Shift+H'),
        item('Rebase Current Branch…', 'rebase', onBranch, 'CmdOrCtrl+Shift+E'),
        separator,
        item('Compare on GitHub', 'compare-github', s.github && s.upstream && s.main, 'CmdOrCtrl+Shift+C'),
        item('View Branch on GitHub', 'view-branch', s.github && s.upstream, 'CmdOrCtrl+Alt+B'),
        item('Create Pull Request', 'create-pull', s.github && s.upstream && s.main && !s.onMain, 'CmdOrCtrl+R'),
      ],
    },
  ]
}

// Page contents can't reach these directly: a tab's history and page live in the renderer, so every action goes to it.
function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => sendMenu('new-tab') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenu('reopen-tab') },
        { type: 'separator' },
        // Closes the tab, never the window: closing the last tab leaves a fresh dashboard.
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-tab') },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Agent', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendMenu('toggle-agent') },
        { label: 'Split View', accelerator: 'CmdOrCtrl+\\', click: () => sendMenu('toggle-split') },
        { label: 'Focus Other Pane', accelerator: 'CmdOrCtrl+Alt+\\', click: () => sendMenu('focus-other-pane') },
        { type: 'separator' },
        // Cmd+R is Create Pull Request, as in GitHub Desktop.
        { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...repoMenus(),
    {
      label: 'Go',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+Alt+1', click: () => sendMenu('navigate:/') },
        { label: 'Pull Requests', accelerator: 'CmdOrCtrl+Alt+2', click: () => sendMenu('navigate:/pulls') },
        { label: 'Issues', accelerator: 'CmdOrCtrl+Alt+3', click: () => sendMenu('navigate:/issues') },
        { label: 'Notifications', accelerator: 'CmdOrCtrl+Alt+4', click: () => sendMenu('navigate:/notifications') },
        { label: 'Local Repositories', accelerator: 'CmdOrCtrl+Alt+5', click: () => sendMenu('navigate:/local') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => sendMenu('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => sendMenu('forward') },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => sendMenu('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => sendMenu('previous-tab') },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => sendMenu(`select-tab:${n}`) })),
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', click: () => sendMenu('select-tab:9') },
      ],
    },
    // The default menu's Close would take Cmd+W back on Windows and Linux.
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'gh-ui',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    // People move between this and their editor or terminal; a click shouldn't only bring the window forward.
    acceptFirstMouse: true,
    // Centered on the tab strip (src/styles/app.css): 36px tall, and the buttons are 14px.
    trafficLightPosition: { x: 16, y: 11 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--gh-ui-version=${app.getVersion()}`],
    },
  })
  mainWindow.loadURL(DEV_URL || `${APP_ORIGIN}/`)
  mainWindow.on('closed', () => (mainWindow = null))
  // The window buttons hide in full screen, so the tab strip stops leaving room for them.
  const sendFullScreen = () => sendMenu(`fullscreen:${mainWindow.isFullScreen()}`)
  mainWindow.on('enter-full-screen', sendFullScreen)
  mainWindow.on('leave-full-screen', sendFullScreen)
  mainWindow.webContents.on('did-finish-load', sendFullScreen)
  if (process.env.GH_UI_E2E && !app.isPackaged) e2eTest(mainWindow, process.env.GH_UI_E2E)
  else if (process.env.GH_UI_SMOKE_TEST) smokeTest(mainWindow)
}

const contextMenuItems = (items) =>
  (Array.isArray(items) ? items : []).slice(0, 30).map((item) =>
    item && item.type === 'separator'
      ? { type: 'separator' }
      : { id: String(item?.id ?? '').slice(0, 64), label: String(item?.label ?? '').slice(0, 120), enabled: item?.enabled !== false },
  )

/** Shows the menu at the pointer and resolves with the picked item's id, or null once it closes with nothing picked. */
function showContextMenu(sender, items) {
  const win = BrowserWindow.fromWebContents(sender)
  return new Promise((resolve) => {
    let picked = null
    const menu = Menu.buildFromTemplate(
      contextMenuItems(items).map((item) => (item.type === 'separator' ? item : { label: item.label, enabled: item.enabled, click: () => (picked = item.id) })),
    )
    // The click comes before the menu reports it closed on some platforms and after on others.
    menu.popup({ window: win ?? undefined, callback: () => setTimeout(() => resolve(picked), 0) })
  })
}

// GH_UI_E2E=<file.cjs> electron . — runs scripted steps inside the real renderer
// (through the real preload bridge), prints one JSON report and exits. Each step is
// { name, js, waitMs } or { name, accelerator, waitMs }: `js` is an async function body; `accelerator` runs the app
// menu item with that shortcut, the way pressing it does; waitMs lets navigations settle.
function e2eTest(win, file) {
  const { steps } = require(path.resolve(file))
  // The run goes on behind other windows; a covered window would otherwise stop drawing frames and steps would time out.
  win.webContents.setBackgroundThrottling(false)
  // A system menu can't be clicked from a script: a step sets window.__e2eMenuPick to the label it would pick, and the
  // menu's items are left in window.__e2eMenuItems to check.
  ipcMain.removeHandler('menu:popup')
  ipcMain.handle('menu:popup', async (e, items) => {
    const shown = contextMenuItems(items)
    const pick = await e.sender.executeJavaScript(`window.__e2eMenuItems = ${JSON.stringify(shown)}; window.__e2eMenuPick ?? null`)
    return shown.find((item) => item.label && item.label === pick)?.id ?? null
  })
  const errors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500))
    const results = []
    for (const step of steps) {
      try {
        if (step.accelerator) findMenuItem(Menu.getApplicationMenu(), step.accelerator).click()
        // Real input, for what synthetic events can't do, such as a pointer capture.
        if (step.inputJs) {
          for (const event of await win.webContents.executeJavaScript(`(async () => { ${step.inputJs} })()`)) {
            win.webContents.sendInputEvent(event)
            await new Promise((r) => setTimeout(r, 30))
          }
        }
        let result = step.js ? await win.webContents.executeJavaScript(`(async () => { ${step.js} })()`) : true
        // What a menu offers right now, as `Label (off)`.
        if (step.readMenu) {
          const menu = Menu.getApplicationMenu().items.find((m) => m.label === step.readMenu).submenu.items.filter((i) => i.label).map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`)
          result = { menu, fail: (step.expectMenu ?? []).some((label) => !menu.includes(label)) }
        }
        results.push({ step: step.name, ok: true, result })
      } catch (err) {
        results.push({ step: step.name, ok: false, error: String(err && err.message ? err.message : err) })
      }
      // For looking at the result: GH_UI_E2E_SHOTS=<folder> saves a picture of any step that names one.
      if (step.screenshot && process.env.GH_UI_E2E_SHOTS) await fsp.writeFile(path.join(process.env.GH_UI_E2E_SHOTS, `${step.screenshot}.png`), (await win.webContents.capturePage()).toPNG())
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs))
    }
    const ok = results.every((r) => r.ok && !(r.result && r.result.fail))
    process.stdout.write(JSON.stringify({ ok, results, consoleErrors: errors }, null, 1) + '\n')
    app.exit(ok ? 0 : 1)
  })
}

function findMenuItem(menu, accelerator) {
  for (const item of menu.items) {
    if (item.accelerator === accelerator) return item
    const inner = item.submenu && findMenuItem(item.submenu, accelerator)
    if (inner) return inner
  }
  return null
}

// GH_UI_SMOKE_TEST=1 electron . — loads the UI, checks the bridge, the first render and
// that Primer's styles apply at the default window size (a Primer button keeps the
// browser's 21px height without them), prints a JSON report and exits non-zero on failure (for CI).
function smokeTest(win) {
  const errors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const report = await win.webContents.executeJavaScript(
        `({ styled: (document.querySelector('button[class*="prc-Button"]') || {}).offsetHeight >= 24, url: location.href, bridge: typeof window.ghUi === 'object' && typeof window.ghUi.git === 'function', platform: window.ghUi && window.ghUi.platform, rendered: (document.getElementById('root') || {}).childElementCount > 0, title: document.title, heading: (document.querySelector('h1') || {}).textContent || null })`,
      )
      const ok = report.bridge && report.rendered && report.styled && errors.length === 0
      // Exiting right after the write can lose the text when stdout is a file or a pipe.
      process.stdout.write(JSON.stringify({ ok, ...report, errors }) + '\n', () => app.exit(ok ? 0 : 1))
    }, 2500)
  })
}

/** In-app URLs. URL.origin is "null" for custom schemes, so compare protocol + host. */
function isAppUrl(url) {
  const u = new URL(url)
  if (DEV_URL) return u.origin === new URL(DEV_URL).origin
  return u.protocol === 'app:' && u.host === 'gh-ui'
}

const appPath = (url) => {
  const { pathname, search, hash } = new URL(url)
  return pathname + search + hash
}

// The app is one document, with a router per tab, so nothing may navigate it. Windows are always denied: a link that
// reaches this (the renderer handles Cmd-click and middle-click itself) becomes a tab, and the renderer validates its path.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    // The same URL is a reload (Vite's among them), which brings the saved tabs back.
    if (url === contents.getURL()) return
    event.preventDefault()
    if (isAppUrl(url)) sendMenu(`navigate:${appPath(url)}`)
    else if (/^https?:/.test(url)) void shell.openExternal(url)
  })
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isAppUrl(url)) sendMenu(`open-tab:${disposition === 'foreground-tab' ? 'foreground' : 'background'}:${appPath(url)}`)
    else if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)))
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 })
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || stat.isDirectory()) file = path.join(DIST, 'index.html') // SPA fallback
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    if (file.endsWith('.html')) headers.set('content-security-policy', CSP)
    return new Response(res.body, { status: res.status, headers })
  })
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
