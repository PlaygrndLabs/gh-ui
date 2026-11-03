import DOMPurify from 'dompurify'
import frameScript from './mermaidFrame?worker&url'

// GitHub draws Mermaid blocks in a viewscreen.githubusercontent.com frame that only its own pages load, and leaves
// a spinner in the HTML it gives API clients. Draw them here instead.
//
// The source is untrusted (anyone can write a pull request body), and Mermaid fetches images while it lays a diagram
// out, before there is any output to clean. So it runs in a sandboxed frame with no origin, whose content policy
// allows no network at all, and only the cleaned SVG comes back.

/** A rendered diagram with nothing left that loads a URL. Local references such as url(#arrowhead) stay. */
export function safeDiagramSvg(svg: string) {
  const local = svg.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, 'none')
  return DOMPurify.sanitize(local, {
    ADD_TAGS: ['foreignobject'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ['image', 'img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'link', 'script'],
    FORBID_ATTR: ['src', 'srcset', 'background', 'poster', 'xlink:href'],
  }) as unknown as string
}

/** GitHub's HTML with its loading spinner removed: nothing here will ever end it. */
export function dropRenderLoaders(html: string) {
  if (!html.includes('js-render-enrichment-loader')) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const loader of tpl.content.querySelectorAll('.js-render-enrichment-loader')) loader.remove()
  return tpl.innerHTML
}

const RENDER_TIMEOUT_MS = 30_000

let frame: Promise<HTMLIFrameElement> | null = null
let nextId = 0
// Mermaid keeps its settings globally, so diagrams render one at a time.
let queue: Promise<unknown> = Promise.resolve()

function openFrame() {
  frame ??= new Promise<HTMLIFrameElement>((resolve, reject) => {
    const script = new URL(frameScript, location.href).href
    const el = document.createElement('iframe')
    el.setAttribute('sandbox', 'allow-scripts')
    el.setAttribute('aria-hidden', 'true')
    el.tabIndex = -1
    // Layout needs real sizes, so it can't be display: none.
    el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0'
    const policy = `default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; img-src data:; font-src data:`
    el.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><body><script src="${script}"></script></body>`
    const failed = setTimeout(() => {
      removeEventListener('message', ready)
      frame = null
      el.remove()
      reject(new Error('The diagram renderer did not start'))
    }, RENDER_TIMEOUT_MS)
    const ready = (e: MessageEvent) => {
      if (e.source !== el.contentWindow || !e.data?.ready) return
      clearTimeout(failed)
      removeEventListener('message', ready)
      resolve(el)
    }
    addEventListener('message', ready)
    document.body.append(el)
  })
  return frame
}

// A page behind other windows can't measure layout, so a diagram drawn then would stay the wrong size.
function whenVisible() {
  if (document.visibilityState === 'visible') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', check)
      resolve()
    }
    document.addEventListener('visibilitychange', check)
  })
}

function renderSvg(source: string, dark: boolean) {
  const run = async () => {
    await whenVisible()
    const win = (await openFrame()).contentWindow!
    const id = ++nextId
    return new Promise<string>((resolve, reject) => {
      const done = () => {
        clearTimeout(timeout)
        removeEventListener('message', reply)
      }
      const timeout = setTimeout(() => {
        done()
        reject(new Error('The diagram took too long to render'))
      }, RENDER_TIMEOUT_MS)
      const reply = (e: MessageEvent) => {
        if (e.source !== win || e.data?.id !== id) return
        done()
        if (typeof e.data.svg === 'string') resolve(safeDiagramSvg(e.data.svg))
        else reject(new Error('The diagram could not be rendered'))
      }
      addEventListener('message', reply)
      // The frame has no origin, so nothing narrower than '*' can address it.
      win.postMessage({ id, source, dark }, '*')
    })
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

/** Draws each Mermaid block under `root` next to its source, which stays hidden. Returns a cancel function. */
export function renderDiagrams(root: HTMLElement, dark: boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre[lang="mermaid"]')]
  let cancelled = false
  for (const pre of blocks) {
    const source = pre.textContent ?? ''
    // GitHub wraps the source in a container; the diagram goes after it.
    const holder = pre.closest<HTMLElement>('.js-render-enrichment-target') ?? pre
    renderSvg(source, dark).then(
      (svg) => {
        if (cancelled) return
        const figure = showBeside(holder, 'mermaid-diagram')
        figure.innerHTML = svg
        holder.hidden = true
      },
      () => {
        if (cancelled) return
        showBeside(holder, 'mermaid-error').textContent = 'This diagram could not be rendered, so its source is shown.'
        holder.hidden = false
      },
    )
  }
  return () => {
    cancelled = true
  }
}

function showBeside(holder: HTMLElement, className: string) {
  const parent = holder.parentElement!
  for (const old of parent.querySelectorAll(':scope > .mermaid-diagram, :scope > .mermaid-error')) old.remove()
  const el = document.createElement('div')
  el.className = className
  holder.after(el)
  return el
}
