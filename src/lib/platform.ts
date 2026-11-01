// Contract between the React app and the Electron preload (electron/preload.cjs).
// In a plain browser (Cloudflare deploy, `vite dev`) `window.ghUi` is undefined
// and every caller must fall back to a web path or hide the feature.

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export interface LocalRepo {
  id: string
  path: string
  name: string
  addedAt: number
}

/** Lets HTTPS fetch/pull/push/clone authenticate as the signed-in account (scoped to that host). */
export interface GitAuth {
  token: string
  host: string
}

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Bytes for binary uploads (release assets). */
  body?: string | Uint8Array
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface NativeBridge {
  platform: 'darwin' | 'win32' | 'linux'
  version: string
  /** The page's zoom (View > Zoom In): the window buttons don't zoom with it. */
  zoomFactor(): number
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
    isEncrypted(): Promise<boolean>
  }
  ghCliToken(host: string): Promise<{ token?: string; error?: string }>
  /** Requests to github.com / GHES hosts that browsers block with CORS (device flow, log blobs, release uploads). */
  http(req: HttpRequest): Promise<HttpResponse>
  openExternal(url: string): Promise<void>
  pickDirectory(title?: string): Promise<string | null>
  repos: {
    list(): Promise<LocalRepo[]>
    add(path: string): Promise<LocalRepo>
    remove(id: string): Promise<void>
    clone(url: string, parentDir: string, name: string, auth?: GitAuth): Promise<LocalRepo>
  }
  /** Runs an allow-listed git subcommand inside a registered local repository. */
  git(repoId: string, args: string[], auth?: GitAuth): Promise<GitResult>
  revealInFinder(repoId: string): Promise<void>
  openInEditor(repoId: string): Promise<void>
  onMenu(handler: (action: string) => void): () => void
}

declare global {
  interface Window {
    ghUi?: NativeBridge
  }
}

export const native: NativeBridge | undefined = typeof window !== 'undefined' ? window.ghUi : undefined
export const isNative = native !== undefined
export const isDev = import.meta.env.DEV

export function openExternal(url: string) {
  if (native) void native.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
