import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import DOMPurify from 'dompurify'
import { SkeletonText } from '@primer/react/experimental'
import { useGitHub, renderMarkdown } from '../lib/github'
import { appPathFromUrl, mapSrcset } from '../lib/links'
import { webBaseFor } from '../lib/hosts'
import { openExternal } from '../lib/platform'
import { encodePath } from '../lib/repo'
import { highlightLine, languageFor } from '../lib/highlight'

const PURIFY_CONFIG = {
  ADD_TAGS: ['g-emoji', 'details', 'summary'],
  ADD_ATTR: ['fallback-src', 'alias', 'open', 'align'],
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  ALLOW_DATA_ATTR: true,
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') node.setAttribute('rel', 'noopener noreferrer')
  // Task lists arrive as <input type=checkbox>; keep them, read-only. Drop any other input.
  if (node.tagName === 'INPUT') {
    if (node.getAttribute('type') === 'checkbox') node.setAttribute('disabled', '')
    else node.remove()
  }
})

export function sanitize(html: string) {
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string
}

// Agent output can echo attacker-written text (PR bodies, bot comments), so nothing in it may make the
// browser fetch a URL on render: no media or embedded content, no inline styles or source attributes.
const AGENT_PURIFY_CONFIG = {
  ...PURIFY_CONFIG,
  FORBID_TAGS: [
    ...PURIFY_CONFIG.FORBID_TAGS,
    'img', 'picture', 'source', 'video', 'audio', 'track', 'svg', 'math', 'image', 'iframe', 'object', 'embed', 'link', 'meta',
  ],
  FORBID_ATTR: ['style', 'srcset', 'src', 'background', 'poster', 'xlink:href', 'fallback-src'],
}

export function sanitizeAgent(html: string) {
  return DOMPurify.sanitize(html, AGENT_PURIFY_CONFIG) as unknown as string
}

/** Intercepts clicks on links inside rendered HTML so GitHub links stay in-app. */
export function useLinkInterceptor() {
  const navigate = useNavigate()
  const { account } = useGitHub()
  return (e: MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#')) return
    if (e.metaKey || e.ctrlKey) return
    e.preventDefault()
    // App routes mirror GitHub paths, so resolve relative hrefs against the GitHub page for this route
    // rather than the app's own origin (app://gi-ui in Electron), which appPathFromUrl never matches.
    let url: string
    try {
      url = new URL(href, webBaseFor(account.host) + window.location.pathname + window.location.search).toString()
    } catch {
      return
    }
    const internal = appPathFromUrl(url, account.host)
    if (internal) navigate(internal)
    else if (/^(https?|mailto):/i.test(url)) openExternal(url)
  }
}

/** The repository file a rendered Markdown document came from, to resolve its relative links and images. */
export interface MarkdownBase {
  owner: string
  repo: string
  ref: string
  /** Path of the Markdown file itself (relative URLs resolve against its directory). */
  path: string
}

/**
 * GitHub's rendered file HTML keeps relative URLs as written (`docs/banner.png`, `./src/`), which would resolve
 * against the app's route. Point images at the raw file and links at the in-app blob/tree view, as github.com does;
 * a leading `/` is relative to the repository root there.
 */
function rebaseRelativeUrls(html: string, base: MarkdownBase, webBase: string) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const dir = base.path.includes('/') ? base.path.slice(0, base.path.lastIndexOf('/') + 1) : ''
  const repoRoot = `https://repo.invalid/`
  const resolve = (url: string) => {
    if (!url || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return null
    let u: URL
    let path: string
    try {
      u = new URL(url, repoRoot + dir)
      // A malformed escape (a lone '%' in a file name) must not throw during render.
      path = decodeURIComponent(u.pathname.slice(1))
    } catch {
      return null
    }
    return { path, rest: u.search + u.hash }
  }
  const prefix = `/${base.owner}/${base.repo}`
  const raw = (url: string) => {
    const r = resolve(url)
    return r ? `${webBase}${prefix}/raw/${encodePath(base.ref)}/${encodePath(r.path)}${r.rest}` : null
  }
  for (const img of tpl.content.querySelectorAll('img[src]')) {
    const src = raw(img.getAttribute('src')!)
    if (src) img.setAttribute('src', src)
  }
  // A srcset lists several candidates ("a.png 1x, b.png 2x"): rebase each one.
  for (const el of tpl.content.querySelectorAll('source[srcset], img[srcset]')) {
    el.setAttribute('srcset', mapSrcset(el.getAttribute('srcset')!, raw))
  }
  for (const a of tpl.content.querySelectorAll('a[href]')) {
    const r = resolve(a.getAttribute('href')!)
    if (!r) continue
    const kind = !r.path || r.path.endsWith('/') ? 'tree' : 'blob'
    a.setAttribute('href', `${prefix}/${kind}/${encodePath(base.ref)}${r.path ? `/${encodePath(r.path.replace(/\/$/, ''))}` : ''}${r.rest}`)
  }
  return tpl.innerHTML
}

