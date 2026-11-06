import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type Anthropic from '@anthropic-ai/sdk'
import { useAuth } from '../auth'
import { octokitFor } from '../github'
import { readPref, writePref } from '../storage'
import { useTabTitle } from '../TabsProvider'
import { BASE_SYSTEM_PROMPT } from './prompt'
import { createClient, describeAgentError, runAgent, type AgentEvent } from './runner'
import { ANTHROPIC_KEY_EVENT, getAnthropicKey, loadAgentSettings, proxyBaseUrl, saveAgentSettings, type AgentSettings } from './settings'
import { useIsFocusedPane } from '../TabsProvider'

export interface PageContext {
  /** e.g. "pull request acme/web#42 “Fix login”" */
  label: string
  /** What a desktop tab calls this page, e.g. "#128 Retry failed uploads". Without one the tab's title comes from the URL. */
  tabTitle?: string
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
  /** Whether the agent can run: an API key is saved, or a proxy holds one. Its buttons show only then. */
  available: boolean
  open: boolean
  setOpen(open: boolean): void
  toggle(): void
  /** Which chat shows: a repository's key, or null for the one outside any repository. */
  setChat(id: string | null): void
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
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
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

const GENERAL_CHAT = 'general'

interface ChatView {
  items: ChatItem[]
  running: boolean
  usage: AgentApi['usage']
}

const EMPTY_CHAT: ChatView = { items: [], running: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }

/** What a run needs between renders, for one chat. */
interface ChatRun {
  history: Anthropic.Beta.BetaMessageParam[]
  abort: AbortController | null
  approvals: Map<string, (ok: boolean) => void>
  // Coalesce streaming deltas so long answers don't re-render per token.
  pending: AgentEvent[]
  flushTimer: number | null
}

/** One chat per repository: `setChat` picks the one showing, and a run keeps going in its own chat while another shows. */
export function AgentProvider({ children }: { children: ReactNode }) {
  const { active } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpenState] = useState(() => readPref('agentOpen', false))
  const [chatId, setChatId] = useState(GENERAL_CHAT)
  const [chats, setChats] = useState<Record<string, ChatView>>({})
  const [pageContext, setPageContext] = useState<PageContext | null>(null)
  const [settings, setSettings] = useState<AgentSettings>(loadAgentSettings)
  // Unknown until the secret store answers, and hidden till then rather than flashing in.
  const [hasKey, setHasKey] = useState(false)
  useEffect(() => {
    let live = true
    const check = () => void getAnthropicKey().then((key) => live && setHasKey(!!key?.trim()), () => live && setHasKey(false))
    check()
    window.addEventListener(ANTHROPIC_KEY_EVENT, check)
    return () => {
      live = false
      window.removeEventListener(ANTHROPIC_KEY_EVENT, check)
    }
  }, [])
  const available = settings.mode === 'proxy' || hasKey

  const runs = useRef(new Map<string, ChatRun>())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const contextRef = useRef(pageContext)
  contextRef.current = pageContext
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const chatsRef = useRef(chats)
  chatsRef.current = chats

  const runOf = useCallback((id: string) => {
    let run = runs.current.get(id)
    if (!run) {
      run = { history: [], abort: null, approvals: new Map(), pending: [], flushTimer: null }
      runs.current.set(id, run)
    }
    return run
  }, [])
  const updateChat = useCallback((id: string, change: (chat: ChatView) => Partial<ChatView>) => {
    setChats((prev) => {
      const chat = prev[id] ?? EMPTY_CHAT
      return { ...prev, [id]: { ...chat, ...change(chat) } }
    })
  }, [])
  const setItems = useCallback((id: string, change: (items: ChatItem[]) => ChatItem[]) => updateChat(id, (chat) => ({ items: change(chat.items) })), [updateChat])

  const applyEvents = useCallback(
    (id: string, events: AgentEvent[]) => {
      setItems(id, (prev) => {
        const next = [...prev]
        const lastOf = (kind: 'text' | 'thinking') => {
          const last = next[next.length - 1]
          return last && last.kind === kind ? next.length - 1 : -1
        }
        const updateTool = (toolId: string, patch: Partial<Extract<ChatItem, { kind: 'tool' }>>) => {
          const i = next.findIndex((x) => x.kind === 'tool' && x.id === toolId)
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
    },
    [setItems],
  )

  const flush = useCallback(
    (id: string) => {
      const run = runOf(id)
      run.flushTimer = null
      const batch = run.pending
      run.pending = []
      if (batch.length) applyEvents(id, batch)
    },
    [applyEvents, runOf],
  )

  const onEvent = useCallback(
    (id: string, e: AgentEvent) => {
      if (e.type === 'usage') {
        updateChat(id, ({ usage: u }) => ({ usage: { input: u.input + e.input, output: u.output + e.output, cacheRead: u.cacheRead + e.cacheRead, cacheWrite: u.cacheWrite + e.cacheWrite } }))
        return
      }
      const run = runOf(id)
      run.pending.push(e)
      if (e.type === 'text' || e.type === 'thinking') {
        run.flushTimer ??= window.setTimeout(() => flush(id), 40)
      } else {
        if (run.flushTimer) window.clearTimeout(run.flushTimer)
        flush(id)
      }
    },
    [flush, runOf, updateChat],
  )

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v)
    writePref('agentOpen', v)
  }, [])

