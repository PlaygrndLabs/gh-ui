import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diff'
import { parseGitmodules, parseSubmoduleDiff, parseSubmoduleStatus, resolveSubmoduleUrl, submoduleChange, submoduleCommitChanged, submoduleRepository } from './submodule'

const A = 'f19e8b9e5d21e15b2a08f1962dea7af074e22884'
const B = '04c74537bb57e5068468c150df34c2cf6156a3c4'

// What `git diff HEAD -- vendor/lib` prints in each state (git 2.54).
const moved = `diff --git a/vendor/lib b/vendor/lib
index f19e8b9..04c7453 160000
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit ${A}
+Subproject commit ${B}
`
const dirtyOnly = `diff --git a/vendor/lib b/vendor/lib
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit ${A}
+Subproject commit ${A}-dirty
`
const added = `diff --git a/vendor/lib b/vendor/lib
new file mode 160000
index 0000000..f19e8b9
--- /dev/null
+++ b/vendor/lib
@@ -0,0 +1 @@
+Subproject commit ${A}
`
const removed = `diff --git a/vendor/lib b/vendor/lib
deleted file mode 160000
index f19e8b9..0000000
--- a/vendor/lib
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit ${A}
`
const file = `diff --git a/notes.md b/notes.md
index 1111111..2222222 100644
--- a/notes.md
+++ b/notes.md
@@ -1 +1 @@
-Subproject commit ${A}
+Subproject commits are written like this
`
const diffOf = (text: string) => parseUnifiedDiff(text)[0]

describe('parseSubmoduleDiff', () => {
  it('reads both commits when the submodule moved', () => expect(parseSubmoduleDiff(diffOf(moved))).toEqual({ from: A, to: B, dirty: false }))
  it('sees uncommitted changes inside one that has not moved', () => expect(parseSubmoduleDiff(diffOf(dirtyOnly))).toEqual({ from: A, to: A, dirty: true }))
  it('has no old commit for a new submodule', () => expect(parseSubmoduleDiff(diffOf(added))).toEqual({ from: null, to: A, dirty: false }))
  it('has no new commit for a removed one', () => expect(parseSubmoduleDiff(diffOf(removed))).toEqual({ from: A, to: null, dirty: false }))
  it('leaves an ordinary file alone, even one that quotes the line', () => expect(parseSubmoduleDiff(diffOf(file))).toBeNull())
  it('leaves an empty patch alone', () => expect(parseSubmoduleDiff({ patch: '' })).toBeNull())
})

describe('parseSubmoduleStatus', () => {
  const entry = (sub: string, path = 'vendor/lib') => `1 .M ${sub} 160000 160000 160000 ${A} ${A} ${path}\0`
  it('reads each kind of change', () => {
    expect(parseSubmoduleStatus(entry('SC..'))).toEqual({ commitChanged: true, modified: false, untracked: false })
    expect(parseSubmoduleStatus(entry('S.M.'))).toEqual({ commitChanged: false, modified: true, untracked: false })
    expect(parseSubmoduleStatus(entry('S..U'))).toEqual({ commitChanged: false, modified: false, untracked: true })
    expect(parseSubmoduleStatus(entry('SCMU'))).toEqual({ commitChanged: true, modified: true, untracked: true })
  })
  it('is null for an ordinary file', () => expect(parseSubmoduleStatus(`1 .M N... 100644 100644 100644 ${A} ${A} notes.md\0`)).toBeNull())
  it('is null when git lists nothing, or only an untracked file', () => {
    expect(parseSubmoduleStatus('')).toBeNull()
    expect(parseSubmoduleStatus('? new.txt\0')).toBeNull()
  })
  it('reads a path with spaces, which comes last', () => expect(parseSubmoduleStatus(entry('S.M.', 'third party/a lib'))?.modified).toBe(true))
})

describe('submoduleChange', () => {
  it('is null for an ordinary file', () => {
    expect(submoduleChange(diffOf(file), null)).toBeNull()
    expect(submoduleChange(null, null)).toBeNull()
  })
  it('has no commits for one whose only change is new files inside, which git diffs as nothing', () => {
    const change = submoduleChange(null, { commitChanged: false, modified: false, untracked: true })
    expect(change).toEqual({ from: null, to: null, modified: false, untracked: true })
    expect(submoduleCommitChanged(change!)).toBe(false)
  })
  it('takes the kinds of change from status and the commits from the diff', () => {
    const change = submoduleChange(diffOf(moved), { commitChanged: true, modified: false, untracked: true })
    expect(change).toEqual({ from: A, to: B, modified: false, untracked: true })
    expect(submoduleCommitChanged(change!)).toBe(true)
  })
  it('falls back on the diff when status could not be read', () => expect(submoduleChange(diffOf(dirtyOnly), null)).toEqual({ from: A, to: A, modified: true, untracked: false }))
  it('counts being added or removed as a commit to record', () => {
    expect(submoduleCommitChanged(submoduleChange(diffOf(added), null)!)).toBe(true)
    expect(submoduleCommitChanged(submoduleChange(diffOf(removed), null)!)).toBe(true)
  })
})

describe('parseGitmodules', () => {
  it('maps each folder to its address', () => {
    const text = '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://github.com/acme/lib.git\n[submodule "docs site"]\n\tpath = "docs/site/"\n\turl = ../site.git\n\tbranch = main\n'
    expect([...parseGitmodules(text)]).toEqual([
      ['vendor/lib', 'https://github.com/acme/lib.git'],
      ['docs/site', '../site.git'],
    ])
  })
  it('skips a section with no address', () => expect(parseGitmodules('[submodule "x"]\n\tpath = x\n').size).toBe(0))
})

describe('resolveSubmoduleUrl', () => {
  it('leaves a full address alone', () => expect(resolveSubmoduleUrl('git@gitlab.com:acme/lib.git', 'https://github.com/acme/app.git')).toBe('git@gitlab.com:acme/lib.git'))
  it('resolves a relative one against the parent’s remote', () => {
    expect(resolveSubmoduleUrl('../lib.git', 'https://github.com/acme/app.git')).toBe('https://github.com/acme/lib.git')
    expect(resolveSubmoduleUrl('../../other/lib', 'https://gitlab.com/acme/tools/app')).toBe('https://gitlab.com/acme/other/lib')
    expect(resolveSubmoduleUrl('../lib.git', 'git@github.com:acme/app.git')).toBe('git@github.com:acme/lib.git')
    expect(resolveSubmoduleUrl('./lib', 'https://github.com/acme/app')).toBe('https://github.com/acme/app/lib')
  })
  it('keeps a relative one as written when the parent has no remote', () => expect(resolveSubmoduleUrl('../lib', null)).toBe('../lib'))
})

describe('submoduleRepository', () => {
  it('names the repository and links to its page', () => {
    expect(submoduleRepository('git@gitlab.com:acme/tools/lib.git')).toEqual({ label: 'acme/tools/lib (gitlab.com)', href: 'https://gitlab.com/acme/tools/lib' })
    expect(submoduleRepository('https://github.com/acme/lib.git')).toEqual({ label: 'acme/lib (github.com)', href: 'https://github.com/acme/lib' })
  })
  it('has nothing to link for a folder on disk', () => expect(submoduleRepository('../lib')).toBeNull())
})
