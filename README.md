<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cover-dark.png" />
    <img src="docs/assets/cover-light.png" alt="gh-ui: a GUI for GitHub, with a code review agent" width="100%" />
  </picture>
</p>

# gh-ui: a GUI for GitHub, with a built-in code review agent

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Like the `gh` CLI, but with a graphical interface.** Pull requests, Actions, issues, releases and repository settings look and work like github.com, with local git and a Claude agent beside them. Sign in with just a token, or reuse your `gh` login.

## Why gh-ui

`gh` brings GitHub to your terminal. gh-ui brings it to an app, so you can read diffs, follow a failing run and review a change in one place, with an agent that can do the follow-up work.

- **Review.** Multi-line comments, suggestions you can commit, and pending reviews started anywhere.
- **Agent.** Reviews code, answers or fixes CodeRabbit and Greptile comments, and re-runs Actions. Every write waits for your approval.
- **Local git.** Clone, stage, commit, switch branches, pull and push.
- **Tabs.** Browser-style tabs in the desktop app, each with its own page and history.
- **Any sign-in.** PAT, GitHub CLI session, OAuth, or GitHub Enterprise.
- **Runs on your computer.** No server. Tokens are encrypted with your OS keychain, and the agent uses your own Anthropic key.

## Install

### macOS with Homebrew

This is the recommended option. Install [Homebrew](https://brew.sh/) first, then run:

```bash
brew tap PlaygrndLabs/tap
brew trust PlaygrndLabs/tap
brew install --cask github-ui
```

Open **GitHub UI** from Applications or Spotlight. To update it later:

```bash
brew upgrade --cask github-ui
```

### macOS direct download

Download `GitHub-UI-arm64.dmg` for Apple Silicon or `GitHub-UI-x64.dmg` for Intel from [Releases](https://github.com/PlaygrndLabs/gh-ui/releases). Open the disk image and move **GitHub UI** to Applications.

The app is not Apple-notarized. If macOS blocks the first launch, run:

```bash
xattr -dr com.apple.quarantine /Applications/gh-ui.app
```

## Run from source

```bash
npm install
npm run electron:dev
```

Sign in with **Continue with GitHub**, a [personal access token](https://github.com/settings/tokens) or your `gh` login, and add your Anthropic key in Settings → Agent to use the agent.

To package the app, run `npm run electron:dist`. A web build for Cloudflare Workers is also available with `npm run cf:deploy`.

## More

[docs/GUIDE.md](docs/GUIDE.md) covers sign-in options, features, the agent, the Cloudflare setup, security and what's not covered yet.

## License

[MIT](LICENSE). gh-ui is an independent project, not affiliated with GitHub.
