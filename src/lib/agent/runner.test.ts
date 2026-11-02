import { describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { runAgent, type AgentEvent } from './runner'
import { DEFAULT_SETTINGS } from './settings'
import { TOOLS_BY_NAME, type ToolContext } from './tools'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

/** Builds the SSE body the Messages API streams for one assistant turn. */
function sse(blocks: Block[], stopReason: string) {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', {
    message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    out += ev('content_block_stop', { index })
  })
  out += ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } })
  out += ev('message_stop', {})
  return out
}

function fakeApi(turns: string[]) {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = []
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
    const body = turns[requests.length - 1]
    if (!body) throw new Error('unexpected extra request')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } })
  })
  const client = new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0, dangerouslyAllowBrowser: true })
  return { client, requests }
}

const PR = {
  number: 1,
  title: 'Fix login',
  state: 'open',
  merged: false,
  draft: false,
  user: { login: 'alice' },
  body: 'desc',
  base: { ref: 'main', sha: 'aaa', repo: { full_name: 'acme/web' } },
  head: { ref: 'fix', sha: 'bbb', repo: { full_name: 'acme/web' } },
  maintainer_can_modify: true,
  mergeable: true,
  mergeable_state: 'clean',
  labels: [],
  requested_reviewers: [],
  commits: 1,
  changed_files: 1,
  additions: 1,
  deletions: 0,
  html_url: 'https://github.com/acme/web/pull/1',
}

function fakeGitHub() {
  const octokit = {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: PR })) },
      issues: { createComment: vi.fn(async () => ({ data: { id: 99, html_url: 'https://github.com/acme/web/pull/1#c99' } })) },
    },
  }
  const ctx = { octokit, account: { token: 't', host: 'github.com' } } as unknown as ToolContext
  return { octokit, ctx }
}

const READ_AND_WRITE: Block[] = [
  { type: 'text', text: 'Looking.' },
  { type: 'tool_use', id: 'toolu_read', name: 'get_pull_request', input: { owner: 'acme', repo: 'web', number: 1 } },
  { type: 'tool_use', id: 'toolu_write', name: 'post_comment', input: { owner: 'acme', repo: 'web', number: 1, body: 'LGTM' } },
]

