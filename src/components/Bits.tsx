import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Avatar, IconButton, Spinner } from '@primer/react'
import { CopyIcon, CheckIcon, AlertIcon, type Icon } from '@primer/octicons-react'
import { useState } from 'react'
import { copyText } from '../lib/format'
import { errorMessage } from '../lib/github'

export function isBot(login?: string | null, type?: string | null) {
  return type === 'Bot' || !!login?.endsWith('[bot]')
}

export function botName(login: string) {
  return login.replace(/\[bot\]$/, '')
}

export function UserLink({ login, type, className = 'author-link' }: { login?: string | null; type?: string | null; className?: string }) {
  if (!login) return <span className={className}>ghost</span>
  if (isBot(login, type)) {
    return (
      <span className="flex-center gap-1" style={{ display: 'inline-flex' }}>
        <span className={className}>{botName(login)}</span>
        <span className="bot-badge">bot</span>
      </span>
    )
  }
  return (
    <Link to={`/${login}`} className={className}>
      {login}
    </Link>
  )
}

export function UserAvatar({ login, src, size = 20, square }: { login?: string | null; src?: string | null; size?: number; square?: boolean }) {
  const url = src || (login ? `https://avatars.githubusercontent.com/${botName(login)}?size=${size * 2}` : '')
  return <Avatar src={url} size={size} alt={login ? `@${login}` : ''} square={square} />
}

/** Issue label chip using the label's own hex color. */
export function IssueLabel({ name, color, description }: { name: string; color?: string | null; description?: string | null }) {
  const hex = (color || 'ededed').replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return (
    <span
      className="issue-label"
      title={description ?? undefined}
      style={{ background: `#${hex}`, color: luminance > 0.6 ? '#1f2328' : '#ffffff', borderColor: luminance > 0.9 ? 'var(--borderColor-default)' : 'transparent' }}
    >
      {name}
    </span>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spin-center" aria-live="polite">
      <Spinner size="medium" srText={label} />
    </div>
  )
}

export function ErrorBox({ error, title = 'Something went wrong' }: { error: unknown; title?: string }) {
  const status = (error as { status?: number } | null)?.status
  const hint =
    status === 401
      ? 'GitHub no longer accepts this account’s token: it expired or was revoked. Sign in again to continue.'
      : status === 404
      ? 'Not found, or your token cannot see it. Fine-grained tokens need access to this repository.'
      : status === 403
        ? 'Forbidden. Your token may be missing a scope or permission, or you hit a rate limit.'
        : null
  return (
    <div className="error-box" role="alert">
      <div className="flex-center gap-2 text-bold">
        <AlertIcon className="fg-danger" /> {title}
      </div>
      <div className="mt-1">{errorMessage(error)}</div>
      {hint && <div className="mt-1 fg-muted text-small">{hint}</div>}
    </div>
  )
}

export function CopyButton({ text, label = 'Copy', size = 'small', icon = CopyIcon }: { text: string; label?: string; icon?: Icon; size?: 'small' | 'medium' }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      size={size}
      variant="invisible"
      aria-label={copied ? 'Copied!' : label}
      icon={copied ? CheckIcon : icon}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
      }}
    />
  )
}

export function Blankslate({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="blankslate">
      {icon}
      <h3>{title}</h3>
      {children && <p style={{ margin: '4px 0 0' }}>{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const blocks = 5
  const addBlocks = total === 0 ? 0 : Math.round((additions / total) * blocks)
  const delBlocks = total === 0 ? 0 : Math.min(blocks - addBlocks, Math.round((deletions / total) * blocks))
  return (
    <span className="flex-center gap-1 text-small" style={{ display: 'inline-flex' }}>
      <span className="fg-success text-bold">+{additions.toLocaleString()}</span>
      <span className="fg-danger text-bold">−{deletions.toLocaleString()}</span>
      <span className="diffstat" aria-hidden>
        {Array.from({ length: blocks }, (_, i) => (
          <span key={i} className={`diffstat-block ${i < addBlocks ? 'add' : i < addBlocks + delBlocks ? 'del' : ''}`} />
        ))}
      </span>
    </span>
  )
}

export type TitlePart = { kind: 'text' | 'code' | 'ref'; value: string }

/** Splits a one-line title into plain text, `code` spans and #123 references, the inline markup github.com renders in commit and issue titles. */
export function titleParts(text: string): TitlePart[] {
  const parts: TitlePart[] = []
  const re = /`([^`]+)`|(^|[^\w&/])#(\d+)\b/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m[1] !== undefined ? m.index : m.index + m[2].length
    if (start > last) parts.push({ kind: 'text', value: text.slice(last, start) })
    parts.push(m[1] !== undefined ? { kind: 'code', value: m[1] } : { kind: 'ref', value: m[3] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) })
  return parts
}

/** A title with its `code` spans rendered as code (references stay plain text, for use inside a link or heading). */
export function InlineTitle({ text }: { text: string }) {
  return (
    <>
      {titleParts(text).map((p, i) => (p.kind === 'code' ? <code key={i}>{p.value}</code> : p.kind === 'ref' ? `#${p.value}` : p.value))}
    </>
  )
}

/**
 * A commit headline as github.com's commit lists show it: the text and `code` spans link to the commit,
 * #123 references link to that issue or pull request.
 */
export function CommitHeadline({ owner, repo, sha, text, className, refClassName }: { owner: string; repo: string; sha: string; text: string; className?: string; refClassName?: string }) {
  return (
    <>
      {titleParts(text).map((p, i) =>
        p.kind === 'ref' ? (
          <Link key={i} to={`/${owner}/${repo}/issues/${p.value}`} className={refClassName}>
            #{p.value}
          </Link>
        ) : (
          <Link key={i} to={`/${owner}/${repo}/commit/${sha}`} className={className}>
            {p.kind === 'code' ? <code>{p.value}</code> : p.value}
          </Link>
        ),
      )}
    </>
  )
}
