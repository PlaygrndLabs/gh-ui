# gh-ui

A desktop GitHub client in the spirit of GitHub Desktop: local git and GitHub in one simple window, built on GitHub's own Primer design system, with a built-in Claude agent that reviews code, handles CodeRabbit / Greptile comments, fixes failing CI and re-runs Actions.

Everything runs on your computer: GitHub API calls, sign-in, Actions logs, local git, and the agent (with your own Anthropic key). No server involved.

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

### Updates

The app checks GitHub for a newer release every 6 hours, without sending any token, and says so in the tab strip. It doesn't update itself, because automatic updates on macOS need an Apple Developer ID. Homebrew installs get the upgrade command copied and Terminal opened; other installs get the release page. Settings → Updates checks on demand, and Settings → Features turns the notice off.

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

| Method | Desktop | Notes |
| --- | --- | --- |
| Personal access token (classic or fine-grained) | ✓ | Classic: `repo, workflow, read:org, project, notifications` (`read:project` is enough to view projects; `delete_repo` only to delete repositories). Fine-grained: Contents, Pull requests, Issues, Actions, Checks, Projects, plus Administration, Webhooks, Secrets and Variables for repository settings (+ Workflows to edit `.github/workflows`). Fine-grained tokens can't read notifications. |
| GitHub CLI session (`gh auth token`) | ✓ | Reuses your existing `gh auth login`. |
| OAuth device flow | ✓ | Needs the client ID of an OAuth App or GitHub App with “Enable Device Flow”. Set it on the login screen or in Settings → OAuth app. A GitHub App's client ID gives a `ghu_` user token, which works except for notifications. |
| GitHub Enterprise Server / GHE.com | ✓ | “Change host” on the login screen. |
| GitHub App installation token (`ghs_`) | — | Not accepted: it has no user. Use the app's client ID with the device flow instead. |

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

gh-ui's own OAuth App is built in through `.env` (`VITE_GITHUB_CLIENT_ID`) and used on github.com, so users don't enter a client ID there; other hosts ask for their own. A client ID is public and can be shared. If you fork gh-ui, replace it with your own. Anyone can authorize an OAuth App, but each person only gets a token for their own account.

## What's in it

The app is built for repositories, pull requests and Actions. Home is a work queue: pull requests waiting on you, your own, and failing or running Actions. A pull request shows its checks, reviews and conflicts on one line, with Re-run failed, copy link and Check out, which uses your local clone. Discussions, Projects, Wiki, Security and quality, Insights, repository settings, the Home activity feed and a few smaller parts start switched off; turn them on in Settings → Features.

