import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { Avatar, Button, FormControl, Label, NavList, Radio, RadioGroup, Select, TextInput, Textarea, ToggleSwitch, Banner } from '@primer/react'
import { PersonIcon, PaintbrushIcon, ChecklistIcon, DownloadIcon, SparkleFillIcon, KeyIcon, PersonAddIcon, ShieldLockIcon } from '@primer/octicons-react'
import { useAuth, AUTH_METHOD_LABEL, reauthPath } from '../lib/auth'
import { useSwitchAccount } from '../lib/TabsProvider'
import { TOKEN_KIND_LABEL } from '../lib/hosts'
import { THEME_LABEL, useAppTheme, type ThemeChoice } from '../lib/theme'
import { useAgent } from '../lib/agent/AgentProvider'
import { MODELS, getAnthropicKey, setAnthropicKey, type Effort } from '../lib/agent/settings'
import { isNative, native } from '../lib/platform'
import { readPref, writePref } from '../lib/storage'
import { FEATURES, useFeatures, type Feature } from '../lib/features'
import { fetchServerConfig, type ServerConfig } from '../lib/oauth'
import { useStartUpdate, useUpdateCheck } from '../components/UpdateNotice'

export function SettingsPage() {
  const { pathname } = useLocation()
  const { section } = useParams()
  const item = (to: string, label: string, Icon: React.ElementType) => (
    <NavList.Item as={Link} to={to} aria-current={pathname === to ? 'page' : undefined}>
      <NavList.LeadingVisual>
        <Icon />
      </NavList.LeadingVisual>
      {label}
    </NavList.Item>
  )
  return (
    <div className="container-xl">
      <div className="layout-sidebar-left" style={{ gridTemplateColumns: '256px minmax(0,1fr)' }}>
        <NavList aria-label="Settings">
          {item('/settings', 'Accounts', PersonIcon)}
          {item('/settings/appearance', 'Appearance', PaintbrushIcon)}
          {item('/settings/features', 'Features', ChecklistIcon)}
          {item('/settings/agent', 'Agent', SparkleFillIcon)}
          {item('/settings/oauth', 'OAuth app', ShieldLockIcon)}
          {isNative && item('/settings/updates', 'Updates', DownloadIcon)}
        </NavList>
        <div>
          {section === 'appearance' ? <AppearanceSettings /> : section === 'features' ? <FeatureSettings /> : section === 'updates' ? <UpdateSettings /> : section === 'agent' ? <AgentSettingsPanel /> : section === 'oauth' ? <OAuthSettings /> : <AccountsSettings />}
        </div>
      </div>
    </div>
  )
}

function AccountsSettings() {
  const { accounts, active, rejected, signOut } = useAuth()
  const switchTo = useSwitchAccount()
  return (
    <>
      <div className="subhead">
        <h2>Accounts</h2>
        <Button as={Link} to="/login?add=1" leadingVisual={PersonAddIcon}>
          Add account
        </Button>
      </div>
      <div className="Box">
        {accounts.map((a) => (
          <div key={a.id} className="Box-row" style={{ alignItems: 'center' }}>
            <Avatar src={a.avatarUrl} size={40} />
            <div className="flex-1">
              <div className="flex-center gap-2 wrap">
                <strong>{a.login}</strong>
                {a.name && <span className="fg-muted">{a.name}</span>}
                {a.id === active?.id && <Label variant="success">Active</Label>}
                {rejected.has(a.id) && <Label variant="danger">Token expired or revoked</Label>}
              </div>
              <div className="text-small fg-muted">
                {a.host} · {AUTH_METHOD_LABEL[a.method]} · {TOKEN_KIND_LABEL[a.kind]}
              </div>
              <div className="text-small fg-muted">
                {a.scopes === null ? 'Fine-grained permissions (no OAuth scopes)' : a.scopes.length ? `Scopes: ${a.scopes.join(', ')}` : 'No scopes granted'}
                {a.scopes && !a.scopes.includes('workflow') && a.scopes.length > 0 && (
                  <span className="fg-attention"> · without “workflow”, editing files under .github/workflows will fail</span>
                )}
              </div>
            </div>
            {rejected.has(a.id) && (
              <Button as={Link} size="small" variant="primary" to={reauthPath(a, '/settings')}>
                Sign in again
              </Button>
            )}
            {a.id !== active?.id && (
              <Button size="small" onClick={() => void switchTo(a.id)}>
                Switch
              </Button>
            )}
            <Button size="small" variant="danger" onClick={() => void signOut(a.id)}>
              Sign out
            </Button>
          </div>
        ))}
      </div>
      <p className="fg-muted text-small mt-3">
        {isNative ? 'Tokens are encrypted at rest with Electron safeStorage (macOS Keychain, Windows DPAPI, libsecret).' : 'In the browser, tokens live in localStorage for this origin only.'} Signing out removes the token from gh-ui; revoke it on GitHub to invalidate it everywhere.
      </p>
    </>
  )
}

