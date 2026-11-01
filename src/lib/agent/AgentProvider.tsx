import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type Anthropic from '@anthropic-ai/sdk'
import { useAuth } from '../auth'
import { octokitFor } from '../github'
import { readPref, writePref } from '../storage'
import { BASE_SYSTEM_PROMPT } from './prompt'
import { createClient, describeAgentError, runAgent, type AgentEvent } from './runner'
import { getAnthropicKey, loadAgentSettings, proxyBaseUrl, saveAgentSettings, type AgentSettings } from './settings'

export interface PageContext {
  /** e.g. "pull request acme/web#42 “Fix login”" */
  label: string
  owner?: string
  repo?: string
  details?: Record<string, string | number | boolean | null | undefined>
  suggestions?: Array<{ label: string; prompt: string }>
}

export type ToolStatus = 'preparing' | 'running' | 'awaiting' | 'done' | 'error' | 'denied'

export type ChatItem =
  | { id: string; kind: 'user'; text: string; context?: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; name: string; summary: string; input?: unknown; status: ToolStatus; output?: string; write: boolean }
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'danger' }

interface AgentApi {
  open: boolean
  setOpen(open: boolean): void
  toggle(): void
  items: ChatItem[]
  running: boolean
  pageContext: PageContext | null
  setPageContext(ctx: PageContext | null): void
  /** Opens the panel and sends a message. */
  ask(text: string): void
  stop(): void
  reset(): void
  respond(toolId: string, approved: boolean): void
  settings: AgentSettings
  updateSettings(patch: Partial<AgentSettings>): void
  usage: { input: number; output: number; cacheRead: number }
}

const AgentContext = createContext<AgentApi | null>(null)

let seq = 0
const nextId = () => `i${++seq}`

