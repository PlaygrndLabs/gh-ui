# gh-ui

A GitHub client that looks and works like github.com — built on GitHub's own Primer design system — with local repository management and a built-in Claude agent that reviews code, handles CodeRabbit / Greptile comments, fixes failing CI and re-runs Actions.

- **Desktop app (Electron)** — everything runs on your computer: GitHub API calls, sign-in, Actions logs, local git, and the agent (with your own Anthropic key). No server involved.
- **Web build (optional)** — the same UI deployed to Cloudflare Workers, for using gh-ui from a browser. The Worker only exists for the few things a browser can't do itself.

## Run the desktop app

```bash
npm install
npm run electron:dev        # Vite + Electron with hot reload
```

Package it:

```bash
npm run electron:build      # unpacked app in release/ (fast, for testing)
npm run electron:dist       # dmg/zip (mac), nsis (win), AppImage/deb (linux)
```

### Releases

Work lands on `main`. Merging `main` into the `release` branch builds the macOS installers in GitHub Actions and publishes them as a new GitHub Release (`.github/workflows/release.yml`). A pull request from `main` into `release` runs the same build without publishing and shows the version it would release in the run's summary. To add a platform, add a row to the workflow's matrix.

Use **Create a merge commit** on that pull request. A squash, a rebase or a direct commit to `release` fails the run without publishing, because it would give wrong versions; undo it on `release` and merge again.

Versions are `vX.Y.Z` git tags, and a published version is never replaced. `scripts/next-version.mjs` bumps the latest tag from the commit messages since it:

| Commits since the last release | Bump | Example |
| --- | --- | --- |
| `feat!:`, any `type!:` or a `BREAKING CHANGE:` footer | major (minor before 1.0) | `1.2.3` → `2.0.0` |
| `feat:` | minor | `1.2.3` → `1.3.0` |
| anything else | patch | `1.2.3` → `1.2.4` |

`package.json`'s version is a floor: set it higher to choose a version yourself, such as `1.0.0`. It isn't updated on each release; the installers get the tag's version at build time.

