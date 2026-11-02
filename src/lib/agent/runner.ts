import Anthropic from '@anthropic-ai/sdk'
import type { AgentSettings } from './settings'
import { TOOL_DEFINITIONS, TOOLS_BY_NAME, type ToolContext } from './tools'
import { errorMessage } from '../github'
import { isNative } from '../platform'

type MessageParam = Anthropic.Beta.BetaMessageParam
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam
type ToolUse = Anthropic.Beta.BetaToolUseBlock

export type AgentEvent =
  | { type: 'block'; kind: 'text' | 'thinking' }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; summary: string; kind: 'read' | 'write' }
  | { type: 'tool_awaiting'; id: string }
  | { type: 'tool_result'; id: string; ok: boolean; output: string; denied?: boolean }
  | { type: 'fallback'; from: string; to: string }
  | { type: 'notice'; text: string }
  | { type: 'usage'; input: number; output: number; cacheRead: number; cacheWrite: number }

export interface ToolCallInfo {
  id: string
  name: string
  input: unknown
  summary: string
}

export interface RunOptions {
  client: Anthropic
  settings: AgentSettings
  system: string
  /** Conversation history. The runner appends assistant turns and tool results in place. */
  messages: MessageParam[]
  ctx: ToolContext
  signal: AbortSignal
  onEvent(e: AgentEvent): void
  approve(call: ToolCallInfo): Promise<boolean>
  /** Live auto-approve value, read before each write so turning it off mid-run takes effect. Defaults to settings. */
  autoApproveWrites?: () => boolean
}

const MAX_STEPS = 40
// Server-side refusal fallback is available on these models; Haiku has none.
export const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5'])

class TruncatedToolInput extends Error {}

function requestParams(opts: RunOptions) {
  const { settings, system, messages } = opts
  return {
    model: settings.model,
    max_tokens: 64000,
    // People pause between questions for longer than 5 minutes, so the tools + system prefix keeps a 1-hour entry.
    // Within a run requests are minutes apart at most, so the conversation tail stays on the cheaper 5-minute one.
    system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }],
    tools: TOOL_DEFINITIONS,
    messages,
    cache_control: { type: 'ephemeral' as const, ttl: '5m' as const },
    thinking: { type: 'adaptive' as const, display: 'summarized' as const },
    output_config: { effort: settings.effort },
    ...(FALLBACK_MODELS.has(settings.model)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
      : {}),
  }
}

export async function runAgent(opts: RunOptions): Promise<void> {
  const { client, messages, signal, onEvent } = opts
  let jsonRetries = 0

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return
    let message: Anthropic.Beta.BetaMessage
    // Tool cards opened while streaming; closed here when this step's tools won't run.
    const started: string[] = []
    const notRun = () => started.forEach((id) => onEvent({ type: 'tool_result', id, ok: false, output: 'Not run.' }))
    try {
      const stream = client.beta.messages.stream(requestParams(opts), { signal })
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'text' || block.type === 'thinking') onEvent({ type: 'block', kind: block.type })
          else if (block.type === 'tool_use') {
            started.push(block.id)
            onEvent({ type: 'tool_start', id: block.id, name: block.name })
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') onEvent({ type: 'text', delta: event.delta.text })
          else if (event.delta.type === 'thinking_delta') onEvent({ type: 'thinking', delta: event.delta.thinking })
        }
      }
      message = await stream.finalMessage()
      jsonRetries = 0
    } catch (err) {
      // With eager input streaming the SDK rejects when a tool input is not parseable
      // JSON. Only that is retried; API errors, aborts and repeated failures surface.
      if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err
      notRun()
      onEvent({ type: 'notice', text: 'A tool call came back malformed; retrying that step.' })
      continue
    }

    onEvent({
      type: 'usage',
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    })
    for (const block of message.content) {
      if (block.type === 'fallback') onEvent({ type: 'fallback', from: block.from.model, to: block.to.model })
    }

    const toolUses = message.content.filter((b): b is ToolUse => b.type === 'tool_use')

    if (message.stop_reason === 'refusal') {
      // A refusal can cut a tool_use or thinking off mid-way; never run that turn's tools
      // and keep only its text. The API rejects an assistant turn with empty content.
      notRun()
      const text = message.content.filter((b) => b.type === 'text' && b.text.trim())
      const last = messages[messages.length - 1]
      if (text.length) messages.push({ role: 'assistant', content: text })
      // Nothing to keep: drop the user's own prompt so the next send isn't refused on it
      // again. A tool_result turn stays, since the previous turn's tool_use blocks need it.
      else if (last?.role === 'user' && typeof last.content === 'string') messages.pop()
      onEvent({ type: 'notice', text: 'The model declined to continue this request.' })
      return
    }
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content })
      continue
    }
    // Only a finished tool call is safe to run: any other stop (output limit, full
    // context window) can leave a truncated input that still passes the schema.
    if (toolUses.length > 0 && message.stop_reason !== 'tool_use') {
      notRun()
      throw new TruncatedToolInput(
        message.stop_reason === 'model_context_window_exceeded'
          ? "This conversation filled the model's context window in the middle of a tool call, so nothing was run. Start a new conversation to continue."
          : 'The response hit the output limit in the middle of a tool call. Ask for a smaller change or split the task.',
      )
    }

    messages.push({ role: 'assistant', content: message.content })
    if (toolUses.length === 0) {
      if (message.stop_reason === 'model_context_window_exceeded') {
        onEvent({ type: 'notice', text: "The reply was cut off because this conversation filled the model's context window. Start a new conversation to continue." })
      }
      return
    }

    // Every tool_use must get a tool_result in the next user turn, even when the
    // user stops the agent mid-way, or the conversation can't be continued.
    const results = await executeTools(toolUses, opts)
    messages.push({ role: 'user', content: results })
    if (signal.aborted) return
  }
  onEvent({ type: 'notice', text: `Stopped after ${MAX_STEPS} steps. Send a message to continue.` })
}

