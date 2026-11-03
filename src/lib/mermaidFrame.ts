import mermaid from 'mermaid'

// Runs inside the sandboxed frame made by ./mermaid.ts, not in the app: see there for why.

// Settings a diagram can't change. A theme stays out so it can't pick colours that vanish against the app's own.
const LOCKED_SETTINGS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'themeCSS', 'fontFamily', 'theme', 'look']

let nextId = 0

addEventListener('message', async (e: MessageEvent<{ id: number; source: string; dark: boolean }>) => {
  if (e.source !== parent) return
  const { id, source, dark } = e.data
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    look: 'classic',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    secure: LOCKED_SETTINGS,
  })
  const elementId = `diagram-${++nextId}`
  try {
    parent.postMessage({ id, svg: (await mermaid.render(elementId, source)).svg }, '*')
  } catch {
    document.getElementById(`d${elementId}`)?.remove()
    parent.postMessage({ id, failed: true }, '*')
  }
})

parent.postMessage({ ready: true }, '*')
