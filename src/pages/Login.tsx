import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Banner, Button, FormControl, Link as PrimerLink, Spinner, TextInput } from '@primer/react'
import { KeyIcon, TerminalIcon, MarkGithubIcon, CopyIcon, LinkExternalIcon, ServerIcon, ArrowLeftIcon } from '@primer/octicons-react'
import { useAuth, type AuthMethod } from '../lib/auth'
import { DEFAULT_HOST, normalizeHost } from '../lib/hosts'
import {
  canUseGhCli,
  DEFAULT_SCOPES,
  fetchServerConfig,
  ghCliToken,
  pollDeviceToken,
  requestDeviceCode,
  resolveClientId,
  takeWebOAuthResult,
  type DeviceCode,
  type ServerConfig,
} from '../lib/oauth'
import { openExternal, isNative } from '../lib/platform'
import { readPref, writePref } from '../lib/storage'
import { copyText } from '../lib/format'
import { safeNextPath } from '../lib/links'
import { GiUiMark } from '../components/AppHeader'

export function LoginPage() {
  const { signIn, accounts, ready } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  // Signed-in users only land here on purpose (the auth guard never sends them), so treat
  // any visit as adding an account instead of bouncing them back to the dashboard.
  const adding = params.get('add') === '1' || (ready && accounts.length > 0)
  // Set by the "Sign in again" actions when GitHub stops accepting an account's token. Only a
  // saved account counts, so a crafted link can't put its text here or point the form at another host.
  const reauthHost = normalizeHost(params.get('host') ?? DEFAULT_HOST)
  const reauth = accounts.find((a) => a.login === params.get('reauth') && a.host === reauthHost) ?? null

  const [host, setHost] = useState(() => readPref('lastHost', DEFAULT_HOST))
  const [showHost, setShowHost] = useState(host !== DEFAULT_HOST)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<AuthMethod | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [server, setServer] = useState<ServerConfig | null>(null)

  const finish = async (tok: string, method: AuthMethod, h = host) => {
    setError(null)
    setBusy(method)
    try {
      const normalized = normalizeHost(h)
      const account = await signIn(tok, method, normalized)
      writePref('lastHost', normalized)
      // Signing in again keeps the account's id, so refetch what failed with the old token.
      void queryClient.invalidateQueries({ queryKey: [account.id] })
      navigate(next, { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void fetchServerConfig().then(setServer)
    const handoff = takeWebOAuthResult()
    if (handoff && 'token' in handoff) void finish(handoff.token, 'oauth-web', handoff.host)
    else if (handoff) setError(handoff.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!reauth) return
    setHost(reauth.host)
    setShowHost(reauth.host !== DEFAULT_HOST)
  }, [reauth?.host]) // eslint-disable-line react-hooks/exhaustive-deps

  const normalizedHost = normalizeHost(host)
  const tokenUrl =
    `https://${normalizedHost}/settings/tokens/new?description=gi-ui&scopes=${encodeURIComponent(DEFAULT_SCOPES.join(','))}`
  const fineGrainedUrl = `https://${normalizedHost}/settings/personal-access-tokens/new`

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ textAlign: 'center', color: 'var(--fgColor-default)' }}>
          <GiUiMark size={48} />
        </div>
        <h1>{reauth ? 'Sign in again' : adding ? 'Add a GitHub account' : 'Sign in to gi-ui'}</h1>
        {reauth && (
          <p className="login-reauth">
            GitHub no longer accepts the saved token for <strong>{reauth.login}</strong>
            {reauth.host === DEFAULT_HOST ? '' : ` on ${reauth.host}`}. It expired or was revoked. Sign in with any method below to keep using this account.
          </p>
        )}

        {error && (
          <div className="mb-3">
            <Banner variant="critical" title="Sign-in failed" description={error} onDismiss={() => setError(null)} />
          </div>
        )}

        <div className="login-box">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (token.trim()) void finish(token, 'pat')
            }}
          >
            <FormControl required>
              <FormControl.Label>Personal access token</FormControl.Label>
              <TextInput
                block
                type="password"
                autoComplete="off"
                spellCheck={false}
                leadingVisual={KeyIcon}
                placeholder="ghp_… or github_pat_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
              <FormControl.Caption>
                Classic or fine-grained.{' '}
                <PrimerLink href={tokenUrl} onClick={(e) => (e.preventDefault(), openExternal(tokenUrl))}>
                  Create a classic token
                </PrimerLink>{' '}
                with repo, workflow, read:org, project and notifications, or a{' '}
                <PrimerLink href={fineGrainedUrl} onClick={(e) => (e.preventDefault(), openExternal(fineGrainedUrl))}>
                  fine-grained token
                </PrimerLink>{' '}
                with Contents, Pull requests, Issues, Actions, Checks and Projects access.
              </FormControl.Caption>
            </FormControl>
            <Button type="submit" variant="primary" block className="mt-3" disabled={!token.trim() || !!busy} loading={busy === 'pat'}>
              Sign in with token
            </Button>
          </form>

          <div className="login-or">or</div>

          <DeviceFlow host={normalizedHost} disabled={!!busy} onToken={(t) => finish(t, 'oauth-device')} onError={setError} />

          {canUseGhCli && (
            <Button
              block
              className="mt-2"
              leadingVisual={TerminalIcon}
              loading={busy === 'gh-cli'}
              disabled={!!busy}
              onClick={async () => {
                setError(null)
                try {
                  const t = await ghCliToken(normalizedHost)
                  await finish(t, 'gh-cli')
                } catch (err) {
                  setError(`${(err as Error).message}. Run "gh auth login${normalizedHost === DEFAULT_HOST ? '' : ` --hostname ${normalizedHost}`}" first.`)
                }
              }}
            >
              Use GitHub CLI session (gh auth token)
            </Button>
          )}

          {server?.webOAuth && normalizedHost === DEFAULT_HOST && (
            <Button
              block
              className="mt-2"
              leadingVisual={MarkGithubIcon}
              onClick={() => {
                window.location.href = `/api/oauth/start?next=${encodeURIComponent(next)}`
              }}
            >
              Sign in with GitHub (web OAuth)
            </Button>
          )}
        </div>

        <div className="mt-3 text-small fg-muted" style={{ textAlign: 'center' }}>
          {showHost ? (
            <FormControl>
              <FormControl.Label>GitHub host</FormControl.Label>
              <TextInput block leadingVisual={ServerIcon} value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com or github.example.com" />
              <FormControl.Caption>github.com, a GHE.com subdomain (acme.ghe.com) or your GitHub Enterprise Server host.</FormControl.Caption>
            </FormControl>
          ) : (
            <button type="button" className="link-muted" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setShowHost(true)}>
              Using GitHub Enterprise? Change host
            </button>
          )}
        </div>

        <p className="text-small fg-muted mt-3" style={{ textAlign: 'center' }}>
          {isNative
            ? 'Tokens are encrypted with your system keychain and never leave this device except to talk to GitHub.'
            : 'Tokens are stored in this browser’s local storage and sent only to the GitHub API. Use the desktop app for keychain-encrypted storage.'}
        </p>
        {adding && accounts.length > 0 && (
          <p style={{ textAlign: 'center' }}>
            <Link to={next} className="flex-center gap-1" style={{ justifyContent: 'center' }}>
              <ArrowLeftIcon /> Back to gi-ui
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}

function DeviceFlow({ host, disabled, onToken, onError }: { host: string; disabled: boolean; onToken(t: string): Promise<void>; onError(m: string): void }) {
  const [clientId, setClientId] = useState<string | null>(null)
  const [clientIdDraft, setClientIdDraft] = useState('')
  const [askClientId, setAskClientId] = useState(false)
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [starting, setStarting] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    void resolveClientId().then(setClientId)
    return () => abort.current?.abort()
  }, [])

  const start = async (id: string) => {
    setStarting(true)
    try {
      const dc = await requestDeviceCode(host, id)
      setCode(dc)
      void copyText(dc.user_code)
      openExternal(dc.verification_uri)
      abort.current = new AbortController()
      const token = await pollDeviceToken(host, id, dc, abort.current.signal)
      setCode(null)
      await onToken(token)
    } catch (err) {
      setCode(null)
      if ((err as Error).name !== 'AbortError') onError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  if (code) {
    return (
      <div>
        <p className="text-small" style={{ marginTop: 0 }}>
          Enter this code at{' '}
          <PrimerLink href={code.verification_uri} onClick={(e) => (e.preventDefault(), openExternal(code.verification_uri))}>
            {code.verification_uri.replace(/^https:\/\//, '')} <LinkExternalIcon size={12} />
          </PrimerLink>{' '}
          (copied to your clipboard):
        </p>
        <div className="device-code">{code.user_code}</div>
        <div className="flex-center gap-2 mt-2">
          <Spinner size="small" /> <span className="text-small fg-muted flex-1">Waiting for you to authorize on GitHub…</span>
          <Button size="small" leadingVisual={CopyIcon} onClick={() => void copyText(code.user_code)}>
            Copy
          </Button>
          <Button size="small" variant="invisible" onClick={() => abort.current?.abort()}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (askClientId || (!clientId && clientIdDraft)) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const id = clientIdDraft.trim()
          if (!id) return
          writePref('oauthClientId', id)
          setClientId(id)
          setAskClientId(false)
          void start(id)
        }}
      >
        <FormControl>
          <FormControl.Label>OAuth or GitHub App client ID</FormControl.Label>
          <TextInput block value={clientIdDraft} onChange={(e) => setClientIdDraft(e.target.value)} placeholder="Ov23li… or Iv23li…" autoFocus />
          <FormControl.Caption>
            Create an OAuth App (or GitHub App) with “Enable Device Flow” checked under Settings → Developer settings, then paste its client ID. Stored on this device only.
          </FormControl.Caption>
        </FormControl>
        <Button type="submit" block className="mt-2" disabled={!clientIdDraft.trim()}>
          Continue
        </Button>
      </form>
    )
  }

  return (
    <Button
      block
      leadingVisual={MarkGithubIcon}
      loading={starting}
      disabled={disabled}
      onClick={() => (clientId ? void start(clientId) : setAskClientId(true))}
    >
      Continue with GitHub (device code)
    </Button>
  )
}
