import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, IconButton, RelativeTime, TextInput } from '@primer/react'
import { BookIcon, DeviceDesktopIcon, LinkExternalIcon, FileDirectoryIcon, TriangleDownIcon, TriangleRightIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { native, openExternal, type LocalRepo } from '../../lib/platform'
import { parseRemote, webUrl } from '../../lib/links'
import { readPref, writePref } from '../../lib/storage'
import { Blankslate, CopyButton, ErrorBox, Loading } from '../../components/Bits'
import { Markdown } from '../../components/Markdown'

// GitHub has no REST/GraphQL API for wiki content; a wiki is a git repository
// (<repo>.wiki.git). The desktop app clones it and renders pages from git.

const PAGE_RE = /\.(md|markdown|mediawiki|textile|rdoc|org|asciidoc|adoc)$/i
const SPECIAL_RE = /^_(sidebar|footer)\./i
/** github.com shows this many pages before "Show N more pages…". */
const PAGES_SHOWN = 15

const baseName = (file: string) => file.split('/').pop() ?? file
/** URL slug of a page file, as in github.com/<owner>/<repo>/wiki/<slug>. */
const pageSlug = (file: string) => baseName(file).replace(PAGE_RE, '')
const pageTitle = (file: string) => pageSlug(file).replace(/-/g, ' ')

function CloneWikiBox({ url }: { url: string }) {
  return (
    <div className="wk-clone">
      <h3>Clone this wiki locally</h3>
      <div className="wk-clone-input">
        <TextInput block size="small" readOnly value={url} aria-label="Clone URL for this wiki" onFocus={(e) => e.currentTarget.select()} className="wk-clone-url" />
        <CopyButton text={url} label="Copy to clipboard" />
      </div>
    </div>
  )
}

export function WikiPage() {
  const { owner, repo, fullName, data } = useRepo()
  const { account } = useGitHub()
  const wikiUrl = webUrl(account.host, `/${owner}/${repo}/wiki`)
  useAgentPageContext({ label: `the wiki of ${fullName}`, owner, repo })

  if (!data.has_wiki) {
    return (
      <div className="container-lg">
        <Blankslate icon={<BookIcon size={32} />} title="The wiki is disabled for this repository" />
      </div>
    )
  }
  if (!native) {
    return (
      <div className="container-lg">
        <Blankslate
          icon={<BookIcon size={32} />}
          title="Wikis are read through git"
          action={
            <Button trailingVisual={LinkExternalIcon} onClick={() => openExternal(wikiUrl)}>
              Open wiki on GitHub
            </Button>
          }
        >
          GitHub has no API for wiki pages. The desktop app clones {repo}.wiki.git and renders the pages here.
        </Blankslate>
        <div className="wk-clone-standalone">
          <CloneWikiBox url={`https://${account.host}/${owner}/${repo}.wiki.git`} />
        </div>
      </div>
    )
  }
  return <LocalWiki wikiUrl={wikiUrl} />
}

function LocalWiki({ wikiUrl }: { wikiUrl: string }) {
  const { owner, repo, fullName } = useRepo()
  const { '*': slug = '' } = useParams()
  const { account } = useGitHub()
  const qc = useQueryClient()
  const [cloning, setCloning] = useState(false)
  const [parent, setParent] = useState(() => readPref('cloneParent', ''))
  const [error, setError] = useState<string | null>(null)
  const [pageFilter, setPageFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [pagesOpen, setPagesOpen] = useState<boolean | null>(null)
  const cloneUrl = `https://${account.host}/${owner}/${repo}.wiki.git`

  const local = useQuery({
    queryKey: ['wiki-local', owner, repo],
    queryFn: async (): Promise<LocalRepo | null> => {
      for (const r of await native!.repos.list()) {
        const res = await native!.git(r.id, ['remote', 'get-url', 'origin'])
        const remote = res.code === 0 ? parseRemote(res.stdout.trim()) : null
        if (remote && remote.owner.toLowerCase() === owner.toLowerCase() && remote.repo.toLowerCase() === `${repo}.wiki`.toLowerCase()) return r
      }
      return null
    },
  })
  const files = useQuery({
    queryKey: ['wiki-pages', local.data?.id],
    enabled: !!local.data,
    queryFn: async () => {
      await native!.git(local.data!.id, ['pull', '--ff-only'], { token: account.token, host: account.host })
      const res = await native!.git(local.data!.id, ['ls-tree', '-r', '--name-only', 'HEAD'])
      return res.stdout.split('\n').filter((f) => PAGE_RE.test(f))
    },
  })
  // Home first, then the rest alphabetically regardless of case, like github.com's page list.
  const pages = (files.data ?? [])
    .filter((f) => !SPECIAL_RE.test(baseName(f)))
    .sort((a, b) => (/^home$/i.test(pageSlug(a)) ? -1 : /^home$/i.test(pageSlug(b)) ? 1 : pageTitle(a).localeCompare(pageTitle(b), undefined, { sensitivity: 'base' })))
  const sidebarFile = files.data?.find((f) => /^_sidebar\./i.test(baseName(f)))
  const footerFile = files.data?.find((f) => /^_footer\./i.test(baseName(f)))
  // The router has already decoded the splat; decoding again throws on page names containing "%".
  const wanted = slug.replace(/ /g, '-').toLowerCase()
  const current = (wanted ? pages.find((p) => pageSlug(p).toLowerCase() === wanted) : pages.find((p) => /^home$/i.test(pageSlug(p)))) ?? (wanted ? null : (pages[0] ?? null))

  const show = (file: string | null | undefined) => ({
    queryKey: ['wiki-page', local.data?.id, file],
    enabled: !!local.data && !!file,
    queryFn: async () => (await native!.git(local.data!.id, ['show', `HEAD:${file}`])).stdout,
  })
  const content = useQuery(show(current))
  const sidebar = useQuery(show(sidebarFile))
  const footer = useQuery(show(footerFile))
  const history = useQuery({
    queryKey: ['wiki-history', local.data?.id, current],
    enabled: !!local.data && !!current,
    queryFn: async () => {
      const res = await native!.git(local.data!.id, ['log', '--format=%an%x09%aI', '--', current!])
      const lines = res.stdout.split('\n').filter(Boolean)
      const [author, date] = (lines[0] ?? '').split('\t')
      return { author, date, revisions: lines.length }
    },
  })

  const clone = async () => {
    setCloning(true)
    setError(null)
    try {
      await native!.repos.clone(cloneUrl, parent, `${repo}.wiki`, { token: account.token, host: account.host })
      writePref('cloneParent', parent)
      await qc.invalidateQueries({ queryKey: ['wiki-local', owner, repo] })
      await qc.invalidateQueries({ queryKey: ['local-repos'] })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setCloning(false)
    }
  }

  if (local.isLoading) return <Loading />
  if (!local.data) {
    return (
      <div className="container-md">
        <Blankslate icon={<DeviceDesktopIcon size={32} />} title="Clone this wiki to read it here">
          gi-ui keeps a local clone of {repo}.wiki.git and renders its pages. It also shows up under Local repositories, so you can edit and push.
        </Blankslate>
        <div className="flex gap-2 mt-3">
          <TextInput className="flex-1" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Parent folder" aria-label="Parent folder" />
          <Button
            leadingVisual={FileDirectoryIcon}
            onClick={async () => {
              const dir = await native!.pickDirectory('Where should the wiki be cloned?')
              if (dir) setParent(dir)
            }}
          >
            Choose…
          </Button>
          <Button variant="primary" disabled={!parent} loading={cloning} onClick={() => void clone()}>
            Clone wiki
          </Button>
        </div>
        {error && <div className="error-box mt-2">{error}. The wiki may have no pages yet: create the first one on GitHub.</div>}
        <p className="text-small mt-2">
          <a href={wikiUrl} onClick={(e) => (e.preventDefault(), openExternal(wikiUrl))}>
            Open wiki on GitHub <LinkExternalIcon size={12} />
          </a>
        </p>
      </div>
    )
  }

  const filtered = pages.filter((p) => pageTitle(p).toLowerCase().includes(pageFilter.toLowerCase()))
  const listed = showAll || pageFilter ? filtered : filtered.slice(0, PAGES_SHOWN)
  const currentSlug = current ? pageSlug(current) : null
  // With a custom _Sidebar, github.com starts with the page list collapsed.
  const listOpen = pagesOpen ?? !sidebarFile
  const pageUrl = (file: string) => (/^home$/i.test(pageSlug(file)) ? `/${owner}/${repo}/wiki` : `/${owner}/${repo}/wiki/${encodeURIComponent(pageSlug(file))}`)

  return (
    <div className="container-xl wk-page">
      <div className="wk-header">
        <h1>{current ? pageTitle(current) : slug.replace(/-/g, ' ') || 'Home'}</h1>
        <div className="wk-header-actions">
          {current && (
            <Button size="small" onClick={() => openExternal(`${wikiUrl}/${encodeURIComponent(currentSlug!)}/_edit`)}>
              Edit
            </Button>
          )}
          <Button size="small" variant="primary" onClick={() => openExternal(`${wikiUrl}/_new`)}>
            New page
          </Button>
        </div>
      </div>
      <div className="wk-header-meta">
        {history.data?.author && history.data.date && (
          <>
            {history.data.author} edited this page <RelativeTime date={new Date(history.data.date)} /> ·{' '}
            <a href={`${wikiUrl}/${encodeURIComponent(currentSlug ?? '')}/_history`} onClick={(e) => (e.preventDefault(), openExternal(`${wikiUrl}/${encodeURIComponent(currentSlug ?? '')}/_history`))}>
              {history.data.revisions === 1 ? '1 revision' : `${history.data.revisions} revisions`}
            </a>
          </>
        )}
      </div>
      <div className="layout-sidebar wk-content">
        <div style={{ minWidth: 0 }}>
          {files.isLoading || content.isLoading ? (
            <Loading />
          ) : files.error ? (
            <ErrorBox error={files.error} />
          ) : current ? (
            <Markdown text={content.data ?? ''} context={fullName} emptyText="This page is empty." />
          ) : (
            <Blankslate icon={<BookIcon size={32} />} title={slug ? 'This page does not exist yet' : 'Welcome to the wiki!'} />
          )}
          {footer.data && (
            <div className="Box wk-footer">
              <div className="Box-body">
                <Markdown text={footer.data} context={fullName} />
              </div>
            </div>
          )}
        </div>
        <aside className="wk-rightbar">
          <nav className="Box wk-pages" aria-labelledby="wiki-pages-box-heading">
            <div className="Box-header wk-pages-header">
              <h2 id="wiki-pages-box-heading" className="Box-title">
                <IconButton icon={listOpen ? TriangleDownIcon : TriangleRightIcon} variant="invisible" size="small" aria-label="Wiki pages" aria-expanded={listOpen} onClick={() => setPagesOpen(!listOpen)} />
                Pages <span className="counter wk-counter">{pages.length}</span>
              </h2>
            </div>
            {listOpen && (
              <div className="wk-pages-filter">
                <TextInput block size="small" placeholder="Find a page…" aria-label="Find a page or section" value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} />
              </div>
            )}
            <ul hidden={!listOpen}>
              {listed.map((p) => (
                <li key={p} className="Box-row wk-page-row">
                  <Link to={pageUrl(p)} className="text-bold" aria-current={p === current ? 'page' : undefined}>
                    {pageTitle(p)}
                  </Link>
                </li>
              ))}
              {listed.length < filtered.length && (
                <li className="Box-row wk-page-row wk-more">
                  <button type="button" className="wk-more-button" onClick={() => setShowAll(true)}>
                    Show {filtered.length - listed.length} more {filtered.length - listed.length === 1 ? 'page' : 'pages'}…
                  </button>
                </li>
              )}
            </ul>
          </nav>
          {sidebar.data && (
            <div className="Box wk-custom-sidebar">
              <div className="Box-body">
                <Markdown text={sidebar.data} context={fullName} />
              </div>
            </div>
          )}
          <CloneWikiBox url={cloneUrl} />
        </aside>
      </div>
    </div>
  )
}
