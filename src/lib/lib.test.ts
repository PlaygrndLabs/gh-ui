import { describe, expect, it } from 'vitest'
import { parsePatch, parseUnifiedDiff } from './diff'
import { splitRefPath } from './repo'
import { appPathFromApiUrl, appPathFromUrl, mapSrcset, parseRemote, safeNextPath, toHttpsRemote } from './links'
import { assetUploadUrl, isValidTagName, makeLatestValue, tagMenu } from './releases'
import { parseLog, splitLogBySteps, summarizeLog } from './logs'
import { apiBaseFor, canReadNotifications, tokenKind } from './hosts'
import { highlightLines } from './highlight'
import { compactNumber, formatDuration } from './format'

describe('parsePatch', () => {
  it('numbers lines and computes review positions across hunks', () => {
    const lines = parsePatch('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n x\n+y\n z')
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'context', 'del', 'add', 'context', 'hunk', 'context', 'add', 'context'])
    const add = lines[3]
    expect(add).toMatchObject({ content: 'B', oldNo: null, newNo: 2, position: 3 })
    expect(lines[5].position).toBe(5) // second @@ counts as a position
    expect(lines[7]).toMatchObject({ newNo: 11, position: 7 })
  })
})

describe('parseUnifiedDiff', () => {
  it('splits git diff output into files with status and counts', () => {
    const out = parseUnifiedDiff(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1..2 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1,2 @@',
        ' x',
        '+y',
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1 @@',
        '+hello',
      ].join('\n'),
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ newPath: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 })
    expect(out[1]).toMatchObject({ newPath: 'new.txt', status: 'added', additions: 1 })
  })
})

describe('splitRefPath', () => {
  it('prefers the longest known ref so branch names with slashes work', () => {
    expect(splitRefPath('feature/x/src/index.ts', ['main', 'feature/x'], 'main')).toEqual({ ref: 'feature/x', path: 'src/index.ts' })
    expect(splitRefPath('main', ['main'], 'main')).toEqual({ ref: 'main', path: '' })
    expect(splitRefPath('', ['main'], 'main')).toEqual({ ref: 'main', path: '' })
    expect(splitRefPath('abc123/docs', [], 'main')).toEqual({ ref: 'abc123', path: 'docs' })
  })
})