/** Review comment context for ```suggestion blocks. */
export interface SuggestionContext {
  path: string
  /** The commented lines the suggestion replaces (null when unknown), and the first one's number. */
  base: string[] | null
  startLine: number | null
  /** Footer for the index-th "Suggested change" box (commit/batch buttons). */
  renderActions?(index: number): ReactNode
}

/**
 * GitHub renders suggestions as a "Suggested change" box only in review comments it stores; the /markdown API
 * (used for previews and pending comments) returns a plain code block. Build the same box, in GitHub's markup
 * so one set of styles covers both.
 */
function renderSuggestionBoxes(html: string, s: SuggestionContext) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const pres = tpl.content.querySelectorAll('pre[lang="suggestion"]')
  if (!pres.length) return html
  const lang = languageFor(s.path)
  const numbered = !!s.base && s.base.length > 1 && s.startLine !== null
  const row = (kind: 'deletion' | 'addition', code: string, n: number) =>
    `<tr class="border-0"><td class="blob-num blob-num-${kind}${numbered ? '' : ' blob-num-hidden'}" data-line-number="${numbered ? s.startLine! + n : '·'}"></td>` +
    `<td class="blob-code-inner blob-code-${kind} blob-code-marker-${kind}">${highlightLine(code, lang) || ''}</td></tr>`
  for (const pre of pres) {
    const text = (pre.textContent ?? '').replace(/\n$/, '')
    const added = text === '' ? [] : text.split('\n')
    const box = document.createElement('div')
    box.className = 'js-suggested-changes-blob'
    box.innerHTML =
      `<div class="suggested-change-header">Suggested change</div>` +
      `<div class="blob-wrapper"><table data-paste-markdown-skip=""><tbody>${(s.base ?? []).map((l, i) => row('deletion', l, i)).join('')}${added.map((l, i) => row('addition', l, i)).join('')}</tbody></table></div>` +
      `<div class="js-apply-changes"></div>`
    pre.replaceWith(box)
  }
  return tpl.innerHTML
}

interface MarkdownProps {
  /** Pre-rendered HTML from GitHub (body_html). Preferred: identical to github.com. */
  html?: string | null
  /** Raw markdown; rendered through GitHub's /markdown API when no HTML is available. */
  text?: string | null
  /** owner/repo used to resolve #123 and @mentions when rendering raw markdown. */
  context?: string
  className?: string
  emptyText?: string
  /** For a repository file's rendered HTML: resolves its relative links and images. */
  base?: MarkdownBase
  /** For a review comment: renders ```suggestion blocks as github.com's "Suggested change" box. */
  suggestions?: SuggestionContext
}

export function Markdown({ html, text, context, className, emptyText = 'No description provided.', base, suggestions }: MarkdownProps) {
  const { octokit, key, account } = useGitHub()
  const intercept = useLinkInterceptor()
  const needsRender = !html && !!text?.trim()
  const rendered = useQuery({
    queryKey: [key, 'markdown', context ?? '', text],
    queryFn: () => renderMarkdown(octokit, text ?? '', context),
    enabled: needsRender,
    staleTime: Infinity,
  })
  const source = html ?? rendered.data ?? null
  const webBase = webBaseFor(account.host)
  const suggestionKey = suggestions ? `${suggestions.path}\n${suggestions.startLine}\n${suggestions.base?.join('\n') ?? ''}` : null
  const clean = useMemo(() => {
    if (!source) return ''
    const safe = sanitize(source)
    const rebased = base ? rebaseRelativeUrls(safe, base, webBase) : safe
    return suggestions ? renderSuggestionBoxes(rebased, suggestions) : rebased
  }, [source, base?.owner, base?.repo, base?.ref, base?.path, webBase, suggestionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Suggestion footers go inside each box (GitHub leaves an empty .js-apply-changes there for them).
  const ref = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<Element[]>([])
  const withActions = !!suggestions?.renderActions
  useLayoutEffect(() => {
    // Most bodies have no suggestion boxes; keep the same empty array so they don't render twice.
    if (!withActions || !ref.current) return setSlots((s) => (s.length ? [] : s))
    const boxes = [...ref.current.querySelectorAll('.js-suggested-changes-blob')]
    setSlots(boxes.map((box) => box.querySelector('.js-apply-changes') ?? box.appendChild(document.createElement('div'))))
  }, [clean, withActions])

  if (needsRender && rendered.isLoading) return <SkeletonText lines={3} />
  if (!clean) {
    if (needsRender && rendered.isError) {
      return <pre className={`markdown-body ${className ?? ''}`} style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>
    }
    return <p className="fg-muted" style={{ fontStyle: 'italic', margin: 0 }}>{emptyText}</p>
  }
  return (
    <>
      <div ref={ref} className={`markdown-body ${className ?? ''}`} onClick={intercept} dangerouslySetInnerHTML={{ __html: clean }} />
      {slots.map((slot, i) => createPortal(suggestions?.renderActions?.(i), slot, String(i)))}
    </>
  )
}