describe('runAgent', () => {
  it('runs read tools freely, gates writes on approval, and answers every tool_use in one turn', async () => {
    const { client, requests } = fakeApi([sse(READ_AND_WRITE, 'tool_use'), sse([{ type: 'text', text: 'Posted.' }], 'end_turn')])
    const { octokit, ctx } = fakeGitHub()
    const events: AgentEvent[] = []
    const approve = vi.fn(async (_call: { name: string }) => true)
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'review' }]

    await runAgent({ client, settings: DEFAULT_SETTINGS, system: 'sys', messages, ctx, signal: new AbortController().signal, onEvent: (e) => events.push(e), approve })

    expect(octokit.rest.pulls.get).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledOnce()
    expect(approve.mock.calls[0][0]).toMatchObject({ name: 'post_comment' })
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({ owner: 'acme', repo: 'web', issue_number: 1, body: 'LGTM' })

    // History: user, assistant(tool_use x2), user(tool_result x2), assistant(final)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const results = messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results.map((r) => r.tool_use_id)).toEqual(['toolu_read', 'toolu_write'])
    expect(results.every((r) => !r.is_error)).toBe(true)

    // Request shape: adaptive thinking, effort, eager streaming tools, refusal fallback beta.
    const first = requests[0]
    expect(first.body.model).toBe('claude-opus-5-5')
    expect(first.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(first.body.output_config).toEqual({ effort: 'high' })
    expect(first.body.fallbacks).toBe('default')
    expect(first.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect((first.body.tools as Array<{ eager_input_streaming?: boolean }>).every((t) => t.eager_input_streaming)).toBe(true)
    expect(requests[1].body.messages).toHaveLength(3)

    expect(events.some((e) => e.type === 'text' && e.delta === 'Posted.')).toBe(true)
    expect(events.filter((e) => e.type === 'tool_awaiting')).toHaveLength(1)
  })

  it('reports a declined write as an error result and never calls GitHub', async () => {
    const { client } = fakeApi([sse(READ_AND_WRITE, 'tool_use'), sse([{ type: 'text', text: 'Okay, not posting.' }], 'end_turn')])
    const { octokit, ctx } = fakeGitHub()
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'review' }]
    await runAgent({ client, settings: DEFAULT_SETTINGS, system: 'sys', messages, ctx, signal: new AbortController().signal, onEvent: () => {}, approve: async () => false })
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    const results = messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results[1]).toMatchObject({ tool_use_id: 'toolu_write', is_error: true })
    expect(String(results[1].content)).toContain('declined')
  })

  it('skips approval when auto-approve is on', async () => {
    const { client } = fakeApi([sse(READ_AND_WRITE, 'tool_use'), sse([{ type: 'text', text: 'Done' }], 'end_turn')])
    const { octokit, ctx } = fakeGitHub()
    const approve = vi.fn(async () => false)
    await runAgent({ client, settings: { ...DEFAULT_SETTINGS, autoApproveWrites: true }, system: 's', messages: [{ role: 'user', content: 'x' }], ctx, signal: new AbortController().signal, onEvent: () => {}, approve })
    expect(approve).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).toHaveBeenCalledOnce()
  })

  it('rejects tool input that fails the schema without running the tool', async () => {
    const bad: Block[] = [{ type: 'tool_use', id: 'toolu_bad', name: 'get_pull_request', input: { owner: 'acme', repo: 'web' } }]
    const { client } = fakeApi([sse(bad, 'tool_use'), sse([{ type: 'text', text: 'Retrying differently.' }], 'end_turn')])
    const { octokit, ctx } = fakeGitHub()
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'x' }]
    await runAgent({ client, settings: DEFAULT_SETTINGS, system: 's', messages, ctx, signal: new AbortController().signal, onEvent: () => {}, approve: async () => true })
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
    const results = messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results[0]).toMatchObject({ tool_use_id: 'toolu_bad', is_error: true })
    expect(String(results[0].content)).toContain('INVALID_JSON')
  })

  it('never runs tools from a refused turn', async () => {
    const { client } = fakeApi([sse(READ_AND_WRITE, 'refusal')])
    const { octokit, ctx } = fakeGitHub()
    const events: AgentEvent[] = []
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'x' }]
    await runAgent({ client, settings: DEFAULT_SETTINGS, system: 's', messages, ctx, signal: new AbortController().signal, onEvent: (e) => events.push(e), approve: async () => true })
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
    expect(messages).toHaveLength(2)
    expect((messages[1].content as Array<{ type: string }>).some((b) => b.type === 'tool_use')).toBe(false)
    expect(events.some((e) => e.type === 'notice')).toBe(true)
  })

  it('saves no empty assistant turn when a refusal leaves only a tool_use, and drops the refused prompt', async () => {
    const onlyTool: Block[] = [{ type: 'tool_use', id: 'toolu_x', name: 'post_comment', input: { owner: 'acme', repo: 'web', number: 1, body: 'x' } }]
    const { client, requests } = fakeApi([sse(onlyTool, 'refusal'), sse([{ type: 'text', text: 'Sure.' }], 'end_turn')])
    const { octokit, ctx } = fakeGitHub()
    const events: AgentEvent[] = []
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'x' }]
    const run = () => runAgent({ client, settings: DEFAULT_SETTINGS, system: 's', messages, ctx, signal: new AbortController().signal, onEvent: (e) => events.push(e), approve: async () => true })
    await run()
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(messages).toEqual([])
    // The card opened while streaming is closed, not left "Preparing…".
    expect(events).toContainEqual({ type: 'tool_result', id: 'toolu_x', ok: false, output: 'Not run.' })

    messages.push({ role: 'user', content: 'something else' })
    await run()
    expect(requests[1].body.messages).toEqual([{ role: 'user', content: 'something else' }])
  })

  it('keeps the tool_result turn when a refusal with no content follows a tool round', async () => {
    const read: Block[] = [READ_AND_WRITE[1]]
    const { client, requests } = fakeApi([sse(read, 'tool_use'), sse([], 'refusal'), sse([{ type: 'text', text: 'ok' }], 'end_turn')])
    const { ctx } = fakeGitHub()
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'x' }]
    const run = () => runAgent({ client, settings: DEFAULT_SETTINGS, system: 's', messages, ctx, signal: new AbortController().signal, onEvent: () => {}, approve: async () => true })
    await run()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect((messages[2].content as Array<{ type: string }>)[0].type).toBe('tool_result')

    messages.push({ role: 'user', content: 'next' })
    await run()
    const sent = requests[2].body.messages as Anthropic.Beta.BetaMessageParam[]
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(sent.every((m) => m.role !== 'assistant' || m.content.length > 0)).toBe(true)
  })

  it('never runs tool calls cut off by a full context window', async () => {
    const { client } = fakeApi([sse(READ_AND_WRITE, 'model_context_window_exceeded')])
    const { octokit, ctx } = fakeGitHub()
    const events: AgentEvent[] = []
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'x' }]
    await expect(
      runAgent({ client, settings: { ...DEFAULT_SETTINGS, autoApproveWrites: true }, system: 's', messages, ctx, signal: new AbortController().signal, onEvent: (e) => events.push(e), approve: async () => true }),
    ).rejects.toThrow(/context window/)
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e as { id: string }).id)).toEqual(['toolu_read', 'toolu_write'])
  })

  it('retries a read once after an Octokit network failure, but never retries a write', async () => {
    const { client } = fakeApi([sse(READ_AND_WRITE, 'tool_use'), sse([{ type: 'text', text: 'Done' }], 'end_turn')])
    const { octokit, ctx } = fakeGitHub()
    // @octokit/request wraps a failed fetch in a RequestError with status 500 and no response.
    const networkError = () => Object.assign(new Error('Failed to fetch'), { status: 500 })
    octokit.rest.pulls.get.mockRejectedValueOnce(networkError())
    octokit.rest.issues.createComment.mockRejectedValueOnce(networkError())
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'x' }]
    await runAgent({ client, settings: { ...DEFAULT_SETTINGS, autoApproveWrites: true }, system: 's', messages, ctx, signal: new AbortController().signal, onEvent: () => {}, approve: async () => true })
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(2)
    expect(octokit.rest.issues.createComment).toHaveBeenCalledOnce()
    const results = messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results[0].is_error).toBeUndefined()
    expect(results[1]).toMatchObject({ tool_use_id: 'toolu_write', is_error: true, content: 'GitHub API error: Failed to fetch' })
  })

  it('reads auto-approve live, so turning it off mid-run gates the next write', async () => {
    const { client } = fakeApi([sse(READ_AND_WRITE, 'tool_use'), sse([{ type: 'text', text: 'Done' }], 'end_turn')])
    const { ctx } = fakeGitHub()
    const approve = vi.fn(async () => true)
    await runAgent({ client, settings: { ...DEFAULT_SETTINGS, autoApproveWrites: true }, autoApproveWrites: () => false, system: 's', messages: [{ role: 'user', content: 'x' }], ctx, signal: new AbortController().signal, onEvent: () => {}, approve })
    expect(approve).toHaveBeenCalledOnce()
  })

  it('keeps the prompt cache valid across the steps of a run', async () => {
    const { client, requests } = fakeApi([sse(READ_AND_WRITE, 'tool_use'), sse([{ type: 'text', text: 'Done.' }], 'end_turn')])
    const { ctx } = fakeGitHub()
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'review' }]

    await runAgent({ client, settings: DEFAULT_SETTINGS, system: 'sys', messages, ctx, signal: new AbortController().signal, onEvent: () => {}, approve: async () => true })

    const [first, second] = requests.map((r) => r.body)
    // A 1-hour entry must come before the 5-minute one, and both breakpoints must stay.
    expect(first.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }])
    expect(first.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
    // Caching is a prefix match: tools, system and every earlier message must repeat byte for byte.
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools))
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system))
    const prefix = JSON.stringify(first.messages).slice(0, -1)
    expect(JSON.stringify(second.messages).startsWith(prefix)).toBe(true)
    for (const setting of ['model', 'thinking', 'output_config']) expect(second[setting]).toEqual(first[setting])
  })

  it('reports cache reads and writes', async () => {
    const turn = sse([{ type: 'text', text: 'Hi.' }], 'end_turn').replace(/"usage":\{"input_tokens":\d+/, '"usage":{"cache_read_input_tokens":900,"cache_creation_input_tokens":50,"input_tokens":3')
    const { client } = fakeApi([turn])
    const { ctx } = fakeGitHub()
    const events: AgentEvent[] = []

    await runAgent({ client, settings: DEFAULT_SETTINGS, system: 'sys', messages: [{ role: 'user', content: 'hi' }], ctx, signal: new AbortController().signal, onEvent: (e) => events.push(e), approve: async () => true })

    expect(events.find((e) => e.type === 'usage')).toMatchObject({ input: 3, cacheRead: 900, cacheWrite: 50 })
  })

  it('omits the fallback beta for models without server-side fallback', async () => {
    const { client, requests } = fakeApi([sse([{ type: 'text', text: 'hi' }], 'end_turn')])
    const { ctx } = fakeGitHub()
    await runAgent({ client, settings: { ...DEFAULT_SETTINGS, model: 'claude-haiku-5-5' }, system: 's', messages: [{ role: 'user', content: 'x' }], ctx, signal: new AbortController().signal, onEvent: () => {}, approve: async () => true })
    expect(requests[0].body.fallbacks).toBeUndefined()
    expect(requests[0].headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback')
  })
})

