// New version notices for the desktop app. Builds aren't signed with an Apple Developer ID, which automatic updates need,
// so the app only says a release exists and shows how to get it. It never downloads or runs anything itself.

const REPO = 'PlaygrndLabs/gh-ui'
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const BREW_UPGRADE_COMMAND = 'brew update && brew upgrade --cask gh-ui'

export const releasePage = (version: string) => `https://github.com/${REPO}/releases/tag/v${version}`

const parts = (version: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return m ? m.slice(1).map(Number) : null
}

/** False for anything that isn't a plain X.Y.Z, so an odd tag or a build's own version never prompts an update. */
export function isNewerVersion(latest: string, current: string) {
  const a = parts(latest)
  const b = parts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The version from GitHub's answer, or null. It only supplies a version number: links are built here, not taken from it. */
export function releaseVersion(body: unknown): string | null {
  const release = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null
  if (!release || typeof release.tag_name !== 'string' || release.draft || release.prerelease) return null
  const version = release.tag_name.replace(/^v/, '')
  return parts(version) ? version : null
}
