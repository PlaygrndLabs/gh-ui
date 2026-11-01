import { Marked, type Token } from 'marked'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Replaces image tokens (recursively) with plain text tokens holding their alt text. Returns whether any were found. */
function flattenImages(tokens: Token[] | undefined): boolean {
  let found = false
  tokens?.forEach((t, i) => {
    if (t.type === 'image') {
      tokens[i] = { type: 'text', raw: t.raw, text: t.text || t.href }
      found = true
    } else if ('tokens' in t && Array.isArray(t.tokens) && flattenImages(t.tokens)) {
      found = true
    }
  })
  return found
}

// Model output can echo attacker-written text from tool results, so it gets its own Marked instance:
// images become plain links that load only if clicked, and raw HTML is shown as text, never parsed.
const agentMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    image({ raw, href, title, text }) {
      // Render it as an ordinary markdown link to the image (stock escaping), so it loads only if clicked.
      const label = text || href
      return this.link({ type: 'link', raw, href, title, text: label, tokens: [{ type: 'text', raw: label, text: label }] })
    },
    link(token) {
      // An image inside a link (at any depth, e.g. inside **bold**) would become a nested anchor.
      // Swap those images for their alt text, then let marked render the link as usual.
      flattenImages(token.tokens)
      return false
    },
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

/** Markdown → HTML for agent output. Still pass the result through sanitizeAgent before rendering. */
export function renderAgentMarkdown(text: string): string {
  return agentMarked.parse(text, { async: false })
}
