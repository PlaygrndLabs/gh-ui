import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, IconButton, Spinner, Textarea } from '@primer/react'
import {
  SparkleFillIcon,
  XIcon,
  GearIcon,
  PlusIcon,
  PaperAirplaneIcon,
  SquareFillIcon,
  CheckCircleIcon,
  XCircleIcon,
  ShieldIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ToolsIcon,
} from '@primer/octicons-react'
import { useAgent, type ChatItem } from '../lib/agent/AgentProvider'
import { MODELS } from '../lib/agent/settings'
import { renderAgentMarkdown } from '../lib/agent/render'
import { sanitizeAgent, useLinkInterceptor } from './Markdown'

function LocalMarkdown({ text }: { text: string }) {
  const intercept = useLinkInterceptor()
  const html = useMemo(() => sanitizeAgent(renderAgentMarkdown(text)), [text])
  return <div className="markdown-body" onClick={intercept} dangerouslySetInnerHTML={{ __html: html }} />
}

const GENERAL_SUGGESTIONS = [
  { label: 'What needs my review?', prompt: 'Which open pull requests are waiting on my review (search_issues with review-requested:@me)? Summarize each in one line with its CI state.' },
  { label: 'What can you do?', prompt: 'What can you help me with in gh-ui? List the kinds of tasks your tools support, with an example request for each.' },
]

export function AgentPanel({ withLocalBar }: { withLocalBar: boolean }) {
  const agent = useAgent()
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [agent.items])

  const model = MODELS.find((m) => m.id === agent.settings.model)?.label ?? agent.settings.model
  const suggestions = agent.pageContext?.suggestions?.length ? agent.pageContext.suggestions : GENERAL_SUGGESTIONS

  const submit = () => {
    const text = draft.trim()
    if (!text || agent.running) return
    setDraft('')
    stickToBottom.current = true
    agent.ask(text)
  }

  return (
    <aside className={`agent-panel ${withLocalBar ? 'with-local' : ''}`} aria-label="Agent">
      <div className="agent-header">
        <SparkleFillIcon className="fg-done" />
        <span className="text-bold">Agent</span>
        <span className="fg-muted text-small text-truncate">{model}</span>
        <span className="ml-auto flex-center gap-1">
          <IconButton description="New conversation" size="small" variant="invisible" icon={PlusIcon} aria-label="New conversation" onClick={agent.reset} />
          <IconButton description="Agent settings" as={Link} to="/settings/agent" size="small" variant="invisible" icon={GearIcon} aria-label="Agent settings" />
          <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Close agent" onClick={() => agent.setOpen(false)} />
        </span>
      </div>
      <div className="agent-context text-truncate" title={agent.pageContext?.label}>
        {agent.pageContext ? <>Context: {agent.pageContext.label}</> : 'No page context. Open a repository, pull request or run for focused help.'}
      </div>

      <div
        className="agent-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {agent.items.length === 0 ? (
          <div className="fg-muted" style={{ fontSize: 13 }}>
            <p style={{ marginTop: 0 }}>
              Ask about the code on screen, have it review a pull request, address CodeRabbit or Greptile comments, explain a failing check, or re-run Actions.
            </p>
            <p>
              Read-only tools run automatically. Comments, reviews, commits and re-runs wait for your approval
              {agent.settings.autoApproveWrites ? ' (auto-approve is ON in settings)' : ''}.
            </p>
          </div>
        ) : (
          agent.items.map((item) => <ChatRow key={item.id} item={item} />)
        )}
        {agent.running && agent.items[agent.items.length - 1]?.kind !== 'text' && (
          <div className="flex-center gap-2 fg-muted text-small">
            <Spinner size="small" /> Working…
          </div>
        )}
      </div>

      <div className="agent-composer">
        <div className="agent-quick">
          {suggestions.map((s) => (
            <button key={s.label} type="button" className="agent-chip" disabled={agent.running} onClick={() => agent.ask(s.prompt)}>
              {s.label}
            </button>
          ))}
        </div>
        <Textarea
          block
          rows={3}
          resize="vertical"
          value={draft}
          placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)"
          aria-label="Message the agent"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex-center gap-2">
          <span className="fg-muted text-small">
            {agent.usage.input + agent.usage.output > 0 &&
              `${(agent.usage.input + agent.usage.output).toLocaleString()} tokens${agent.usage.cacheRead ? ` · ${agent.usage.cacheRead.toLocaleString()} cached` : ''}`}
          </span>
          <span className="ml-auto">
            {agent.running ? (
              <Button size="small" variant="danger" leadingVisual={SquareFillIcon} onClick={agent.stop}>
                Stop
              </Button>
            ) : (
              <Button size="small" variant="primary" leadingVisual={PaperAirplaneIcon} onClick={submit} disabled={!draft.trim()}>
                Send
              </Button>
            )}
          </span>
        </div>
      </div>
    </aside>
  )
}

function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="agent-msg-user">{item.text}</div>
    case 'text':
      return item.text ? (
        <div className="agent-msg-assistant">
          <LocalMarkdown text={item.text} />
        </div>
      ) : null
    case 'thinking':
      return <Thinking text={item.text} />
    case 'tool':
      return <ToolCard item={item} />
    case 'notice':
      return <div className={`text-small ${item.tone === 'danger' ? 'error-box' : 'fg-muted'}`}>{item.text}</div>
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div>
      <button type="button" className="link-muted text-small flex-center gap-1" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />} Reasoning
      </button>
      {open && <div className="agent-thinking mt-1">{text}</div>}
    </div>
  )
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const agent = useAgent()
  const [open, setOpen] = useState(item.status === 'awaiting')
  useEffect(() => {
    if (item.status === 'awaiting') setOpen(true)
  }, [item.status])
  const icon =
    item.status === 'preparing' || item.status === 'running' ? (
      <Spinner size="small" />
    ) : item.status === 'awaiting' ? (
      <ShieldIcon size={14} className="fg-attention" />
    ) : item.status === 'done' ? (
      <CheckCircleIcon size={14} className="fg-success" />
    ) : item.status === 'denied' ? (
      <CircleSlashIcon size={14} className="fg-muted" />
    ) : (
      <XCircleIcon size={14} className="fg-danger" />
    )
  return (
    <div className={`agent-tool ${item.status === 'awaiting' ? 'pending' : ''} ${item.status === 'error' ? 'error' : ''}`}>
      <button type="button" className="agent-tool-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        {icon}
        {item.write ? <ToolsIcon size={12} className="fg-attention" /> : null}
        <span className="flex-1 text-truncate">{item.status === 'preparing' ? `Preparing ${item.name}…` : item.summary}</span>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </button>
      {open && (
        <div className="agent-tool-body">
          <div className="fg-muted mb-1">
            <code>{item.name}</code>
          </div>
          {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
          {item.output && (
            <>
              <div className="fg-muted mt-2 mb-1">Result</div>
              <pre>{item.output.length > 4000 ? item.output.slice(0, 4000) + '\n…' : item.output}</pre>
            </>
          )}
        </div>
      )}
      {item.status === 'awaiting' && (
        <div className="agent-approval">
          <span className="text-small flex-1">This will change GitHub as you. Approve?</span>
          <Button size="small" onClick={() => agent.respond(item.id, false)}>
            Deny
          </Button>
          <Button size="small" variant="primary" onClick={() => agent.respond(item.id, true)}>
            Approve
          </Button>
        </div>
      )}
    </div>
  )
}
