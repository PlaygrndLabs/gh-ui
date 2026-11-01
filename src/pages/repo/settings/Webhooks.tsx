import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, FormControl, IconButton, Label, Radio, RadioGroup, Select, Spinner, TextInput, UnderlineNav, useConfirm } from '@primer/react'
import { AlertIcon, CheckIcon, DotFillIcon, KebabHorizontalIcon, PackageIcon, SyncIcon } from '@primer/octicons-react'
import type { RestEndpointMethodTypes } from '@octokit/rest'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import {
  EMPTY_WEBHOOK_FORM,
  WEBHOOK_EVENTS,
  formatHeaders,
  formatPayload,
  isValidPayloadUrl,
  webhookConfig,
  webhookEvents,
  webhookEventsSummary,
  webhookFormFromHook,
  webhookStatus,
  type WebhookEventChoice,
  type WebhookForm,
} from '../../../lib/repoSettings'
import { Blankslate, ErrorBox, Loading } from '../../../components/Bits'
import { allPages, SettingsCrumb, SettingsFlash, SettingsSubhead, useNavigateWithFlash } from './common'

type Hook = RestEndpointMethodTypes['repos']['listWebhooks']['response']['data'][number]
type Delivery = RestEndpointMethodTypes['repos']['listWebhookDeliveries']['response']['data'][number]

function useHooks() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'repo-hooks', owner, repo],
    queryFn: async () => allPages((p) => octokit.rest.repos.listWebhooks({ owner, repo, ...p })),
  })
}

/** The list's status icon and its tooltip, as github.com shows them before each payload URL. */
function HookStatusIcon({ hook }: { hook: Hook }) {
  const status = webhookStatus(hook.active, hook.last_response)
  const [icon, cls, text] =
    status === 'success'
      ? [<CheckIcon key="i" />, 'fg-success', 'Last delivery was successful.']
      : status === 'failure'
        ? [<AlertIcon key="i" />, 'fg-danger', `Last delivery was not successful. ${hook.last_response.message ?? ''}`.trim()]
        : status === 'inactive'
          ? [<DotFillIcon key="i" />, 'fg-muted', 'This hook is not active.']
          : [<DotFillIcon key="i" />, 'fg-muted', 'This hook has never been triggered.']
  return (
    // Primer's Tooltip only wraps interactive elements, so the icon carries a native title instead.
    <span className={`hook-status ${cls}`} role="img" title={text} aria-label={text}>
      {icon}
    </span>
  )
}

function useDeleteHook() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  return async (hook: Hook) => {
    const ok = await confirm({
      title: 'Delete webhook?',
      content: (
        <>
          This action cannot be undone. Future events will no longer be delivered to this webhook <span className="text-break">({hook.config.url})</span>.
        </>
      ),
      confirmButtonContent: 'Yes, delete webhook',
      confirmButtonType: 'danger',
    })
    if (!ok) return false
    await octokit.rest.repos.deleteWebhook({ owner, repo, hook_id: hook.id })
    await qc.invalidateQueries({ queryKey: [key, 'repo-hooks', owner, repo] })
    return true
  }
}