macOS builds are ad-hoc signed, not notarized (no Apple Developer ID, see electron-builder docs). The Homebrew cask in [PlaygrndLabs/homebrew-tap](https://github.com/PlaygrndLabs/homebrew-tap) clears macOS's quarantine flag on install, and each release pins it to its version and installer checksums; that needs a `HOMEBREW_TAP_TOKEN` repository secret that can write to the tap. For a direct download, see the README. Smoke test a build: `GH_UI_SMOKE_TEST=1 release/mac-arm64/gh-ui.app/Contents/MacOS/gh-ui`.

## Sign in

| Method | Desktop | Web | Notes |
| --- | --- | --- | --- |
| Personal access token (classic or fine-grained) | ✓ | ✓ | Classic: `repo, workflow, read:org, project, notifications` (`read:project` is enough to view projects; `delete_repo` only to delete repositories). Fine-grained: Contents, Pull requests, Issues, Actions, Checks, Projects, plus Administration, Webhooks, Secrets and Variables for repository settings (+ Workflows to edit `.github/workflows`). Fine-grained tokens can't read notifications. |
| GitHub CLI session (`gh auth token`) | ✓ | dev only | Reuses your existing `gh auth login`. |
| OAuth device flow | ✓ | ✓ (via Worker) | Needs the client ID of an OAuth App or GitHub App with “Enable Device Flow”. Set it on the login screen or in Settings → OAuth app. A GitHub App's client ID gives a `ghu_` user token, which works except for notifications. |
| OAuth web flow | — | ✓ | Worker with `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`. |
| GitHub Enterprise Server / GHE.com | ✓ | ✓ | “Change host” on the login screen. |
| GitHub App installation token (`ghs_`) | — | — | Not accepted: it has no user. Use the app's client ID with the device flow instead. |

Multiple accounts are supported (avatar panel → Add account / switch). Signing in again with the same login on the same host replaces that account's saved token. On desktop, tokens are encrypted with the OS keychain (Electron `safeStorage`); in the browser they live in `localStorage` for that origin. When GitHub starts rejecting a saved token (revoked, or an expired `ghu_` token), a banner offers **Sign in again**; gh-ui can't refresh tokens itself because GitHub's refresh grant needs the client secret.

### Creating an OAuth App for sign-in

At github.com → Settings → Developer settings → OAuth Apps → New OAuth App (or, for an app owned by an organization you administer, `https://github.com/organizations/<org>/settings/applications/new`):

| Field | Value |
| --- | --- |
| Application name | Anything (`gh-ui`); it's what the “Authorize” screen shows. |
| Homepage URL | Any URL, e.g. your GitHub profile. |
| Redirect URI | Web OAuth only: `https://<your-domain>/api/oauth/callback` (locally `http://127.0.0.1:8799/api/oauth/callback`). Leave wildcard matching off. |
| Enable Device Flow | On. |
| Expire user access tokens | **Off.** gh-ui doesn't refresh tokens: refreshing needs the client secret, which a desktop app can't keep. With expiry on, you'd sign in again every 8 hours. |

gh-ui's own OAuth App is built in through `.env` (`VITE_GITHUB_CLIENT_ID`) and used on github.com, so users don't enter a client ID there; other hosts ask for their own. A client ID is public and can be shared. If you fork gh-ui, replace it with your own. The client secret is only needed by the Worker's web flow; keep it out of the repo (`.dev.vars` locally, `wrangler secret put` in production). Anyone can authorize an OAuth App, but each person only gets a token for their own account.

## What's in it

The app is built for repositories, pull requests and Actions. Discussions, Projects, Wiki, Security and quality, Insights, repository settings, the Home activity feed and a few smaller parts start switched off; turn them on in Settings → Features.

- **Tabs (desktop)** — browser-style tabs, each with its own page and back/forward history. Cmd-click or middle-click any in-app link to open it in the background, Cmd+Shift-click to open it in front; other links go to your browser. Drag to reorder, middle-click to close. Tabs come back after a restart, per account and device. Recent tabs stay alive, so half-written comments, scroll position and expanded logs survive switching; beyond 8 live tabs the least recently used hidden ones unload and reload from their URL when shown. A tab with unsent text, or something still running, is never unloaded, and closing it or switching account asks first. The tab strip stays the same size when the page is zoomed. The agent panel is shared and follows the active tab.
- **Dashboard** — review requests, your PRs (with CI + review state), assigned issues, activity feed, top repositories.
- **Code** — file tree, README, About/languages/releases, branch & tag picker, go-to-file, syntax-highlighted file view with line links, in-place edit & commit, commits and commit diffs, branches (ahead/behind, PR links, create/delete).
- **Pull requests** — list with GitHub search filters; conversation timeline with review threads (reply, resolve/unresolve, edit, delete), merge box (checks, reviews, update branch, ready for review, merge/squash/rebase, delete branch), reviewers/assignees/labels editing, Commits, Checks (annotations, re-run), Files changed (file tree, unified/split diff, “viewed” tracking, approve / request changes), compare & create PR.
- **Code review** — select lines by dragging a line's “+” or shift-clicking line numbers (one side, one hunk) for multi-line comments; “Add a suggestion” (⌘G) in the comment editor; **Commit suggestion** / **Add suggestion to batch** on suggested changes (from reviewers, CodeRabbit or Greptile) when you can push, refused if the branch moved, with Co-authored-by credit. A pending review started anywhere (github.com, `gh`, another client) is picked up over GraphQL: new comments and replies go into it, its comments can be edited or deleted, and **Finish your review** submits or abandons it.
- **Issues** — list, create, comment, close as completed / not planned, labels & assignees.
- **Actions** — runs per workflow with filters, run summary and job graph, step-by-step logs with search and collapsible groups, re-run all / failed / single job, cancel, delete, `workflow_dispatch` with inputs, artifacts.
- **Notifications** — inbox with reasons and repository filters, mark read / done / unsubscribe.
- **Releases** — release notes, assets and download counts, per-tag pages; with push access, draft/edit/delete releases (choose or create a tag, generate release notes, pre-release / latest, discussion) and attach or remove assets (desktop only: GitHub's upload host sends no CORS headers).
- **Discussions** — categories, upvotes, answered state, threaded comments and replies.
- **Projects** — Projects (v2) linked to the repo, as a board grouped by Status or as a table; drag cards between columns, edit single-select, text, number, date and iteration cells, add draft issues or existing issues/PRs, and move, archive, delete or convert items (needs the `project` scope).
- **Security and quality** — Dependabot, code scanning, secret scanning alerts and repository advisories.
- **Insights** — weekly pulse, 52-week commit activity, top contributors.
- **Repository settings** (admins) — General (rename, features, merge buttons, default branch, Danger Zone with typed confirmations), About details, Collaborators and invitations, classic branch protection rules, rulesets (read-only), Webhooks with recent deliveries and redeliver, Deploy keys, Actions secrets (encrypted in the app with the repository's public key) and variables.
- **Wiki** — the desktop app clones `<repo>.wiki.git` and renders its pages (GitHub has no wiki API).
- **Local repositories (desktop)** — clone (HTTPS uses your signed-in token), add existing, changes with staging checkboxes, diff, discard, commit (with agent-written messages), branch switch/create, fetch/pull/push/publish, history.

### Keyboard shortcuts (desktop)

| Shortcut | Action |
| --- | --- |
| ⌘T | New tab (dashboard) |
| ⌘W | Close tab; closing the last one leaves a fresh dashboard. ⌘⇧W closes the window. |
| ⌘⇧T | Reopen the last closed tab |
| ⌥-click a link | Open it in the other pane, starting split view if needed |
| ⌘\\ | Split view on or off |
| ⌘⌥\\ | Move focus to the other pane |
| ⌘1…⌘8, ⌘9 | Go to that tab; ⌘9 is the last one |
| ⌃Tab, ⌃⇧Tab | Next, previous tab |
| ⌘[, ⌘] | Back, forward in the active tab |
| ⌥⌘1…⌥⌘5 | Home, Pull requests, Issues, Notifications, Local repositories (in the active tab) |
| ⌘⇧A | Toggle the agent |

On Windows and Linux, use Ctrl for ⌘.

## The agent

Open it with the **Agent** button (or ⌘⇧A in the desktop app). It knows what page you're on and offers page-specific actions: *Review this PR*, *Address bot comments*, *Fix failing checks*, *Explain failure*, and more. Bot comments get an **Address** button that hands that one comment to the agent.

It works through GitHub tools: reading PRs, diffs, files, review threads, checks, runs and job logs, discussions, releases and security alerts; and — after your approval — replying to and resolving review threads, posting comments, reviews and discussion replies, adding multi-line review comments and suggestions, committing fixes (multi-file commits with exact string edits, guarded by the expected head SHA), re-running / cancelling / dispatching workflows, updating and merging PRs.

- **Approval**: read tools run automatically; every write shows an Approve / Deny card unless you turn on auto-approve in Settings → Agent.
- **Models**: Claude Opus 5.5 by default (Sonnet 5.5, Haiku 5.5, Fable 5.1 selectable), adaptive thinking, configurable effort, streaming with eager tool-input streaming, prompt caching, and server-side refusal fallback enabled on models that support it.
- **Key**: desktop — your Anthropic API key, stored encrypted, requests go straight to api.anthropic.com. Web — your key in the browser, or the Worker's key restricted to `ALLOWED_GITHUB_USERS`.

## Web build and Cloudflare (optional)

```bash
npm run dev                 # browser dev server
npm run cf:dev              # build + wrangler dev (copy .dev.vars.example to .dev.vars first,
                            # or pass --var GITHUB_CLIENT_ID:… --var GITHUB_CLIENT_SECRET:… to wrangler dev)
npm run cf:deploy           # build + wrangler deploy
```

Worker settings (`wrangler.jsonc` vars, secrets via `npx wrangler secret put NAME`):

| Name | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` | Enables “Continue with GitHub” (device flow) without users entering a client ID. |
| `GITHUB_CLIENT_SECRET` (secret) | Enables the web OAuth redirect flow. Callback URL: `https://<your-domain>/api/oauth/callback`. |
| `ANTHROPIC_API_KEY` (secret) | Lets allowed users run the agent without their own key. |
| `ALLOWED_GITHUB_USERS` | Comma-separated logins allowed to use that key. A bare login means a github.com account; Enterprise accounts are written `host/login` (e.g. `github.example.com/alice`). `*` allows anyone who signs in — don't. |
| `GHES_HOSTS` | Extra GitHub Enterprise hosts for device flow and log proxying. |

Worker routes: `/api/config`, `/api/gh-login/*` (device-flow proxy; github.com sends no CORS headers), `/api/oauth/start|callback`, `/api/anthropic/v1/*` (verifies the caller's GitHub identity, then forwards with the server key), `/api/gh/job-logs` (follows the Actions log redirect without forwarding the token). Everything else is the SPA from Workers Static Assets, served with a strict CSP (`public/_headers`).

## Security model (desktop)

- The UI is served from a custom `app://gh-ui` origin with a CSP. Nothing navigates that document or opens another window: links outside the app go to your browser, and in-app links become validated paths in a tab's own router.
- Rendered markdown comes from GitHub's own HTML and is sanitized again with DOMPurify.
- The renderer can only run allow-listed git subcommands inside repositories you added, and never with options that execute programs, write arbitrary files or force-overwrite (`electron/git-policy.cjs`, tested in `electron/git-policy.test.ts`). Your token is given to git only for HTTPS fetch/pull/push/clone to the signed-in host, through an environment-scoped credential helper.
- Main-process HTTP (device flow, logs) is limited to public HTTPS hosts and drops the token on redirects.

## Development

```bash
npm run typecheck           # app + worker
npm test                    # vitest: agent loop (mocked API), Worker routes, device flow, PAT verification, git policy, suggestions, sealed box, projects GraphQL, parsers, links, tab state
npm run test:e2e:desktop    # real Electron app, throwaway profile: local git flow, gh sign-in, tabs, wiki clone + render
npm run build               # typecheck + production bundle
```

Layout: `src/` React app (`pages/`, `components/`, `lib/` incl. `lib/agent/`), `electron/` main + preload, `worker/` Cloudflare Worker.

## Packaging for Windows and Linux

`npm run electron:dist` is set up for NSIS (Windows) and AppImage + deb (Linux). From an Apple Silicon Mac the Windows app and the Linux AppImage/deb were built. The Linux arm64 app was launched in an Ubuntu 24.04 container under Xvfb and passed the smoke test (`GH_UI_SMOKE_TEST=1 ./gh-ui --no-sandbox`); the Windows app hasn't been launched. Two things need you:

- The `.deb` needs a maintainer: add `author` (`name`, `email`) to `package.json`, or `build.linux.maintainer`.
- electron-builder's default NSIS and AppImage tools are x86_64 only: install Rosetta 2 or build on Windows/Linux CI. Without `xz`/`gtar` on macOS, the deb also needs `-c.deb.compression=gz`.

## Not covered yet

Not checked against real accounts: the web OAuth flow in the Cloudflare build, and project editing (mocked data only). Logged-in screens follow GitHub's docs and weren't compared side by side with github.com. Mixed-side comment ranges (from a deleted line to an added line); editing rulesets, environment and organization secrets, and settings pages without an API (Pages, Actions permissions, social preview, …); multi-select fields, labels/assignees and the item side panel in Projects; signed/notarized builds. The Windows package builds but hasn't been launched. Actions logs are split into steps from GitHub's second-precision step times (the API no longer exposes per-step logs), so a composite action's last inner step can occasionally show at the top of the next step.