function AppearanceSettings() {
  const { theme, setTheme } = useAppTheme()
  return (
    <>
      <div className="subhead">
        <h2>Appearance</h2>
      </div>
      <RadioGroup name="theme" onChange={(v) => v && setTheme(v as ThemeChoice)}>
        <RadioGroup.Label>Theme</RadioGroup.Label>
        {(Object.keys(THEME_LABEL) as ThemeChoice[]).map((t) => (
          <FormControl key={t}>
            <Radio value={t} checked={theme === t} onChange={() => setTheme(t)} />
            <FormControl.Label>{THEME_LABEL[t]}</FormControl.Label>
          </FormControl>
        ))}
      </RadioGroup>
    </>
  )
}

function UpdateSettings() {
  const { current, latest, available, homebrew, query } = useUpdateCheck()
  const { copied, start } = useStartUpdate(latest, homebrew)
  const status = query.isFetching ? 'Checking…' : query.isError ? 'Could not reach GitHub.' : available ? `Version ${latest} is available.` : latest ? 'You have the latest version.' : 'No release found.'
  return (
    <>
      <div className="subhead">
        <h2>Updates</h2>
      </div>
      <p className="mb-1">
        Version <span className="text-bold">{current}</span>, installed {homebrew ? 'with Homebrew' : 'from a download'}.
      </p>
      <p className="fg-muted mb-3" role="status">
        {copied ? 'Command copied. Paste it in Terminal, then restart the app.' : status}
      </p>
      <div className="flex-center gap-2">
        {available && (
          <Button variant="primary" onClick={() => void start()}>
            {homebrew ? 'Update with Homebrew' : 'Download'}
          </Button>
        )}
        <Button loading={query.isFetching} onClick={() => void query.refetch()}>
          Check now
        </Button>
      </div>
    </>
  )
}

function FeatureSettings() {
  const { isOn, setFeature } = useFeatures()
  const keys = Object.keys(FEATURES) as Feature[]
  const groups = [...new Set(keys.map((k) => FEATURES[k].group))]
  return (
    <>
      <div className="subhead">
        <h2>Features</h2>
      </div>
      <p className="fg-muted mb-3">Choose what the app shows. Anything switched off is one click away here, and its data is kept.</p>
      {groups.map((group) => (
        <section key={group} className="mb-4">
          <h3 className="feature-group">{group}</h3>
          <div className="Box">
            {keys
              .filter((k) => FEATURES[k].group === group)
              .map((k) => (
                <div key={k} className="Box-row feature-row">
                  <div className="flex-1">
                    <div className="text-bold" id={`feature-${k}`}>
                      {FEATURES[k].label}
                    </div>
                    <div className="fg-muted text-small">{FEATURES[k].description}</div>
                  </div>
                  <ToggleSwitch size="small" aria-labelledby={`feature-${k}`} checked={isOn(k)} onClick={() => setFeature(k, !isOn(k))} />
                </div>
              ))}
          </div>
        </section>
      ))}
    </>
  )
}

