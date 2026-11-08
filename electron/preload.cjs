// Exposes the NativeBridge contract (src/lib/platform.ts) to the renderer.
const { contextBridge, ipcRenderer, webFrame } = require('electron')

const versionArg = process.argv.find((a) => a.startsWith('--gh-ui-version='))

contextBridge.exposeInMainWorld('ghUi', {
  platform: process.platform,
  version: versionArg ? versionArg.split('=')[1] : '0.0.0',
  zoomFactor: () => webFrame.getZoomFactor(),
  secrets: {
    get: (key) => ipcRenderer.invoke('secrets:get', key),
    set: (key, value) => ipcRenderer.invoke('secrets:set', key, value),
    delete: (key) => ipcRenderer.invoke('secrets:delete', key),
    isEncrypted: () => ipcRenderer.invoke('secrets:isEncrypted'),
  },
  ghCliToken: (host) => ipcRenderer.invoke('gh:token', host),
  http: (req) => ipcRenderer.invoke('http', req),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  installKind: () => ipcRenderer.invoke('app:installKind'),
  openTerminal: () => ipcRenderer.invoke('app:openTerminal'),
  pickDirectory: (title) => ipcRenderer.invoke('dialog:pickDirectory', title),
  repos: {
    list: () => ipcRenderer.invoke('repos:list'),
    add: (path) => ipcRenderer.invoke('repos:add', path),
    remove: (id) => ipcRenderer.invoke('repos:remove', id),
    cloneTarget: (parentDir, name) => ipcRenderer.invoke('repos:cloneTarget', parentDir, name),
    clone: (url, parentDir, name, auth) => ipcRenderer.invoke('repos:clone', url, parentDir, name, auth),
    addWorktree: (repoId, parentDir, branch) => ipcRenderer.invoke('repos:addWorktree', repoId, parentDir, branch),
  },
  git: (repoId, args, auth) => ipcRenderer.invoke('git', repoId, args, auth),
  revealInFinder: (repoId) => ipcRenderer.invoke('repo:reveal', repoId),
  openInEditor: (repoId) => ipcRenderer.invoke('repo:openEditor', repoId),
  contextMenu: (items) => ipcRenderer.invoke('menu:popup', items),
  onMenu: (handler) => {
    const listener = (_e, action) => handler(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  },
})
