import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Avatar, Button, IconButton, Spinner } from '@primer/react'
import { CheckIcon, CopyIcon, LinkExternalIcon, LocationIcon, MailIcon, OrganizationIcon, PersonIcon } from '@primer/octicons-react'
import { useAuth } from '../lib/auth'
import { copyText } from '../lib/format'
import { octokitFor } from '../lib/github'
import { webBaseFor } from '../lib/hosts'
import { avatarUrlFor, initials, loginFromEmail } from '../lib/people'
import { openExternal } from '../lib/platform'

export interface Person {
  /** GitHub login, when the person is known to have an account. */
  login?: string | null
  /** Git author name, or a display name. */
  name?: string | null
  /** Git author email. */
  email?: string | null
  avatarUrl?: string | null
}

const OPEN_DELAY = 400
const CLOSE_DELAY = 150
const CARD_WIDTH = 320
const GAP = 6

/**
 * Hovering (or focusing) its children opens a card about the person, as github.com's hovercards do:
 * their picture, name, login, bio, email, and links to their profile here and on GitHub.
 * A git author with no linked login is looked up by email once the card opens.
 */
export function UserCard({ children, className, ...person }: Person & { children: ReactNode; className?: string }) {
  const trigger = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const nobody = !person.login && !person.name && !person.email

  const schedule = useCallback((open: boolean) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(
      () => setAnchor(open && trigger.current ? trigger.current.getBoundingClientRect() : null),
      open ? OPEN_DELAY : CLOSE_DELAY,
    )
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!anchor) return
    const close = () => setAnchor(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor])

  if (nobody || person.login?.endsWith('[bot]')) return <>{children}</>
  return (
    <span
      ref={trigger}
      className={`user-card-trigger ${className ?? ''}`}
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
      onFocus={() => schedule(true)}
      onBlur={() => schedule(false)}
    >
      {children}
      {anchor &&
        createPortal(
          <CardPanel person={person} anchor={anchor} onEnter={() => window.clearTimeout(timer.current)} onLeave={() => schedule(false)} onClose={() => setAnchor(null)} />,
          document.body,
        )}
    </span>
  )
}

// The card is portaled, but React still bubbles its events to the trigger's ancestors: a commit row's
// button or a list row's link would act on a click in the card.
const stop = (e: SyntheticEvent) => e.stopPropagation()

function CardPanel({ person, anchor, onEnter, onLeave, onClose }: { person: Person; anchor: DOMRect; onEnter(): void; onLeave(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({ left: anchor.left, top: anchor.bottom + GAP }))
  const navigate = useNavigate()
  const { active } = useAuth()
  const [copied, setCopied] = useState(false)

  const emailLogin = loginFromEmail(person.email)
  const known = person.login || emailLogin
  // A git email that isn't GitHub's noreply address names an account only if that account lists it publicly.
  const lookup = useQuery({
    queryKey: ['user-by-email', active?.id, person.email],
    enabled: !!active && !known && !!person.email,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const res = await octokitFor(active!).rest.search.users({ q: `${person.email} in:email`, per_page: 1 })
      return res.data.items[0]?.login ?? null
    },
  })
  const login = known || lookup.data || undefined
  const user = useQuery({
    queryKey: ['user-card', active?.id, login],
    enabled: !!active && !!login,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => (await octokitFor(active!).rest.users.getByUsername({ username: login! })).data,
  })
  const u = user.data
  const loading = lookup.isLoading || user.isLoading

  // Below the trigger, or above it when the window runs out, and never past either side.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const below = anchor.bottom + GAP
    const top = below + h > window.innerHeight - 8 && anchor.top - GAP - h > 8 ? anchor.top - GAP - h : below
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - el.offsetWidth - 8)
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
  })

  const name = u?.name || person.name || login
  const email = person.email || u?.email || undefined
  const picture = u?.avatar_url || person.avatarUrl || avatarUrlFor({ login, email, size: 48 })
  const profileUrl = u?.html_url ?? (login ? `${webBaseFor(active?.host ?? 'github.com')}/${login}` : undefined)
  const isOrg = u?.type === 'Organization'

  const go = (path: string) => {
    onClose()
    navigate(path)
  }
  const copy = async () => {
    if (!email) return
    await copyText(email)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={name ? `About ${name}` : 'About this person'}
      className="user-card"
      style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={(e) => {
        stop(e)
        if (e.key === 'Escape') onClose()
      }}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <div className="user-card-head">
        {picture ? <Avatar src={picture} size={48} square={isOrg} alt="" /> : <span className="user-card-initials" aria-hidden="true">{initials(name)}</span>}
        <div className="user-card-names">
          {name && <div className="user-card-name">{name}</div>}
          {login && login !== name && <div className="user-card-login">{login}</div>}
          {!login && !loading && <div className="user-card-login">{lookup.isSuccess ? 'No GitHub account found' : 'Git author'}</div>}
        </div>
        {loading && <Spinner size="small" srText="Loading" />}
      </div>
      {u?.bio && <p className="user-card-bio">{u.bio}</p>}
      {(u?.company || u?.location || email) && (
        <ul className="user-card-facts">
          {u?.company && (
            <li>
              <OrganizationIcon size={14} />
              <span className="text-truncate">{u.company}</span>
            </li>
          )}
          {u?.location && (
            <li>
              <LocationIcon size={14} />
              <span className="text-truncate">{u.location}</span>
            </li>
          )}
          {email && (
            <li>
              <MailIcon size={14} />
              <a
                href={`mailto:${email}`}
                className="text-truncate"
                onClick={(e) => {
                  e.preventDefault()
                  openExternal(`mailto:${email}`)
                }}
              >
                {email}
              </a>
              <IconButton size="small" variant="invisible" icon={copied ? CheckIcon : CopyIcon} aria-label={copied ? 'Copied' : 'Copy email'} onClick={() => void copy()} />
            </li>
          )}
        </ul>
      )}
      {login && (
        <div className="user-card-actions">
          <Button size="small" leadingVisual={isOrg ? OrganizationIcon : PersonIcon} onClick={() => go(`/${login}`)}>
            Profile
          </Button>
          {profileUrl && (
            <Button size="small" variant="invisible" leadingVisual={LinkExternalIcon} onClick={() => openExternal(profileUrl)}>
              Open on GitHub
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