  const send = useCallback(
    async (text: string) => {
      const id = chatIdRef.current
      if (!active || chatsRef.current[id]?.running) return
      const chatRun = runOf(id)
      const ctxText = contextBlock(contextRef.current)
      setItems(id, (prev) => [...prev, { id: nextId(), kind: 'user', text, context: contextRef.current?.label }])
      const userContent = ctxText ? `<gh_ui_context>\n${ctxText}\n</gh_ui_context>\n\n${text}` : text
      chatRun.history.push({ role: 'user', content: userContent })

      const controller = new AbortController()
      chatRun.abort = controller
      updateChat(id, () => ({ running: true }))
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
          messages: chatRun.history,
          ctx: { octokit: octokitFor(active), account: active },
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === 'tool_call' && e.kind === 'write') writeCalls.add(e.id)
            if (e.type === 'tool_result' && e.ok && writeCalls.has(e.id)) wrote = true
            onEvent(id, e)
          },
          approve: (call) =>
            new Promise<boolean>((resolve) => {
              chatRun.approvals.set(call.id, resolve)
              controller.signal.addEventListener('abort', () => resolve(false), { once: true })
            }),
          // Read live so turning auto-approve off mid-run applies to the next write.
          autoApproveWrites: () => settingsRef.current.autoApproveWrites,
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          flush(id)
          setItems(id, (prev) => [...prev, { id: nextId(), kind: 'notice', text: describeAgentError(err), tone: 'danger' }])
        }
      } finally {
        flush(id)
        // Errors and aborts can end the run with tool cards still open; nothing runs after this.
        setItems(id, (prev) =>
          prev.map((x) =>
            x.kind === 'tool' && (x.status === 'preparing' || x.status === 'running' || x.status === 'awaiting')
              ? { ...x, status: 'error', output: x.output ?? 'Not run.' }
              : x,
          ),
        )
        chatRun.approvals.clear()
        chatRun.abort = null
        updateChat(id, () => ({ running: false }))
        // Tools may have posted comments, commits or re-runs: refresh what's on screen.
        if (wrote) void queryClient.invalidateQueries({ queryKey: [active.id] })
      }
    },
    [active, onEvent, flush, queryClient, runOf, setItems, updateChat],
  )

  const ask = useCallback(
    (text: string) => {
      setOpen(true)
      void send(text)
    },
    [send, setOpen],
  )

  const stop = useCallback(() => {
    const id = chatIdRef.current
    runOf(id).abort?.abort()
    setItems(id, (prev) => [...prev, { id: nextId(), kind: 'notice', text: 'Stopped.', tone: 'info' }])
  }, [runOf, setItems])

  const reset = useCallback(() => {
    const id = chatIdRef.current
    runOf(id).abort?.abort()
    runOf(id).history = []
    updateChat(id, () => ({ items: [], usage: EMPTY_CHAT.usage }))
  }, [runOf, updateChat])

  const respond = useCallback(
    (toolId: string, approved: boolean) => {
      const { approvals } = runOf(chatIdRef.current)
      const resolve = approvals.get(toolId)
      if (resolve) {
        approvals.delete(toolId)
        resolve(approved)
      }
    },
    [runOf],
  )

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveAgentSettings(next)
      return next
    })
  }, [])

  // Conversations are per account.
  useEffect(() => {
    for (const run of runs.current.values()) run.abort?.abort()
    runs.current.clear()
    setChats({})
  }, [active?.id])

  const chat = chats[chatId] ?? EMPTY_CHAT
  const value = useMemo<AgentApi>(
    () => ({
      available,
      // With nothing to run it, the panel stays shut.
      open: open && available,
      setOpen,
      toggle: () => available && setOpen(!open),
      setChat: (id) => setChatId(id ?? GENERAL_CHAT),
      items: chat.items,
      running: chat.running,
      pageContext,
      setPageContext,
      ask,
      stop,
      reset,
      respond,
      settings,
      updateSettings,
      usage: chat.usage,
    }),
    [available, open, setOpen, chat, pageContext, ask, stop, reset, respond, settings, updateSettings],
  )
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used inside <AgentProvider>')
  return ctx
}

/** Shows its children only while the agent can run, so no button offers what can't happen. */
export function AgentOnly({ children }: { children: ReactNode }) {
  return useAgent().available ? children : null
}

/** Pages call this to tell the agent what the user is looking at. */
export function useAgentPageContext(ctx: PageContext | null) {
  const { setPageContext } = useAgent()
  const focused = useIsFocusedPane()
  const serialized = JSON.stringify(ctx)
  useEffect(() => {
    if (!focused) return
    setPageContext(ctx)
    return () => setPageContext(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, setPageContext, focused])
  useTabTitle(ctx?.tabTitle)
}
