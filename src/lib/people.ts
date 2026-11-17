// Who a name, login or git email belongs to, and the picture to show for them.

/** GitHub's private commit email, `[id+]login@users.noreply.github.com`, names its account. */
export function loginFromEmail(email?: string | null): string | undefined {
  const m = /^(?:\d+\+)?([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?)@users\.noreply\.github\.com$/i.exec(email?.trim() ?? '')
  return m?.[1]
}

/**
 * The picture for a person. A login is looked up by name; a git author without one by email,
 * which github.com answers with the account's avatar when the email is on one, and an identicon otherwise.
 * A bare git author name is never looked up as a login: it would show whoever holds that username.
 */
export function avatarUrlFor({ login, email, size }: { login?: string | null; email?: string | null; size: number }): string {
  const px = Math.max(1, Math.round(size * 2))
  if (login) return `https://avatars.githubusercontent.com/${login.replace(/\[bot\]$/, '')}?size=${px}`
  const byEmail = loginFromEmail(email)
  if (byEmail) return `https://avatars.githubusercontent.com/${byEmail.replace(/\[bot\]$/, '')}?size=${px}`
  if (email) return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email.trim())}&s=${px}`
  return ''
}

/** Up to two letters for a person with no picture: "Babak Rahimi" → "BR". */
export function initials(name?: string | null): string {
  const words = (name ?? '').trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? [...words[0]].slice(0, 1) : [[...words[0]][0], [...words[words.length - 1]][0]]
  return letters.join('').toUpperCase()
}
