import { describe, expect, it } from 'vitest'
import { parseCoAuthor, splitCommitMessage } from './commitMessage'

describe('parseCoAuthor', () => {
  it('reads a name and an email', () => {
    expect(parseCoAuthor('Mona Lisa <mona@example.com>')).toEqual({ name: 'Mona Lisa', email: 'mona@example.com' })
    expect(parseCoAuthor('  Mona <1+mona@users.noreply.github.com> ')).toEqual({ name: 'Mona', email: '1+mona@users.noreply.github.com' })
  })

  it('takes a name alone, and an email alone as the name', () => {
    expect(parseCoAuthor('Mona Lisa')).toEqual({ name: 'Mona Lisa' })
    expect(parseCoAuthor('<mona@example.com>')).toEqual({ name: 'mona@example.com', email: 'mona@example.com' })
  })

  it('refuses nothing, and the placeholder an old git leaves', () => {
    expect(parseCoAuthor('  ')).toBeNull()
    expect(parseCoAuthor('%(trailers:key=Co-authored-by,valueonly=true,separator=%x1e)')).toBeNull()
  })
})

describe('splitCommitMessage', () => {
  it('is only a summary when the message is one line', () => {
    expect(splitCommitMessage('Fix the login redirect')).toEqual({ summary: 'Fix the login redirect', body: '', coAuthors: [] })
  })

  it('takes Co-authored-by lines out of the description, whatever their case', () => {
    const message = 'Send expired logins through the router\n\nChatInput calls onAuthExpired.\nThe page logs out.\n\nCo-Authored-By: Claude <noreply@example.com>\nco-authored-by: Mona <mona@example.com>\n'
    expect(splitCommitMessage(message)).toEqual({
      summary: 'Send expired logins through the router',
      body: 'ChatInput calls onAuthExpired.\nThe page logs out.',
      coAuthors: [
        { name: 'Claude', email: 'noreply@example.com' },
        { name: 'Mona', email: 'mona@example.com' },
      ],
    })
  })

  it('leaves a message that is only trailers with no description', () => {
    expect(splitCommitMessage('Tidy\n\nCo-authored-by: Mona <mona@example.com>')).toEqual({ summary: 'Tidy', body: '', coAuthors: [{ name: 'Mona', email: 'mona@example.com' }] })
  })

  it('keeps other trailers, and names each person once', () => {
    const message = 'Tidy\n\nSigned-off-by: Lena <lena@example.com>\nCo-authored-by: Mona <mona@example.com>\nCo-authored-by: Mona L <MONA@example.com>'
    expect(splitCommitMessage(message)).toEqual({ summary: 'Tidy', body: 'Signed-off-by: Lena <lena@example.com>', coAuthors: [{ name: 'Mona', email: 'mona@example.com' }] })
  })

  it('drops the rule a squash merge puts above its co-authors, and no other', () => {
    expect(splitCommitMessage('Tidy (#1)\n\nBody\n\n---------\n\nCo-authored-by: Mona <mona@example.com>').body).toBe('Body')
    expect(splitCommitMessage('Tidy\n\nBody\n\n---------').body).toBe('Body\n\n---------')
  })

  it('reads Windows line endings', () => {
    expect(splitCommitMessage('Tidy\r\n\r\nBody\r\nCo-authored-by: Mona <mona@example.com>\r\n').body).toBe('Body')
  })
})
