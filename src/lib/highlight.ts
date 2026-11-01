import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import nginx from 'highlight.js/lib/languages/nginx'
import protobuf from 'highlight.js/lib/languages/protobuf'
import elixir from 'highlight.js/lib/languages/elixir'
import scala from 'highlight.js/lib/languages/scala'
import dart from 'highlight.js/lib/languages/dart'
import haskell from 'highlight.js/lib/languages/haskell'
import powershell from 'highlight.js/lib/languages/powershell'

hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('nginx', nginx)
hljs.registerLanguage('protobuf', protobuf)
hljs.registerLanguage('elixir', elixir)
hljs.registerLanguage('scala', scala)
hljs.registerLanguage('dart', dart)
hljs.registerLanguage('haskell', haskell)
hljs.registerLanguage('powershell', powershell)

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  m: 'objectivec', mm: 'objectivec', php: 'php', pl: 'perl', lua: 'lua', r: 'r', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
  yml: 'yaml', yaml: 'yaml', json: 'json', jsonc: 'json', json5: 'json', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less', diff: 'diff', patch: 'diff', proto: 'protobuf',
  ex: 'elixir', exs: 'elixir', scala: 'scala', dart: 'dart', hs: 'haskell', vb: 'vbnet', makefile: 'makefile', mk: 'makefile',
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby',
  '.bashrc': 'bash', '.zshrc': 'bash', '.env': 'bash', 'nginx.conf': 'nginx', '.gitignore': 'bash',
  'cmakelists.txt': 'cmake',
}

export function languageFor(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (BY_NAME[name]) return hljs.getLanguage(BY_NAME[name]) ? BY_NAME[name] : null
  if (name.startsWith('dockerfile')) return 'dockerfile'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const lang = BY_EXT[ext]
  return lang && hljs.getLanguage(lang) ? lang : null
}

const MAX_HIGHLIGHT_BYTES = 400_000

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Highlights one line in isolation (diff views). Returns safe HTML. */
export function highlightLine(text: string, lang: string | null): string {
  if (!lang || text.length > 2000) return escapeHtml(text)
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}

/**
 * Highlights a whole file and splits the HTML back into lines, closing and
 * reopening spans at line breaks so multi-line tokens (comments, strings) render correctly.
 */
export function highlightLines(text: string, lang: string | null): string[] {
  if (!lang || text.length > MAX_HIGHLIGHT_BYTES) return text.split('\n').map(escapeHtml)
  let html: string
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return text.split('\n').map(escapeHtml)
  }
  const lines: string[] = []
  const open: string[] = []
  let current = ''
  const tagRe = /<\/?span[^>]*>|\n|[^<\n]+|</g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    const tok = m[0]
    if (tok === '\n') {
      current += '</span>'.repeat(open.length)
      lines.push(current)
      current = open.join('')
    } else if (tok.startsWith('</span')) {
      open.pop()
      current += tok
    } else if (tok.startsWith('<span')) {
      open.push(tok)
      current += tok
    } else {
      current += tok
    }
  }
  lines.push(current)
  return lines
}