- **Repository tabs** — one Chrome-style tab per repository, each with its own view and Claude chat. A link to another repository moves to its tab, and pages outside a repository (search, profiles, settings) get their own. **+** opens the repository list: folders on your Mac, repositories on GitHub, Add local folder, Clone, New.
- **Toolbar** — the branch menu, the only place to choose a branch, and one sync button that becomes Clone, Publish repository, Publish branch, Pull, Push or Fetch as the repository needs. A third segment picks the open tab's pull request, run, issue or release. Below it, every page is a tab of its own: Branch, Pull requests, Actions, Code, Issues, Releases, and Discussions, Projects, Wiki, Security, Insights and Repository settings when they're on. Each tab keeps its page while another is shown, as it was left: the open pull request, its scroll, what was typed. Clicking the tab you're on leaves the page alone. At the end of the row: Refresh (reloads what the page shows), Copy link and Open in browser for the shown pull request, run, issue, release or branch, plus Open in editor and Show in Finder for folders. A tab's count is its open pull requests or issues, or the branch's changed files.
- **Panes** — every list and detail can be resized by dragging or with the arrow keys, and hidden by dragging its divider well past the edge (or pressing Enter on it); drag or click the strip that's left to bring it back. Double-click a divider to reset it. Layouts are remembered, and shared by all tabs.
- **Inbox** — reviews you were asked for and your pull requests with failing checks, across all repositories.
- **Split view** — two tabs side by side: drag a tab to an edge, use its menu, or the button at the end of the strip.
- **Comment and description editor** — GitHub's formatting toolbar and shortcuts (Cmd-B, Cmd-I, Cmd-E, Cmd-K, Cmd-Shift-. for a quote, Cmd-Shift-7, 8 and L for lists), lists that continue on Enter, and pasting a URL over selected text to link it.
- **Mermaid diagrams** — drawn in the app, in its light or dark theme, wherever Markdown appears.
- **Code** — file tree, README, About/languages/releases, branch & tag picker, go-to-file, syntax-highlighted file view with line links, in-place edit & commit, commits and commit diffs, branches (ahead/behind, PR links, create/delete).
- **Pull requests** — picked from the toolbar's menu (All, To review, Mine; the checked-out branch's pull request first), and shown at the window's full width: chat next to its files or commits, per-commit diffs, a status bar with state, review, checks, conflicts, open threads and files viewed, check out and copy link. Search and filter all, and New pull request, at the foot of the menu; conversation timeline with review threads (reply, resolve/unresolve, edit, delete), merge box (checks, reviews, update branch, ready for review, merge/squash/rebase, delete branch), reviewers/assignees/labels editing, Commits, Checks (annotations, re-run), Files changed (file tree, unified/split diff, “viewed” tracking, approve / request changes), compare & create PR (New pull request starts from the recently updated branches, each with Compare & pull request or its open pull request).
- **Code review** — select lines by dragging a line's “+” or shift-clicking line numbers (one side, one hunk) for multi-line comments; “Add a suggestion” (⌘G) in the comment editor; **Commit suggestion** / **Add suggestion to batch** on suggested changes (from reviewers, CodeRabbit or Greptile) when you can push, refused if the branch moved, with Co-authored-by credit. A pending review started anywhere (github.com, `gh`, another client) is picked up over GraphQL: new comments and replies go into it, its comments can be edited or deleted, and **Finish your review** submits or abandons it.
- **Issues** — list, and in the desktop app a toolbar menu (Open, Closed) to jump between them; create, comment, close as completed / not planned, labels & assignees.
- **Actions** — runs picked from the toolbar's menu (All, Failing, This branch) and shown at full width; all workflows with filters at the foot of the menu, run summary and job graph, step-by-step logs with search and collapsible groups, re-run all / failed / single job, cancel, delete, `workflow_dispatch` with inputs, artifacts.
- **Notifications** — inbox with reasons and repository filters, mark read / done / unsubscribe.
- **Releases** — release notes, assets and download counts, per-tag pages, picked from a toolbar menu in the desktop app; with push access, draft/edit/delete releases (choose or create a tag, generate release notes, pre-release / latest, discussion) and attach or remove assets (desktop only: GitHub's upload host sends no CORS headers).
- **Discussions** — categories, upvotes, answered state, threaded comments and replies.
- **Projects** — Projects (v2) linked to the repo, as a board grouped by Status or as a table; drag cards between columns, edit single-select, text, number, date and iteration cells, add draft issues or existing issues/PRs, and move, archive, delete or convert items (needs the `project` scope).
- **Security and quality** — Dependabot, code scanning, secret scanning alerts and repository advisories.
- **Insights** — weekly pulse, 52-week commit activity, top contributors.
- **Repository settings** (admins) — General (rename, features, merge buttons, default branch, Danger Zone with typed confirmations), About details, Collaborators and invitations, classic branch protection rules, rulesets (read-only), Webhooks with recent deliveries and redeliver, Deploy keys, Actions secrets (encrypted in the app with the repository's public key) and variables.
- **Wiki** — the desktop app clones `<repo>.wiki.git` and renders its pages (GitHub has no wiki API).
- **Branch** — the branch chosen in the toolbar, which checks it out in a folder and just shows it for a repository not cloned yet: tabs for uncommitted files with staging, commits only on your Mac, commits on GitHub including ones not pulled yet, its pull request (not on the default branch, which pull requests merge into) and its checks, with the selected file or commit beside them. Commit (with agent-written messages), undo, discard, and stash when a switch would overwrite changes. Works for a folder with no GitHub repository (with a Publish prompt) and for a repository not cloned yet. Clone with HTTPS uses your signed-in token; SSH URLs use your SSH keys, and the clone dialog offers to switch them to HTTPS.

### Keyboard shortcuts (desktop)

| Shortcut | Action |
| --- | --- |
| ⌘T | New tab, which offers repositories to open |
| ⌘W | Close tab; closing the last one leaves a new tab. ⌘⇧W closes the window. |
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
- **Key**: your Anthropic API key, stored encrypted; requests go straight to api.anthropic.com.

## Security model (desktop)

- The UI is served from a custom `app://gh-ui` origin with a CSP. Nothing navigates that document or opens another window: links outside the app go to your browser, and in-app links become validated paths in a tab's own router.
- Rendered markdown comes from GitHub's own HTML and is sanitized again with DOMPurify.
- Mermaid diagrams are written by whoever wrote the pull request, so they render in a sandboxed frame with no origin and no network access, and only the sanitized SVG reaches the app.
- The renderer can only run allow-listed git subcommands inside repositories you added, and never with options that execute programs, write arbitrary files or force-overwrite (`electron/git-policy.cjs`, tested in `electron/git-policy.test.ts`). Your token is given to git only for HTTPS fetch/pull/push/clone to the signed-in host, through an environment-scoped credential helper.
- Main-process HTTP (device flow, logs) is limited to public HTTPS hosts and drops the token on redirects.

## Development

```bash
npm run typecheck
npm test                    # vitest: agent loop (mocked API), device flow, PAT verification, git policy, suggestions, sealed box, projects GraphQL, parsers, links, tab state
npm run test:e2e:desktop    # real Electron app, throwaway profile: local git flow, gh sign-in, one tab per repository, branches, pull requests, Actions, panes, inbox, wiki clone + render
npm run build               # typecheck + production bundle
```

Layout: `src/` React app (`pages/`, `components/`, `lib/` incl. `lib/agent/`), `pages/workspace/` the desktop views, `electron/` main + preload.

## Packaging for Windows and Linux

`npm run electron:dist` is set up for NSIS (Windows) and AppImage + deb (Linux). From an Apple Silicon Mac the Windows app and the Linux AppImage/deb were built. The Linux arm64 app was launched in an Ubuntu 24.04 container under Xvfb and passed the smoke test (`GH_UI_SMOKE_TEST=1 ./gh-ui --no-sandbox`); the Windows app hasn't been launched. Two things need you:

- The `.deb` needs a maintainer: add `author` (`name`, `email`) to `package.json`, or `build.linux.maintainer`.
- electron-builder's default NSIS and AppImage tools are x86_64 only: install Rosetta 2 or build on Windows/Linux CI. Without `xz`/`gtar` on macOS, the deb also needs `-c.deb.compression=gz`.

## Not covered yet

The editor can't attach files, because GitHub has no public API for comment uploads, and it doesn't autocomplete @mentions or #references yet.

Not checked against real accounts: project editing (mocked data only). Logged-in screens follow GitHub's docs and weren't compared side by side with github.com. Mixed-side comment ranges (from a deleted line to an added line); editing rulesets, environment and organization secrets, and settings pages without an API (Pages, Actions permissions, social preview, …); multi-select fields, labels/assignees and the item side panel in Projects; signed/notarized builds. The Windows package builds but hasn't been launched. Actions logs are split into steps from GitHub's second-precision step times (the API no longer exposes per-step logs), so a composite action's last inner step can occasionally show at the top of the next step.
