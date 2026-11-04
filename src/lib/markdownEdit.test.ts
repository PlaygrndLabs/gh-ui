import { describe, expect, it } from 'vitest'
import { codeSelection, continueList, insertTrigger, linkSelection, pasteLink, styleLines, wrapSelection } from './markdownEdit'

describe('wrapSelection', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(wrapSelection('a word b', 2, 6, '**')).toEqual({ text: 'a **word** b', start: 4, end: 8 })
  })
  it('puts the cursor between the markers with no selection', () => {
    expect(wrapSelection('', 0, 0, '**')).toEqual({ text: '****', start: 2, end: 2 })
  })
  it('leaves outer whitespace outside the markers', () => {
    expect(wrapSelection('word ', 0, 5, '_').text).toBe('_word_ ')
  })
  it('removes markers on the second press, inside or outside the selection', () => {
    expect(wrapSelection('**word**', 2, 6, '**')).toEqual({ text: 'word', start: 0, end: 4 })
    expect(wrapSelection('**word**', 0, 8, '**')).toEqual({ text: 'word', start: 0, end: 4 })
  })
})

describe('styleLines', () => {
  it('styles the line holding the cursor and keeps the cursor on its text', () => {
    expect(styleLines('one\ntwo', 5, 5, 'heading')).toEqual({ text: 'one\n### two', start: 9, end: 9 })
  })
  it('numbers selected lines and skips blank ones', () => {
    expect(styleLines('a\n\nb', 0, 4, 'ordered').text).toBe('1. a\n\n2. b')
  })
  it('toggles off when every line has the style', () => {
    expect(styleLines('- a\n- b', 0, 7, 'bullet').text).toBe('a\nb')
    expect(styleLines('> a', 0, 3, 'quote').text).toBe('a')
    expect(styleLines('1. a', 0, 4, 'ordered').text).toBe('a')
    expect(styleLines('- [ ] a', 0, 7, 'task').text).toBe('a')
  })
  it('replaces one list style with another instead of nesting', () => {
    expect(styleLines('- a', 0, 3, 'task').text).toBe('- [ ] a')
    expect(styleLines('- [x] a', 0, 7, 'ordered').text).toBe('1. a')
    expect(styleLines('1. a', 0, 4, 'bullet').text).toBe('- a')
  })
  it('ignores the line a selection only touches at its start', () => {
    expect(styleLines('a\nb', 0, 2, 'quote').text).toBe('> a\nb')
  })
  it('starts a list on an empty editor', () => {
    expect(styleLines('', 0, 0, 'task')).toEqual({ text: '- [ ] ', start: 6, end: 6 })
  })
})

describe('codeSelection', () => {
  it('uses inline code on one line', () => {
    expect(codeSelection('a b', 2, 3).text).toBe('a `b`')
  })
  it('fences several lines on lines of their own', () => {
    expect(codeSelection('x a\nb y', 2, 5)).toEqual({ text: 'x \n```\na\nb\n```\n y', start: 7, end: 10 })
  })
})

describe('linkSelection', () => {
  it('selects the URL placeholder', () => {
    expect(linkSelection('docs', 0, 4)).toEqual({ text: '[docs](url)', start: 7, end: 10 })
  })
  it('uses a selected URL and waits for the text', () => {
    expect(linkSelection('https://a.dev', 0, 13)).toEqual({ text: '[](https://a.dev)', start: 1, end: 1 })
  })
})

describe('insertTrigger', () => {
  it('starts a new word', () => {
    expect(insertTrigger('hi', 2, 2, '@')).toEqual({ text: 'hi @', start: 4, end: 4 })
    expect(insertTrigger('', 0, 0, '#')).toEqual({ text: '#', start: 1, end: 1 })
  })
})

describe('pasteLink', () => {
  it('links selected text', () => {
    expect(pasteLink('see docs', 4, 8, 'https://a.dev/x')?.text).toBe('see [docs](https://a.dev/x)')
  })
  it('leaves other pastes alone', () => {
    expect(pasteLink('see docs', 4, 8, 'plain text')).toBeNull()
    expect(pasteLink('see docs', 8, 8, 'https://a.dev')).toBeNull()
    expect(pasteLink('https://old.dev', 0, 15, 'https://a.dev')).toBeNull()
    expect(pasteLink('a\nb', 0, 3, 'https://a.dev')).toBeNull()
  })
})

describe('continueList', () => {
  it('continues bullets, numbers and tasks', () => {
    expect(continueList('- a', 3, 3)).toEqual({ text: '- a\n- ', start: 6, end: 6 })
    expect(continueList('9. a', 4, 4)?.text).toBe('9. a\n10. ')
    expect(continueList('- [x] a', 7, 7)?.text).toBe('- [x] a\n- [ ] ')
    expect(continueList('  * a', 5, 5)?.text).toBe('  * a\n  * ')
    expect(continueList('> - a', 5, 5)?.text).toBe('> - a\n> - ')
  })
  it('splits an item when the cursor is inside it', () => {
    expect(continueList('- ab', 3, 3)?.text).toBe('- a\n- b')
  })
  it('ends the list on an empty item', () => {
    expect(continueList('- a\n- ', 6, 6)).toEqual({ text: '- a\n', start: 4, end: 4 })
  })
  it('leaves other lines, selections, markers and code blocks to the browser', () => {
    expect(continueList('plain', 5, 5)).toBeNull()
    expect(continueList('- a', 0, 3)).toBeNull()
    expect(continueList('- a', 1, 1)).toBeNull()
    expect(continueList('```\n- a', 7, 7)).toBeNull()
    expect(continueList('```\nx\n```\n- a', 13, 13)?.text).toBe('```\nx\n```\n- a\n- ')
  })
})