function contextBlock(ctx: PageContext | null): string | undefined {
  if (!ctx) return undefined
  const lines = [`The user is viewing ${ctx.label} in gh-ui.`]
  for (const [k, v] of Object.entries(ctx.details ?? {})) if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`)
  return lines.join('\n')
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const { active } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpenState] = useState(() => readPref('agentOpen', false))
  const [items, setItems] = useState<ChatItem[]>([])
  const [running, setRunning] = useState(false)
  const [pageContext, setPageContext] = useState<PageContext | null>(null)
  const [settings, setSettings] = useState<AgentSettings>(loadAgentSettings)
  const [usage, setUsage] = useState({ input: 0, output: 0, cacheRead: 0 })

  const history = useRef<Anthropic.Beta.BetaMessageParam[]>([])
  const abort = useRef<AbortController | null>(null)
  const approvals = useRef(new Map<string, (ok: boolean) => void>())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const contextRef = useRef(pageContext)
  contextRef.current = pageContext

  // Coalesce streaming deltas so long answers don't re-render per token.
  const pending = useRef<AgentEvent[]>([])
  const flushTimer = useRef<number | null>(null)

  const applyEvents = useCallback((events: AgentEvent[]) => {
    setItems((prev) => {
      const next = [...prev]
      const lastOf = (kind: 'text' | 'thinking') => {
        const last = next[next.length - 1]
        return last && last.kind === kind ? next.length - 1 : -1
      }
      const updateTool = (id: string, patch: Partial<Extract<ChatItem, { kind: 'tool' }>>) => {
        const i = next.findIndex((x) => x.kind === 'tool' && x.id === id)
        if (i >= 0) next[i] = { ...(next[i] as Extract<ChatItem, { kind: 'tool' }>), ...patch }
        return i
      }
      for (const e of events) {
        switch (e.type) {
          case 'block':
            next.push({ id: nextId(), kind: e.kind, text: '' })
            break
          case 'text':
          case 'thinking': {
            const i = lastOf(e.type)
            if (i >= 0) next[i] = { ...(next[i] as { id: string; kind: 'text'; text: string }), text: (next[i] as { text: string }).text + e.delta }
            else next.push({ id: nextId(), kind: e.type, text: e.delta })
            break
          }
          case 'tool_start':
            next.push({ id: e.id, kind: 'tool', name: e.name, summary: e.name, status: 'preparing', write: false })
            break
          case 'tool_call':
            if (updateTool(e.id, { summary: e.summary, input: e.input, status: 'running', write: e.kind === 'write' }) < 0) {
              next.push({ id: e.id, kind: 'tool', name: e.name, summary: e.summary, input: e.input, status: 'running', write: e.kind === 'write' })
            }
            break
          case 'tool_awaiting':
            updateTool(e.id, { status: 'awaiting' })
            break
          case 'tool_result':
            updateTool(e.id, { status: e.denied ? 'denied' : e.ok ? 'done' : 'error', output: e.output })
            break
          case 'fallback':
            next.push({ id: nextId(), kind: 'notice', text: `${e.from} declined; continued with ${e.to}.`, tone: 'info' })
            break
          case 'notice':
            next.push({ id: nextId(), kind: 'notice', text: e.text, tone: 'info' })
            break
          case 'usage':
            break
        }
      }
      // Drop empty thinking blocks (display omitted or no reasoning this step).
      return next.filter((x, idx) => !(x.kind === 'thinking' && !x.text.trim() && idx < next.length - 1))
    })
  }, [])

  const flush = useCallback(() => {
    flushTimer.current = null
    const batch = pending.current
    pending.current = []
    if (batch.length) applyEvents(batch)
  }, [applyEvents])

  const onEvent = useCallback(
    (e: AgentEvent) => {
      if (e.type === 'usage') {
        setUsage((u) => ({ input: u.input + e.input, output: u.output + e.output, cacheRead: u.cacheRead + e.cacheRead }))
        return
      }
      pending.current.push(e)
      if (e.type === 'text' || e.type === 'thinking') {
        flushTimer.current ??= window.setTimeout(flush, 40)
      } else {
        if (flushTimer.current) window.clearTimeout(flushTimer.current)
        flush()
      }
    },
    [flush],
  )

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v)
    writePref('agentOpen', v)
  }, [])

  const send = useCallback(
    async (text: string) => {
      if (!active || running) return
      const ctxText = contextBlock(contextRef.current)
      setItems((prev) => [...prev, { id: nextId(), kind: 'user', text, context: contextRef.current?.label }])
      const userContent = ctxText ? `<gh_ui_context>\n${ctxText}\n</gh_ui_context>\n\n${text}` : text
      history.current.push({ role: 'user', content: userContent })

      const controller = new AbortController()
      abort.current = controller
      setRunning(true)
      const s = settingsRef.current
      const writeCalls = new Set<string>()
      let wrote = false
      try {
        const client = createClient(s, s.mode === 'direct' ? await getAnthropicKey() : null, proxyBaseUrl(s), active)
        const system = s.customInstructions.trim()
          ? `${BASE_SYSTEM_PROMPT}\n\nThe user's standing instructions:\n${s.customInstructions.trim()}`
          : BASE_SYSTEM_PROMPT
        await runAgent({
          client,
          settings: s,
          system,
          messages: history.current,
          ctx: { octokit: octokitFor(active), account: active },
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === 'tool_call' && e.kind === 'write') writeCalls.add(e.id)
            if (e.type === 'tool_result' && e.ok && writeCalls.has(e.id)) wrote = true
            onEvent(e)
          },
          approve: (call) =>
            new Promise<boolean>((resolve) => {
              approvals.current.set(call.id, resolve)
              controller.signal.addEventListener('abort', () => resolve(false), { once: true })
            }),
          // Read live so turning auto-approve off mid-run applies to the next write.
          autoApproveWrites: () => settingsRef.current.autoApproveWrites,
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          flush()
          setItems((prev) => [...prev, { id: nextId(), kind: 'notice', text: describeAgentError(err), tone: 'danger' }])
        }
      } finally {
        flush()
        // Errors and aborts can end the run with tool cards still open; nothing runs after this.
        setItems((prev) =>
          prev.map((x) =>
            x.kind === 'tool' && (x.status === 'preparing' || x.status === 'running' || x.status === 'awaiting')
              ? { ...x, status: 'error', output: x.output ?? 'Not run.' }
              : x,
          ),
        )
        approvals.current.clear()
        abort.current = null
        setRunning(false)
        // Tools may have posted comments, commits or re-runs: refresh what's on screen.
        if (wrote) void queryClient.invalidateQueries({ queryKey: [active.id] })
      }
    },
    [active, running, onEvent, flush, queryClient],
  )

  const ask = useCallback(
    (text: string) => {
      setOpen(true)
      void send(text)
    },
    [send, setOpen],
  )

  const stop = useCallback(() => {
    abort.current?.abort()
    setItems((prev) => [...prev, { id: nextId(), kind: 'notice', text: 'Stopped.', tone: 'info' }])
  }, [])

  const reset = useCallback(() => {
    abort.current?.abort()
    history.current = []
    setItems([])
    setUsage({ input: 0, output: 0, cacheRead: 0 })
  }, [])

  const respond = useCallback((toolId: string, approved: boolean) => {
    const resolve = approvals.current.get(toolId)
    if (resolve) {
      approvals.current.delete(toolId)
      resolve(approved)
    }
  }, [])

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveAgentSettings(next)
      return next
    })
  }, [])

  // Conversations are per account.
  useEffect(() => {
    reset()
  }, [active?.id, reset])

  const value = useMemo<AgentApi>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen(!open),
      items,
      running,
      pageContext,
      setPageContext,
      ask,
      stop,
      reset,
      respond,
      settings,
      updateSettings,
      usage,
    }),
    [open, setOpen, items, running, pageContext, ask, stop, reset, respond, settings, updateSettings, usage],
  )
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used inside <AgentProvider>')
  return ctx
}

/** Pages call this to tell the agent what the user is looking at. */
export function useAgentPageContext(ctx: PageContext | null) {
  const { setPageContext } = useAgent()
  const serialized = JSON.stringify(ctx)
  useEffect(() => {
    setPageContext(ctx)
    return () => setPageContext(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, setPageContext])
}