describe('commit_files', () => {
  const b64 = (s: string) => btoa(s)
  function fakeRepo(trees: Record<string, Array<{ path: string; mode: string; type: string; sha: string }>>, truncated: boolean) {
    const git = {
      getRef: vi.fn(async () => ({ data: { object: { sha: 'head' } } })),
      getCommit: vi.fn(async () => ({ data: { tree: { sha: 'root' } } })),
      getTree: vi.fn(async ({ tree_sha, recursive }: { tree_sha: string; recursive?: string }) =>
        recursive ? { data: { truncated, tree: [] } } : { data: { truncated: false, tree: trees[tree_sha] ?? [] } },
      ),
      getBlob: vi.fn(async () => ({ data: { content: b64('AGENTS.md') } })),
      createTree: vi.fn(async (_args: { tree: unknown[] }) => ({ data: { sha: 'newtree' } })),
      createCommit: vi.fn(async () => ({ data: { sha: 'newcommit', html_url: 'u' } })),
      updateRef: vi.fn(async () => ({ data: {} })),
    }
    const repos = { getContent: vi.fn(async () => ({ data: { type: 'file', content: b64('echo hi\n'), sha: 'blob' } })) }
    const ctx = { octokit: { rest: { git, repos } }, account: { token: 't', host: 'github.com' } } as unknown as ToolContext
    return { git, ctx }
  }
  const TREES = {
    root: [
      { path: 'scripts', mode: '040000', type: 'tree', sha: 'scripts' },
      { path: 'CLAUDE.md', mode: '120000', type: 'blob', sha: 'link' },
    ],
    scripts: [{ path: 'release.sh', mode: '100755', type: 'blob', sha: 'blob' }],
  }
  const commit = TOOLS_BY_NAME.get('commit_files')!

  it('keeps the executable bit when the recursive listing is truncated', async () => {
    const { git, ctx } = fakeRepo(TREES, true)
    const changes = [
      { path: 'scripts/release.sh', edits: [{ old_str: 'hi', new_str: 'bye' }] },
      { path: 'scripts/new.sh', content: 'x' },
    ]
    const out = await commit.run({ owner: 'acme', repo: 'web', branch: 'fix', message: 'm', changes }, ctx)
    expect(out).toMatchObject({ sha: 'newcommit' })
    expect(git.createTree.mock.calls[0][0].tree).toEqual([
      { path: 'scripts/release.sh', mode: '100755', type: 'blob', content: 'echo bye\n' },
      { path: 'scripts/new.sh', mode: '100644', type: 'blob', content: 'x' },
    ])
  })

  it('refuses to write file text over a symlink', async () => {
    const { git, ctx } = fakeRepo(TREES, true)
    const out = await commit.run({ owner: 'acme', repo: 'web', branch: 'fix', message: 'm', changes: [{ path: 'CLAUDE.md', content: 'x' }] }, ctx)
    expect(out).toEqual({ error: 'CLAUDE.md is a symlink to AGENTS.md. Change the file it points to instead.' })
    expect(git.createTree).not.toHaveBeenCalled()
  })
})
