import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The build joins stylesheets into one file, so an unclosed block here swallows every stylesheet after it.
// The dev server loads them separately and hides the problem.
function unclosedBlocks(css) {
  const open = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
  for (const char of text) {
    if (char === '{') open.push(char)
    else if (char === '}' && !open.pop()) return -1
  }
  return open.length
}

describe('stylesheets', () => {
  it('finds an unclosed block', () => expect(unclosedBlocks('@media (x) { a { b: c; }')).toBe(1))
  it('ignores braces in comments and strings', () => expect(unclosedBlocks('/* { */ a { content: "{"; }')).toBe(0))
  for (const file of readdirSync('src/styles').filter((name) => name.endsWith('.css'))) {
    it(`${file} closes every block`, () => expect(unclosedBlocks(readFileSync(`src/styles/${file}`, 'utf8'))).toBe(0))
  }
})