describe('links', () => {
  it('maps github.com URLs to app routes', () => {
    expect(appPathFromUrl('https://github.com/acme/web/pull/12/files', 'github.com')).toBe('/acme/web/pull/12/files')
    expect(appPathFromUrl('https://github.com/acme/web/pull/12#discussion_r1', 'github.com')).toBe('/acme/web/pull/12#discussion_r1')
    expect(appPathFromUrl('https://github.com/acme/web/blob/main/a.ts#L3', 'github.com')).toBe('/acme/web/blob/main/a.ts#L3')
    expect(appPathFromUrl('https://github.com/acme', 'github.com')).toBe('/acme')
    expect(appPathFromUrl('https://github.com/settings/tokens', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/acme/web/wiki/Home', 'github.com')).toBe('/acme/web/wiki/Home')
    expect(appPathFromUrl('https://github.com/acme/web/settings', 'github.com')).toBe('/acme/web/settings')
    expect(appPathFromUrl('https://github.com/acme/web/settings/branch_protection_rules/7', 'github.com')).toBe('/acme/web/settings/branch_protection_rules/7')
    expect(appPathFromUrl('https://github.com/acme/web/settings/rules', 'github.com')).toBe('/acme/web/settings/rules')
    expect(appPathFromUrl('https://github.com/acme/web/settings/rules/42', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/acme/web/settings/pages', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://example.com/acme/web', 'github.com')).toBeNull()
  })
  it('maps only release pages the app has, and leaves downloads external', () => {
    expect(appPathFromUrl('https://github.com/acme/web/releases', 'github.com')).toBe('/acme/web/releases')
    expect(appPathFromUrl('https://github.com/acme/web/releases/tag/v1.2.0', 'github.com')).toBe('/acme/web/releases/tag/v1.2.0')
    expect(appPathFromUrl('https://github.com/acme/web/releases/tag/app/v1#notes', 'github.com')).toBe('/acme/web/releases/tag/app/v1#notes')
    expect(appPathFromUrl('https://github.com/acme/web/releases/latest', 'github.com')).toBe('/acme/web/releases/latest')
    expect(appPathFromUrl('https://github.com/acme/web/blame/main/src/a.ts#L3', 'github.com')).toBe('/acme/web/blame/main/src/a.ts#L3')
    expect(appPathFromUrl('https://github.com/orgs/acme', 'github.com')).toBe('/acme')
    expect(appPathFromUrl('https://github.com/orgs/acme/repositories?q=web', 'github.com')).toBe('/acme?q=web&tab=repositories')
    expect(appPathFromUrl('https://github.com/orgs/acme/packages', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/orgs/acme/teams/core', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/acme/web/releases/latest/download/app.dmg', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/acme/web/releases/download/v1.2.0/app.dmg', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/acme/web/releases/new', 'github.com')).toBe('/acme/web/releases/new')
    expect(appPathFromUrl('https://github.com/acme/web/releases/new?tag=v2', 'github.com')).toBe('/acme/web/releases/new?tag=v2')
    expect(appPathFromUrl('https://github.com/acme/web/releases/edit/app/v1', 'github.com')).toBe('/acme/web/releases/edit/app/v1')
    expect(appPathFromUrl('https://github.com/acme/web/releases/edit', 'github.com')).toBeNull()
    expect(appPathFromUrl('https://github.com/acme/web/releases/tag', 'github.com')).toBeNull()
  })
  it('maps API URLs (notification subjects) to app routes', () => {
    expect(appPathFromApiUrl('https://api.github.com/repos/acme/web/pulls/5')).toBe('/acme/web/pull/5')
    expect(appPathFromApiUrl('https://api.github.com/repos/acme/web/issues/7')).toBe('/acme/web/issues/7')
    expect(appPathFromApiUrl('https://api.github.com/repos/acme/web/commits/abc')).toBe('/acme/web/commit/abc')
  })
  it('parses https and ssh remotes', () => {
    expect(parseRemote('git@github.com:acme/web.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
    expect(parseRemote('https://github.com/acme/web.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
    expect(parseRemote('ssh://git@ghe.example.com/acme/web')).toEqual({ host: 'ghe.example.com', owner: 'acme', repo: 'web' })
  })
})

describe('hosts', () => {
  it('resolves API bases for github.com, GHE.com and GHES', () => {
    expect(apiBaseFor('github.com')).toBe('https://api.github.com')
    expect(apiBaseFor('acme.ghe.com')).toBe('https://api.acme.ghe.com')
    expect(apiBaseFor('git.corp.example')).toBe('https://git.corp.example/api/v3')
  })
  it('classifies token prefixes', () => {
    expect(tokenKind('ghp_x')).toBe('classic-pat')
    expect(tokenKind('github_pat_x')).toBe('fine-grained-pat')
    expect(tokenKind('gho_x')).toBe('oauth')
    expect(tokenKind('ghs_x')).toBe('app-installation')
  })
})

describe('Actions logs', () => {
  const raw = [
    '2026-10-30T10:00:00.0000000Z ##[group]Run npm test',
    '2026-10-30T10:00:00.1000000Z npm test',
    '2026-10-30T10:00:00.2000000Z ##[endgroup]',
    '2026-10-30T10:00:01.0000000Z \u001b[31mFAIL\u001b[0m src/a.test.ts',
    '2026-10-30T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
  ].join('\n')
  it('strips timestamps and ANSI codes and classifies lines', () => {
    const lines = parseLog(raw)
    expect(lines.map((l) => l.kind)).toEqual(['group', 'normal', 'endgroup', 'error', 'error'])
    expect(lines[3].text).toBe('FAIL src/a.test.ts')
    expect(lines[0].time).toBe('2026-10-30T10:00:00.0000000Z')
  })
  it('summarizes errors with context for the agent', () => {
    const s = summarizeLog(raw, { tail: 1 })
    expect(s).toContain('Total lines: 5')
    expect(s).toContain('Process completed with exit code 1.')
  })
})

describe('highlightLines', () => {
  it('keeps multi-line tokens balanced per line', () => {
    const lines = highlightLines('/* a\n b */\nconst x = 1', 'typescript')
    expect(lines).toHaveLength(3)
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length)
    expect(lines[1]).toContain('hljs-comment')
  })
})

describe('splitLogBySteps', () => {
  const at = (s: string) => `2026-10-30T10:00:${s}Z`
  const line = (time: string, text: string) => `${at(time)} ${text}`
  const step = (number: number, name: string, start: string, end: string, conclusion = 'success') => ({
    number,
    name,
    status: 'completed',
    conclusion,
    started_at: at(start),
    completed_at: at(end),
  })
  const names = (steps: ReturnType<typeof splitLogBySteps>) => Object.fromEntries(steps.map((s) => [s.name, s.lines.map((l) => l.text)]))

  it('gives each of several steps in the same second its own header (custom names included)', () => {
    const steps = [step(1, 'Set up job', '50', '50'), step(2, 'Deploy only chef', '51', '51'), step(3, 'Check credentials', '51', '51'), step(4, 'Run actions/checkout@v4', '51', '53')]
    const log = [
      line('50.1975753', "Current runner version: '2.338.2'"),
      line('51.0367397', '##[group]Run case "$NAME" in chef) ;; esac'),
      line('51.0400000', '##[endgroup]'),
      line('51.0619168', '##[group]Run if [ -z "$TOKEN" ]; then exit 1; fi'),
      line('51.0700000', '##[endgroup]'),
      line('51.0997431', '##[group]Run actions/checkout@v4'),
      line('52.5000000', 'Fetching the repository'),
    ].join('\n')
    const by = names(splitLogBySteps(steps, parseLog(log)))
    expect(by['Set up job']).toEqual(["Current runner version: '2.338.2'"])
    expect(by['Deploy only chef'][0]).toMatch(/^Run case/)
    expect(by['Check credentials'][0]).toMatch(/^Run if/)
    expect(by['Run actions/checkout@v4']).toEqual(['Run actions/checkout@v4', 'Fetching the repository'])
  })

  it('keeps a composite action’s inner "Run …" groups in their own step', () => {
    const steps = [step(1, 'Setup (composite)', '01', '05'), step(2, 'Build', '05', '09')]
    const log = [
      line('01.10', '##[group]Run ./.github/actions/setup'),
      line('04.20', '##[group]Run echo "done setup"'),
      line('04.30', 'done setup'),
      line('05.10', '##[group]Run npm run build'),
      line('06.00', 'built'),
    ].join('\n')
    const by = names(splitLogBySteps(steps, parseLog(log)))
    expect(by['Setup (composite)']).toEqual(['Run ./.github/actions/setup', 'Run echo "done setup"', 'done setup'])
    expect(by['Build']).toEqual(['Run npm run build', 'built'])
  })

  it('keeps a fast failing step’s header and error, even when its name starts with "Run"', () => {
    const steps = [step(1, 'Install deps', '00', '05'), step(2, 'Run lint', '05', '05', 'failure'), step(3, 'Test', '05', '05', 'skipped'), step(4, 'Post Run actions/checkout@v4', '05', '06')]
    const log = [
      line('04.90', 'added 120 packages'),
      line('05.10', '##[group]Run npm run lint'),
      line('05.30', 'src/a.ts: 1 problem'),
      line('05.40', '##[error]Process completed with exit code 1.'),
      line('05.60', 'Post job cleanup.'),
    ].join('\n')
    const by = names(splitLogBySteps(steps, parseLog(log)))
    expect(by['Install deps']).toEqual(['added 120 packages'])
    expect(by['Run lint']).toEqual(['Run npm run lint', 'src/a.ts: 1 problem', 'Process completed with exit code 1.'])
    expect(by['Test']).toEqual([])
    expect(by['Post Run actions/checkout@v4']).toEqual(['Post job cleanup.'])
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours like github.com', () => {
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(5 * 60_000 + 7_000)).toBe('5m 7s')
    expect(formatDuration(3600_000)).toBe('1h 0m 0s')
    expect(formatDuration((3600 + 41 * 60 + 20) * 1000)).toBe('1h 41m 20s')
  })
  it('returns an empty string for invalid durations', () => {
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(NaN)).toBe('')
  })
})

describe('compactNumber', () => {
  it('abbreviates like github.com counters', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1000)).toBe('1k')
    expect(compactNumber(17_480)).toBe('17.5k')
    expect(compactNumber(85_100)).toBe('85.1k')
    expect(compactNumber(99_960)).toBe('100k')
    expect(compactNumber(123_600)).toBe('124k')
    expect(compactNumber(999_700)).toBe('1M')
    expect(compactNumber(3_160_000)).toBe('3.2M')
  })
})