/** /settings/hooks: github.com's webhook list. */
export function WebhooksSettings() {
  const { owner, repo } = useRepo()
  const hooks = useHooks()
  const remove = useDeleteHook()
  const navigateWithFlash = useNavigateWithFlash()
  const [error, setError] = useState<string | null>(null)
  const base = `/${owner}/${repo}/settings/hooks`

  return (
    <>
      <SettingsSubhead
        title="Webhooks"
        actions={
          <Button as={Link} to={`${base}/new`}>
            Add webhook
          </Button>
        }
      />
      <SettingsFlash />
      <p className="settings-text">
        Webhooks allow external services to be notified when certain events happen. When the specified events happen, we’ll send a POST request to each of the URLs you provide. Learn more in
        our{' '}
        <a href="https://docs.github.com/webhooks/" target="_blank" rel="noreferrer">
          Webhooks Guide
        </a>
        .
      </p>
      {error && <div className="error-box mb-3">{error}</div>}
      {hooks.isLoading ? (
        <Loading />
      ) : hooks.error ? (
        <ErrorBox error={hooks.error} title="Could not load webhooks" />
      ) : hooks.data!.length === 0 ? null : (
        <div className="Box">
          {hooks.data!.map((h) => (
            <div key={h.id} className="Box-row hook-row">
              <HookStatusIcon hook={h} />
              <div className="flex-1 text-break">
                <Link to={`${base}/${h.id}`} className="hook-url">
                  {h.config.url}
                </Link>{' '}
                <span className="fg-muted">({webhookEventsSummary(h.events)})</span>
              </div>
              <Button size="small" as={Link} to={`${base}/${h.id}`}>
                Edit
              </Button>
              <Button
                size="small"
                variant="danger"
                onClick={async () => {
                  setError(null)
                  try {
                    if (await remove(h)) navigateWithFlash(base, 'Okay, that hook was successfully deleted.')
                  } catch (e) {
                    setError(errorMessage(e))
                  }
                }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** /settings/hooks/new and /settings/hooks/:id ("Manage webhook", with its Settings and Recent Deliveries tabs). */
export function WebhookPage() {
  const { owner, repo } = useRepo()
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const hooks = useHooks()
  const base = `/${owner}/${repo}/settings/hooks`
  const isNew = !id || id === 'new'
  const hook = isNew ? undefined : hooks.data?.find((h) => String(h.id) === id)
  const tab = params.get('tab') === 'deliveries' ? 'deliveries' : 'settings'

  if (!isNew && hooks.isLoading) return <Loading />
  if (!isNew && hooks.error) return <ErrorBox error={hooks.error} title="Could not load webhooks" />
  if (!isNew && !hook) return <ErrorBox error={new Error('This webhook no longer exists.')} title="Webhook not found" />

  return (
    <>
      <SettingsSubhead title={<SettingsCrumb to={base} parent="Webhooks" current={isNew ? 'Add webhook' : 'Manage webhook'} />} />
      {hook && (
        <UnderlineNav aria-label="Webhook" className="hook-tabs">
          <UnderlineNav.Item href="#" aria-current={tab === 'settings' ? 'page' : undefined} onSelect={(e) => (e.preventDefault(), setParams({}, { replace: true }))}>
            Settings
          </UnderlineNav.Item>
          <UnderlineNav.Item href="#" aria-current={tab === 'deliveries' ? 'page' : undefined} onSelect={(e) => (e.preventDefault(), setParams({ tab: 'deliveries' }, { replace: true }))}>
            Recent Deliveries
          </UnderlineNav.Item>
        </UnderlineNav>
      )}
      {hook && tab === 'deliveries' ? <RecentDeliveries hook={hook} /> : <HookForm key={hook?.id ?? 'new'} hook={hook} />}
    </>
  )
}

function HookForm({ hook }: { hook?: Hook }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const navigateWithFlash = useNavigateWithFlash()
  const remove = useDeleteHook()
  const [form, setForm] = useState<WebhookForm>(() => (hook ? webhookFormFromHook(hook) : EMPTY_WEBHOOK_FORM))
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof WebhookForm>(k: K, v: WebhookForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const list = `/${owner}/${repo}/settings/hooks`
  // GitHub masks a saved secret as "********"; the field appears only after "Change secret".
  const hasSecret = !!hook?.config.secret

  const save = useMutation({
    mutationFn: async () => {
      const events = webhookEvents(form)
      if (hook) {
        // Octokit reads a `url` parameter as the request URL, so the config (whose payload URL is `url`) goes as the raw body.
        await octokit.request('PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config', { owner, repo, hook_id: hook.id, data: webhookConfig(form) })
        await octokit.rest.repos.updateWebhook({ owner, repo, hook_id: hook.id, active: form.active, events })
      } else {
        await octokit.rest.repos.createWebhook({ owner, repo, name: 'web', active: form.active, events, config: webhookConfig(form) })
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [key, 'repo-hooks', owner, repo] })
      // GitHub sends a ping event to every new active hook.
      navigateWithFlash(
        list,
        hook
          ? 'Okay, the hook was successfully updated.'
          : form.active
            ? 'Okay, that hook was successfully created. We sent a ping payload to test it out!'
            : 'Okay, that hook was successfully created.',
      )
    },
    onError: (e) => setError(errorMessage(e)),
  })

  const urlInvalid = !!form.url.trim() && !isValidPayloadUrl(form.url)
  const noEvents = form.eventChoice === 'custom' && form.events.length === 0

  return (
    <form
      className="hook-form"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <p className="settings-text">
        We’ll send a <code>POST</code> request to the URL below with details of any subscribed events. You can also specify which data format you’d like to receive (JSON,{' '}
        <code>x-www-form-urlencoded</code>, <em>etc</em>). More information can be found in{' '}
        <a href="https://docs.github.com/webhooks/" target="_blank" rel="noreferrer">
          our developer documentation
        </a>
        .
      </p>
      <FormControl required className="settings-field hook-field">
        <FormControl.Label>Payload URL</FormControl.Label>
        <TextInput block type="url" placeholder="https://example.com/postreceive" value={form.url} onChange={(e) => set('url', e.target.value)} autoFocus={!hook} />
        {urlInvalid && <FormControl.Validation variant="error">Payload URL must be an absolute http:// or https:// URL.</FormControl.Validation>}
      </FormControl>
      <FormControl required className="settings-field hook-field">
        <FormControl.Label>Content type</FormControl.Label>
        <Select value={form.contentType} onChange={(e) => set('contentType', e.target.value as WebhookForm['contentType'])}>
          <Select.Option value="form">application/x-www-form-urlencoded</Select.Option>
          <Select.Option value="json">application/json</Select.Option>
        </Select>
      </FormControl>
      {hasSecret && form.secret === null ? (
        <div className="settings-field">
          <div className="text-bold mb-1">Secret</div>
          <p className="settings-text hook-secret-note">
            There is currently a secret configured for this webhook. If you’ve lost or forgotten this secret, you can change it, but be aware that any integrations using this secret will need to be
            updated.{' '}
            <Button size="small" onClick={() => set('secret', '')}>
              Change secret
            </Button>
          </p>
        </div>
      ) : (
        <FormControl className="settings-field hook-field">
          <FormControl.Label>Secret</FormControl.Label>
          <TextInput block type="password" autoComplete="new-password" value={form.secret ?? ''} onChange={(e) => set('secret', e.target.value)} autoFocus={hasSecret} />
          {hasSecret && <FormControl.Caption>Leave blank to remove the secret.</FormControl.Caption>}
        </FormControl>
      )}

      <div className="settings-field">
        <div className="text-bold">SSL verification</div>
        <p className="settings-text hook-ssl-note">
          By default, we verify SSL certificates when delivering payloads.
        </p>
        <RadioGroup name="hook-ssl" className="hook-ssl">
          <RadioGroup.Label visuallyHidden>SSL verification</RadioGroup.Label>
          <FormControl layout="horizontal">
            <Radio value="enable" checked={!form.insecureSsl} onChange={() => set('insecureSsl', false)} />
            <FormControl.Label>Enable SSL verification</FormControl.Label>
          </FormControl>
          <FormControl layout="horizontal">
            <Radio
              value="disable"
              checked={form.insecureSsl}
              onChange={async () => {
                const ok = await confirm({
                  title: 'Are you sure?',
                  content: 'Disabling SSL verification is not recommended. Without it, payloads could be read or changed by anyone between GitHub and your server.',
                  confirmButtonContent: 'Disable, I understand my webhooks may not be secure',
                  confirmButtonType: 'danger',
                })
                if (ok) set('insecureSsl', true)
              }}
            />
            <FormControl.Label>Disable (not recommended)</FormControl.Label>
          </FormControl>
        </RadioGroup>
      </div>

      <hr className="hook-rule" />
      <RadioGroup name="hook-events" className="settings-field">
        <RadioGroup.Label className="text-bold">Which events would you like to trigger this webhook?</RadioGroup.Label>
        {(
          [
            ['push', 'Just the push event.'],
            ['all', 'Send me everything.'],
            ['custom', 'Let me select individual events.'],
          ] as Array<[WebhookEventChoice, string]>
        ).map(([value, label]) => (
          <FormControl key={value}>
            <Radio
              value={value}
              checked={form.eventChoice === value}
              onChange={() => setForm((f) => ({ ...f, eventChoice: value, events: value === 'custom' && f.events.length === 0 ? ['push'] : f.events }))}
            />
            <FormControl.Label>{label}</FormControl.Label>
          </FormControl>
        ))}
      </RadioGroup>
      {form.eventChoice === 'custom' && (
        <fieldset className="hook-events">
          <legend className="sr-only">Individual events</legend>
          {WEBHOOK_EVENTS.map((ev) => (
            <FormControl key={ev.id}>
              <Checkbox
                checked={form.events.includes(ev.id)}
                onChange={(e) => set('events', e.target.checked ? [...form.events, ev.id] : form.events.filter((x) => x !== ev.id))}
              />
              <FormControl.Label>{ev.label}</FormControl.Label>
              <FormControl.Caption>{ev.description}</FormControl.Caption>
            </FormControl>
          ))}
          {form.events
            .filter((e) => !WEBHOOK_EVENTS.some((ev) => ev.id === e))
            .map((e) => (
              <FormControl key={e}>
                <Checkbox checked onChange={() => set('events', form.events.filter((x) => x !== e))} />
                <FormControl.Label>{e}</FormControl.Label>
                <FormControl.Caption>Subscribed through the API.</FormControl.Caption>
              </FormControl>
            ))}
        </fieldset>
      )}
      <hr className="hook-rule" />
      <FormControl className="settings-field">
        <Checkbox checked={form.active} onChange={(e) => set('active', e.target.checked)} />
        <FormControl.Label>Active</FormControl.Label>
        <FormControl.Caption>We will deliver event details when this hook is triggered.</FormControl.Caption>
      </FormControl>

      {error && <div className="error-box mb-3">{error}</div>}
      <div className="hook-actions">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={save.isPending || !form.url.trim() || urlInvalid || noEvents}>
          {hook ? 'Update webhook' : 'Add webhook'}
        </Button>
        {hook && (
          <Button
            variant="danger"
            onClick={async () => {
              setError(null)
              try {
                if (await remove(hook)) navigateWithFlash(list, 'Okay, that hook was successfully deleted.')
              } catch (e) {
                setError(errorMessage(e))
              }
            }}
          >
            Delete webhook
          </Button>
        )}
      </div>
    </form>
  )
}

/** github.com's delivery timestamp: "2026-10-31 04:02:03" in local time. */
function deliveryTime(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The Recent Deliveries tab: GET /hooks/{id}/deliveries, each row expanding to its request and response. */
function RecentDeliveries({ hook }: { hook: Hook }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const [open, setOpen] = useState<string | null>(null)
  const deliveries = useQuery({
    queryKey: [key, 'hook-deliveries', owner, repo, hook.id],
    queryFn: async () => (await octokit.rest.repos.listWebhookDeliveries({ owner, repo, hook_id: hook.id, per_page: 50 })).data,
  })

  if (deliveries.isLoading) return <Loading />
  if (deliveries.error) return <ErrorBox error={deliveries.error} title="Could not load recent deliveries" />
  if (deliveries.data!.length === 0)
    return (
      <div className="Box">
        <Blankslate icon={<PackageIcon size={24} />} title="There are no recent deliveries">
          {hook.active ? 'Deliveries appear here once an event this webhook subscribes to happens.' : 'This webhook is not active, so no events are delivered to it.'}
        </Blankslate>
      </div>
    )
  return (
    <div className="Box hook-deliveries">
      {deliveries.data!.map((d) => (
        <DeliveryRow key={String(d.id)} hook={hook} delivery={d} expanded={open === String(d.id)} onToggle={() => setOpen(open === String(d.id) ? null : String(d.id))} />
      ))}
    </div>
  )
}

function DeliveryRow({ hook, delivery: d, expanded, onToggle }: { hook: Hook; delivery: Delivery; expanded: boolean; onToggle(): void }) {
  const ok = d.status_code >= 200 && d.status_code < 300
  return (
    <div className="hook-delivery">
      <div className="Box-row hook-delivery-row">
        <span className={ok ? 'fg-success' : 'fg-danger'} aria-label={ok ? 'Succeeded' : 'Failed'}>
          {ok ? <CheckIcon /> : <AlertIcon />}
        </span>
        <button type="button" className="hook-delivery-guid text-mono" aria-expanded={expanded} onClick={onToggle}>
          {d.guid}
        </button>
        {d.redelivery && (
          <Label variant="secondary" size="small">
            <SyncIcon size={12} /> redelivery
          </Label>
        )}
        <Label variant="secondary" size="small">
          {d.event}
          {d.action ? `.${d.action}` : ''}
        </Label>
        <span className="flex-1" />
        <span className="fg-muted text-small">{deliveryTime(d.delivered_at)}</span>
        <IconButton icon={KebabHorizontalIcon} size="small" variant="invisible" aria-label={expanded ? 'Hide delivery details' : 'Show delivery details'} aria-expanded={expanded} onClick={onToggle} />
      </div>
      {expanded && <DeliveryDetails hook={hook} delivery={d} />}
    </div>
  )
}

function DeliveryDetails({ hook, delivery }: { hook: Hook; delivery: Delivery }) {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [tab, setTab] = useState<'request' | 'response'>('request')
  const [error, setError] = useState<string | null>(null)
  const detail = useQuery({
    // Delivery ids outgrow Number.MAX_SAFE_INTEGER and arrive as BigInt, which query keys can't serialize.
    queryKey: [key, 'hook-delivery', owner, repo, hook.id, String(delivery.id)],
    staleTime: Infinity,
    queryFn: async () => (await octokit.rest.repos.getWebhookDelivery({ owner, repo, hook_id: hook.id, delivery_id: delivery.id })).data,
  })
  const redeliver = useMutation({
    mutationFn: async () => octokit.rest.repos.redeliverWebhookDelivery({ owner, repo, hook_id: hook.id, delivery_id: delivery.id }),
    // The redelivery shows up as a new row once GitHub has sent it.
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: [key, 'hook-deliveries', owner, repo, hook.id] }), 1500),
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <div className="hook-delivery-details">
      <div className="hook-delivery-toolbar">
        <UnderlineNav aria-label="Delivery">
          <UnderlineNav.Item href="#" aria-current={tab === 'request' ? 'page' : undefined} onSelect={(e) => (e.preventDefault(), setTab('request'))}>
            Request
          </UnderlineNav.Item>
          <UnderlineNav.Item href="#" aria-current={tab === 'response' ? 'page' : undefined} onSelect={(e) => (e.preventDefault(), setTab('response'))}>
            Response <Label variant={delivery.status_code >= 200 && delivery.status_code < 300 ? 'success' : 'danger'} size="small">{delivery.status_code || '—'}</Label>
          </UnderlineNav.Item>
        </UnderlineNav>
        <Button
          size="small"
          leadingVisual={SyncIcon}
          loading={redeliver.isPending}
          disabled={redeliver.isPending || redeliver.isSuccess}
          onClick={async () => {
            setError(null)
            const ok = await confirm({
              title: 'Redeliver payload?',
              content: 'Are you sure you want to redeliver this payload?',
              confirmButtonContent: 'Yes, redeliver this payload',
            })
            if (ok) redeliver.mutate()
          }}
        >
          {redeliver.isSuccess ? 'Redelivered' : 'Redeliver'}
        </Button>
      </div>
      {error && <div className="error-box mt-2">{error}</div>}
      {detail.isLoading ? (
        <div className="p-3">
          <Spinner size="small" srText="Loading delivery" />
        </div>
      ) : detail.error ? (
        <ErrorBox error={detail.error} title="Could not load this delivery" />
      ) : tab === 'request' ? (
        <>
          <h4 className="hook-delivery-heading">Headers</h4>
          <pre className="hook-delivery-pre">{formatHeaders(detail.data!.request.headers)}</pre>
          <h4 className="hook-delivery-heading">Payload</h4>
          <pre className="hook-delivery-pre">{formatPayload(detail.data!.request.payload)}</pre>
        </>
      ) : (
        <>
          <h4 className="hook-delivery-heading">Headers</h4>
          <pre className="hook-delivery-pre">{formatHeaders(detail.data!.response.headers) || '(none)'}</pre>
          <h4 className="hook-delivery-heading">Body</h4>
          <pre className="hook-delivery-pre">{formatPayload(detail.data!.response.payload) || '(empty)'}</pre>
        </>
      )}
      <div className="fg-muted text-small mt-2">Completed in {delivery.duration.toFixed(2)} seconds.</div>
    </div>
  )
}
