import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Connect ignores promises from async middleware, so a throw there (e.g. new URL on a
// malformed path) would become an unhandled rejection and kill the dev server.
function parseRequestUrl(req: IncomingMessage, res: ServerResponse): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost')
  } catch {
    res.statusCode = 400
    res.end('bad request')
    return null
  }
}

// Mirrors /api/gh-login in worker/index.ts: device flow against github.com or the
// host named by ?host=, never forwarding a client secret.
async function deviceFlowProxy(req: IncomingMessage, res: ServerResponse) {
  const url = parseRequestUrl(req, res)
  if (!url) return
  const host = (url.searchParams.get('host') ?? 'github.com').toLowerCase()
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  if (url.pathname !== '/login/device/code' && url.pathname !== '/login/oauth/access_token') {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'invalid host' }))
    return
  }
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = new URLSearchParams(Buffer.concat(chunks).toString())
    body.delete('client_secret')
    const upstream = await fetch(`https://${host}${url.pathname}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'gh-ui' },
      body,
    })
    res.statusCode = upstream.status
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
    res.end(await upstream.text())
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
    }
    res.end(JSON.stringify({ error: `upstream fetch failed: ${(err as Error).message}` }))
  }
}

// Dev-only bridge so the browser build can borrow the local `gh` CLI session,
// mirroring what the Electron shell does over IPC. Never part of a production build.
function ghCliDevBridge(): Plugin {
  return {
    name: 'gh-ui-gh-cli-dev-bridge',
    apply: 'serve',
    // `vite preview` has no Worker either, so it needs the device-flow proxy too.
    configurePreviewServer(server) {
      server.middlewares.use('/api/gh-login', deviceFlowProxy)
    },
    configureServer(server) {
      server.middlewares.use('/api/gh-login', deviceFlowProxy)
      server.middlewares.use('/__dev/gh-token', (req, res) => {
        const url = parseRequestUrl(req, res)
        if (!url) return
        const host = url.searchParams.get('host') || 'github.com'
        if (!/^[a-z0-9.-]+$/i.test(host)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid host' }))
          return
        }
        execFile('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000 }, (err, stdout, stderr) => {
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          if (err) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: (stderr || err.message).trim() }))
            return
          }
          res.end(JSON.stringify({ token: stdout.trim() }))
        })
      })
      // Mirrors /api/gh/job-logs in worker/index.ts: follow the log redirect without the token.
      server.middlewares.use('/api/gh/job-logs', async (req, res) => {
        const url = parseRequestUrl(req, res)
        if (!url) return
        const owner = url.searchParams.get('owner') ?? ''
        const repo = url.searchParams.get('repo') ?? ''
        const job = url.searchParams.get('job') ?? ''
        const api = url.searchParams.get('api') ?? 'https://api.github.com'
        if (!/^\d+$/.test(job) || !/^https:\/\//.test(api) || !req.headers.authorization) {
          res.statusCode = 400
          res.end('bad request')
          return
        }
        // Connect ignores the returned promise, so a rejected fetch would crash the dev server.
        try {
          const first = await fetch(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${job}/logs`, {
            headers: { authorization: req.headers.authorization, accept: 'application/vnd.github+json' },
            redirect: 'manual',
          })
          const location = first.status >= 300 && first.status < 400 ? first.headers.get('location') : null
          const final = location ? await fetch(location) : first
          res.statusCode = final.status
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(await final.text())
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 502
            res.setHeader('content-type', 'text/plain; charset=utf-8')
          }
          res.end(`upstream fetch failed: ${(err as Error).message}`)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), ghCliDevBridge()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
})