describe('safeNextPath', () => {
  it('keeps paths on this origin with their query and hash', () => {
    expect(safeNextPath('/octo/hello/pulls?q=is%3Aopen#top')).toBe('/octo/hello/pulls?q=is%3Aopen#top')
    expect(safeNextPath('/')).toBe('/')
  })

  it.each(['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example/', 'javascript:alert(1)', '', null, undefined])(
    'sends %j home instead of off-site',
    (next) => expect(safeNextPath(next)).toBe('/'),
  )
})

describe('canReadNotifications', () => {
  it('allows classic PATs and OAuth tokens only', () => {
    expect(['ghp_x', 'gho_x', 'github_pat_x', 'ghu_x', 'ghs_x'].map((t) => canReadNotifications(tokenKind(t)))).toEqual([true, true, false, false, false])
  })
})

describe('mapSrcset', () => {
  const rebase = (url: string) => (/^https?:/.test(url) ? null : `https://raw.example/${url}`)
  it('rewrites every candidate of a multi-candidate srcset, keeping descriptors', () => {
    expect(mapSrcset('a.png 1x, b.png 2x', rebase)).toBe('https://raw.example/a.png 1x, https://raw.example/b.png 2x')
    expect(mapSrcset('small.png 480w,large.png 1080w', rebase)).toBe('https://raw.example/small.png 480w, https://raw.example/large.png 1080w')
    expect(mapSrcset('  docs/dark.png  ', rebase)).toBe('https://raw.example/docs/dark.png')
  })
  it('leaves absolute candidates alone and keeps commas inside URLs', () => {
    expect(mapSrcset('https://cdn.example/a.png 1x, b.png 2x', rebase)).toBe('https://cdn.example/a.png 1x, https://raw.example/b.png 2x')
    expect(mapSrcset('img/a,b.png 1x, c.png 2x', rebase)).toBe('https://raw.example/img/a,b.png 1x, https://raw.example/c.png 2x')
    expect(mapSrcset('a.png, b.png 2x', rebase)).toBe('https://raw.example/a.png, https://raw.example/b.png 2x')
  })
})

