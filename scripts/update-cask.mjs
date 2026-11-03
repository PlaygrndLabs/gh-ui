// Writes the Homebrew cask for a release, pinned to its version and installer checksums.
// usage: node scripts/update-cask.mjs <cask.rb> <version> <arm64 sha256> <x64 sha256>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './next-version.mjs'

export function renderCask({ version, arm64, x64 }) {
  compareVersions(version, version) // throws unless it's X.Y.Z
  for (const sha of [arm64, x64]) if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`Not a sha256: ${sha}`)
  return `cask "github-ui" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${arm64}",
         intel: "${x64}"

  url "https://github.com/PlaygrndLabs/gh-ui/releases/download/v#{version}/GitHub-UI-#{arch}.dmg"
  name "GitHub UI"
  desc "GitHub client with a built-in code review agent"
  homepage "https://github.com/PlaygrndLabs/gh-ui"

  depends_on :macos

  # The bundle keeps its build name inside; this is the name people see in Applications and Spotlight.
  app "gh-ui.app", target: "GitHub UI.app"

  # GitHub UI is distributed outside Apple's notarization service.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/GitHub UI.app"]
  end
end
`
}

/** The version a cask is pinned to; null when it isn't pinned yet (version :latest). */
export function caskVersion(text) {
  return /^\s*version "(\d+\.\d+\.\d+)"/m.exec(text)?.[1] ?? null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, version, arm64, x64] = process.argv.slice(2)
  const current = existsSync(file) ? caskVersion(readFileSync(file, 'utf8')) : null
  // Re-running an old release's job must not move Homebrew users back.
  if (current && compareVersions(version, current) < 0) throw new Error(`The cask is already at ${current}, newer than ${version}`)
  writeFileSync(file, renderCask({ version, arm64, x64 }))
}