function AgentSettingsPanel() {
  const { settings, updateSettings } = useAgent()
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [server, setServer] = useState<ServerConfig | null>(null)
  const [encrypted, setEncrypted] = useState<boolean | null>(null)

  useEffect(() => {
    void getAnthropicKey().then((k) => setHasKey(!!k))
    void fetchServerConfig().then(setServer)
    void native?.secrets.isEncrypted().then(setEncrypted)
  }, [])

  return (
    <>
      <div className="subhead">
        <h2>Agent</h2>
      </div>
      <div className="flex" style={{ flexDirection: 'column', gap: 24, maxWidth: 640 }}>
        {!isNative && (
          <RadioGroup name="mode" onChange={(v) => v && updateSettings({ mode: v as 'direct' | 'proxy' })}>
            <RadioGroup.Label>Connection</RadioGroup.Label>
            <FormControl>
              <Radio value="direct" checked={settings.mode === 'direct'} onChange={() => updateSettings({ mode: 'direct' })} />
              <FormControl.Label>Use my Anthropic API key</FormControl.Label>
              <FormControl.Caption>Requests go straight from {isNative ? 'this app' : 'your browser'} to api.anthropic.com.</FormControl.Caption>
            </FormControl>
            <FormControl>
              <Radio value="proxy" checked={settings.mode === 'proxy'} onChange={() => updateSettings({ mode: 'proxy' })} />
              <FormControl.Label>Use a gh-ui Worker</FormControl.Label>
              <FormControl.Caption>
                The Cloudflare Worker holds the key and only serves GitHub users you allow (ALLOWED_GITHUB_USERS).
                {server && (server.anthropicProxy ? ' This deployment has a key configured.' : ' This deployment has no ANTHROPIC_API_KEY set.')}
              </FormControl.Caption>
            </FormControl>
          </RadioGroup>
        )}

        {settings.mode === 'direct' || isNative ? (
          <FormControl>
            <FormControl.Label>Anthropic API key</FormControl.Label>
            <div className="flex gap-2 w-100">
              <TextInput
                className="flex-1"
                type="password"
                leadingVisual={KeyIcon}
                placeholder={hasKey ? '•••••••••••• (saved)' : 'sk-ant-…'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
              />
              <Button
                disabled={!key.trim()}
                onClick={async () => {
                  await setAnthropicKey(key)
                  setKey('')
                  setHasKey(true)
                  setSaved(true)
                  setTimeout(() => setSaved(false), 2000)
                }}
              >
                {saved ? 'Saved' : 'Save'}
              </Button>
              {hasKey && (
                <Button
                  variant="danger"
                  onClick={async () => {
                    await setAnthropicKey(null)
                    setHasKey(false)
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
            <FormControl.Caption>
              {isNative
                ? `Runs locally: requests go straight from this app to api.anthropic.com. ${encrypted === false ? 'Stored unencrypted (no OS keychain available).' : 'Encrypted with your OS keychain.'}`
                : 'Stored in this browser’s local storage.'}
            </FormControl.Caption>
          </FormControl>
        ) : (
          <FormControl>
            <FormControl.Label>Worker URL</FormControl.Label>
            <TextInput block value={settings.proxyUrl} placeholder={isNative ? 'https://gh-ui.example.workers.dev' : 'Leave empty to use this site'} onChange={(e) => updateSettings({ proxyUrl: e.target.value })} />
            <FormControl.Caption>Your GitHub token is sent to the Worker so it can confirm who you are.</FormControl.Caption>
          </FormControl>
        )}

        <FormControl>
          <FormControl.Label>Model</FormControl.Label>
          <Select value={settings.model} onChange={(e) => updateSettings({ model: e.target.value })}>
            {MODELS.map((m) => (
              <Select.Option key={m.id} value={m.id}>
                {m.label} — {m.note}
              </Select.Option>
            ))}
          </Select>
        </FormControl>

        <FormControl>
          <FormControl.Label>Effort</FormControl.Label>
          <Select value={settings.effort} onChange={(e) => updateSettings({ effort: e.target.value as Effort })}>
            <Select.Option value="low">Low: quick answers</Select.Option>
            <Select.Option value="medium">Medium</Select.Option>
            <Select.Option value="high">High: thorough reviews (default)</Select.Option>
            <Select.Option value="xhigh">Extra high</Select.Option>
            <Select.Option value="max">Max: hardest problems, slowest</Select.Option>
          </Select>
          <FormControl.Caption>Higher effort reads more code and reasons longer before acting.</FormControl.Caption>
        </FormControl>

        <FormControl>
          <FormControl.Label id="auto-approve-label">Auto-approve write actions</FormControl.Label>
          <div className="flex-center gap-2">
            <ToggleSwitch aria-labelledby="auto-approve-label" size="small" checked={settings.autoApproveWrites} onClick={() => updateSettings({ autoApproveWrites: !settings.autoApproveWrites })} />
          </div>
          <FormControl.Caption>Comments, reviews, commits, re-runs and merges run without asking. Leave off unless you trust the task.</FormControl.Caption>
        </FormControl>
        {settings.autoApproveWrites && <Banner variant="warning" title="Auto-approve is on" description="The agent can post, commit and re-run without confirmation." />}

        <FormControl>
          <FormControl.Label>Standing instructions</FormControl.Label>
          <Textarea
            block
            rows={4}
            value={settings.customInstructions}
            placeholder="e.g. We use conventional commits. Prefer small focused fixes. Never touch generated files under src/gen."
            onChange={(e) => updateSettings({ customInstructions: e.target.value })}
          />
        </FormControl>
      </div>
    </>
  )
}

function OAuthSettings() {
  const [clientId, setClientId] = useState(() => readPref('oauthClientId', ''))
  const [saved, setSaved] = useState(false)
  return (
    <>
      <div className="subhead">
        <h2>OAuth app</h2>
      </div>
      <p className="fg-muted" style={{ maxWidth: 640 }}>
        “Continue with GitHub” uses the OAuth device flow, which needs the client ID of an OAuth App or GitHub App with device flow enabled. On a Cloudflare
        deployment the Worker can supply one (GITHUB_CLIENT_ID); a value here overrides it.
      </p>
      <FormControl>
        <FormControl.Label>Client ID</FormControl.Label>
        <div className="flex gap-2" style={{ maxWidth: 520 }}>
          <TextInput className="flex-1" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Ov23li…" />
          <Button
            onClick={() => {
              writePref('oauthClientId', clientId.trim())
              setSaved(true)
              setTimeout(() => setSaved(false), 2000)
            }}
          >
            {saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </FormControl>
    </>
  )
}
