// github.com, GHE.com (data residency, *.ghe.com) and GitHub Enterprise Server
// each expose the REST API at a different base URL.

export const DEFAULT_HOST = 'github.com'

export function normalizeHost(input: string): string {
  const trimmed = input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
  return trimmed || DEFAULT_HOST
}

export function apiBaseFor(host: string): string {
  if (host === DEFAULT_HOST) return 'https://api.github.com'
  if (host.endsWith('.ghe.com')) return `https://api.${host}`
  return `https://${host}/api/v3`
}

export function graphqlUrlFor(host: string): string {
  if (host === DEFAULT_HOST) return 'https://api.github.com/graphql'
  if (host.endsWith('.ghe.com')) return `https://api.${host}/graphql`
  return `https://${host}/api/graphql`
}

export function webBaseFor(host: string): string {
  return `https://${host}`
}

export type TokenKind = 'classic-pat' | 'fine-grained-pat' | 'oauth' | 'app-user' | 'app-installation' | 'unknown'

export function tokenKind(token: string): TokenKind {
  if (token.startsWith('ghp_')) return 'classic-pat'
  if (token.startsWith('github_pat_')) return 'fine-grained-pat'
  if (token.startsWith('gho_')) return 'oauth'
  if (token.startsWith('ghu_')) return 'app-user'
  if (token.startsWith('ghs_')) return 'app-installation'
  return 'unknown'
}

/** GitHub's notifications API takes classic PATs and OAuth App tokens only; the rest get 403. */
export function canReadNotifications(kind: TokenKind) {
  return kind !== 'fine-grained-pat' && kind !== 'app-user' && kind !== 'app-installation'
}

export const TOKEN_KIND_LABEL: Record<TokenKind, string> = {
  'classic-pat': 'Personal access token (classic)',
  'fine-grained-pat': 'Fine-grained personal access token',
  oauth: 'OAuth token',
  'app-user': 'GitHub App user token',
  'app-installation': 'GitHub App installation token',
  unknown: 'Token',
}
