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
- **Any sign-in.** PAT, GitHub CLI session, OAuth, or GitHub Enterprise.
- **Runs on your computer.** No server. Tokens are encrypted with your OS keychain, and the agent uses your own Anthropic key.

## Install

Download the macOS installer from [Releases](https://github.com/PlaygrndLabs/gh-ui/releases): `arm64` for Apple Silicon, `x64` for Intel. The app isn't notarized, so on first launch choose **Open Anyway** in System Settings → Privacy & Security.

## Run from source

```bash
npm install
npm run electron:dev
```

Sign in with a [personal access token](https://github.com/settings/tokens) and add your Anthropic key in Settings → Agent to use the agent.

To package the app, run `npm run electron:dist`. A web build for Cloudflare Workers is also available with `npm run cf:deploy`.

## More

[docs/GUIDE.md](docs/GUIDE.md) covers sign-in options, features, the agent, the Cloudflare setup, security and what's not covered yet.

## License

[MIT](LICENSE). gh-ui is an independent project, not affiliated with GitHub.