async function executeTools(uses: ToolUse[], opts: RunOptions): Promise<ToolResult[]> {
  const { settings, ctx, signal, onEvent, approve } = opts
  const results = new Map<string, ToolResult>()
  const fail = (id: string, content: string, denied = false) => {
    results.set(id, { type: 'tool_result', tool_use_id: id, is_error: true, content })
    onEvent({ type: 'tool_result', id, ok: false, output: content, denied })
  }

  type Ready = { use: ToolUse; input: unknown; kind: 'read' | 'write'; summary: string }
  const ready: Ready[] = []
  for (const use of uses) {
    const def = TOOLS_BY_NAME.get(use.name)
    if (!def) {
      fail(use.id, `Unknown tool: ${use.name}`)
      continue
    }
    // The tolerant stream parser can hand back a truncated object; validate before running.
    const parsed = def.schema.safeParse(use.input)
    if (!parsed.success) {
      onEvent({ type: 'tool_call', id: use.id, name: use.name, input: use.input, summary: use.name, kind: def.kind })
      fail(use.id, JSON.stringify({ INVALID_JSON: JSON.stringify(use.input), issues: parsed.error.issues.slice(0, 5) }))
      continue
    }
    const summary = def.summarize(parsed.data)
    onEvent({ type: 'tool_call', id: use.id, name: use.name, input: parsed.data, summary, kind: def.kind })
    ready.push({ use, input: parsed.data, kind: def.kind, summary })
  }

  const execute = async ({ use, input, kind }: Ready) => {
    if (signal.aborted) return fail(use.id, 'Stopped by the user before this ran.')
    const def = TOOLS_BY_NAME.get(use.name)!
    try {
      let out: unknown
      try {
        out = await def.run(input as never, ctx)
      } catch (err) {
        // A dropped connection ("Failed to fetch") is worth one retry for reads; API errors
        // are not. Writes aren't retried: the first request may have reached GitHub.
        if (kind !== 'read' || signal.aborted || !isNetworkError(err)) throw err
        await new Promise((r) => setTimeout(r, 1000))
        if (signal.aborted) throw err
        out = await def.run(input as never, ctx)
      }
      const content = typeof out === 'string' ? out : JSON.stringify(out, null, 1)
      const isError = !!out && typeof out === 'object' && !Array.isArray(out) && 'error' in out
      results.set(use.id, { type: 'tool_result', tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) })
      onEvent({ type: 'tool_result', id: use.id, ok: !isError, output: content })
    } catch (err) {
      fail(use.id, `GitHub API error: ${errorMessage(err)}`)
    }
  }

  await Promise.all(ready.filter((r) => r.kind === 'read').map(execute))
  for (const r of ready.filter((x) => x.kind === 'write')) {
    if (signal.aborted) {
      fail(r.use.id, 'Stopped by the user before this ran.')
      continue
    }
    if (!(opts.autoApproveWrites ? opts.autoApproveWrites() : settings.autoApproveWrites)) {
      onEvent({ type: 'tool_awaiting', id: r.use.id })
      const ok = await approve({ id: r.use.id, name: r.use.name, input: r.input, summary: r.summary })
      if (!ok) {
        fail(r.use.id, 'The user declined this action. Do not retry it unless they ask; continue with the rest or explain.', true)
        continue
      }
    }
    await execute(r)
  }
  return uses.map((u) => results.get(u.id) ?? { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not executed.' })
}

/** Octokit reports a failed fetch as status 500 with no response; real HTTP errors carry one. */
function isNetworkError(err: unknown): boolean {
  const e = (err ?? {}) as { status?: number; response?: unknown; cause?: unknown; name?: string }
  if (e.response || e.name === 'AbortError' || (e.status !== undefined && e.status !== 500)) return false
  return e.cause instanceof TypeError || /fetch|network|load failed/i.test(errorMessage(err))
}

export function createClient(settings: AgentSettings, apiKey: string | null, proxyBase: string | null, github: { token: string; host: string }) {
  if (settings.mode === 'proxy') {
    if (!proxyBase) throw new Error('Set the gh-ui Worker URL in Settings → Agent to use proxy mode in the desktop app.')
    return new Anthropic({
      apiKey: 'proxy',
      baseURL: proxyBase,
      dangerouslyAllowBrowser: true,
      defaultHeaders: { 'x-gh-ui-github-token': github.token, 'x-gh-ui-github-host': github.host },
    })
  }
  if (!apiKey) throw new Error(isNative ? 'Add an Anthropic API key in Settings → Agent.' : 'Add an Anthropic API key in Settings → Agent, or switch to proxy mode.')
  // The key belongs to the user and stays on their device; requests go straight to api.anthropic.com.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
}

export function describeAgentError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in Settings → Agent.'
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key or proxy is not allowed to use that model.'
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Wait a moment and try again.'
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API (network or proxy problem).'
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`
  if (err instanceof TruncatedToolInput) return err.message
  return errorMessage(err)
}