describe('release form helpers', () => {
  it('validates new tag names like git check-ref-format', () => {
    for (const ok of ['v1.0.0', 'release/2024-01', 'v2.0.0-beta.1', 'app@1.2']) expect(isValidTagName(ok)).toBe(true)
    for (const bad of ['', 'v 1', 'v1..2', 'v1.lock', '.hidden', 'a/.b', 'v1/', 'v1.', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a//b', '-x', '@'])
      expect(isValidTagName(bad)).toBe(false)
  })
  it('filters tags and offers to create a new one only for a new, valid name', () => {
    const tags = ['v1.0.0', 'v1.1.0', 'v2.0.0']
    expect(tagMenu(tags, '')).toEqual({ matches: tags, create: null })
    expect(tagMenu(tags, 'V1')).toEqual({ matches: ['v1.0.0', 'v1.1.0'], create: 'V1' })
    expect(tagMenu(tags, ' v2.0.0 ')).toEqual({ matches: ['v2.0.0'], create: null })
    expect(tagMenu(tags, 'v3.0.0')).toEqual({ matches: [], create: 'v3.0.0' })
    expect(tagMenu(tags, 'bad name')).toEqual({ matches: [], create: null })
  })
  it('maps "Set as the latest release" to make_latest', () => {
    const base = { checked: true, prerelease: false, publishing: true, isNew: true, wasLatest: false }
    expect(makeLatestValue(base)).toBe('true')
    expect(makeLatestValue({ ...base, checked: false })).toBe('legacy')
    expect(makeLatestValue({ ...base, prerelease: true })).toBeUndefined()
    expect(makeLatestValue({ ...base, publishing: false })).toBeUndefined()
    expect(makeLatestValue({ ...base, isNew: false, checked: false, wasLatest: true })).toBe('false')
    expect(makeLatestValue({ ...base, isNew: false, checked: false, wasLatest: false })).toBeUndefined()
  })
  it('expands the upload_url template for one file', () => {
    const url = 'https://uploads.github.com/repos/acme/web/releases/1/assets{?name,label}'
    expect(assetUploadUrl(url, 'app v1.zip')).toBe('https://uploads.github.com/repos/acme/web/releases/1/assets?name=app%20v1.zip')
    expect(assetUploadUrl(url, 'a.txt', 'Notes')).toBe('https://uploads.github.com/repos/acme/web/releases/1/assets?name=a.txt&label=Notes')
  })
})

describe('toHttpsRemote', () => {
  it('rewrites SSH remotes and leaves others alone', () => {
    expect(toHttpsRemote('git@github.com:acme/web.git')).toBe('https://github.com/acme/web.git')
    expect(toHttpsRemote('ssh://git@ghe.example.com/acme/web')).toBe('https://ghe.example.com/acme/web.git')
    expect(toHttpsRemote('https://github.com/acme/web.git')).toBeNull()
    expect(toHttpsRemote('')).toBeNull()
  })
})
