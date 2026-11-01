import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ActionList, AnchoredOverlay, Button, IconButton, Label, Spinner, TextInput } from '@primer/react'
import { GitBranchIcon, TagIcon, TriangleDownIcon, ShieldLockIcon, SearchIcon, XIcon } from '@primer/octicons-react'
import { useGitHub } from '../lib/github'
import { useBranches, useTags } from '../lib/repo'
import { firstLine } from '../lib/format'

interface BranchPickerProps {
  owner: string
  repo: string
  value: string
  onChange(ref: string): void
  /** Text before the ref in the button, e.g. "base:". */
  prefix?: string
  includeTags?: boolean
  size?: 'small' | 'medium'
  defaultBranch?: string
  /**
   * The release form's "Target" menu: a Recent Commits tab (the default branch's latest commits) instead of
   * Tags, and no "View all" link that would leave the form.
   */
  recentCommits?: boolean
}

/** Latest commits on a branch, for the Recent Commits tab. */
function useRecentCommits(owner: string, repo: string, branch: string | undefined, enabled: boolean) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'recent-commits', owner, repo, branch],
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await octokit.rest.repos.listCommits({ owner, repo, sha: branch, per_page: 30 })).data.map((c) => ({ sha: c.sha, message: firstLine(c.commit.message) })),
  })
}

/** The github.com ref selector: title, filter, Branches/Tags tabs, checked list and a "View all" footer. */
export function BranchPicker({ owner, repo, value, onChange, prefix, includeTags = true, size = 'medium', defaultBranch, recentCommits }: BranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<'branch' | 'tag' | 'commit'>('branch')
  const inputRef = useRef<HTMLInputElement>(null)
  const branches = useBranches(owner, repo)
  const isSha = /^[0-9a-f]{40}$/i.test(value)
  // A ref that is not a branch is probably a tag: load tags up front so the icon, label and first tab are right.
  const notABranch = !!branches.data && !branches.data.some((b) => b.name === value)
  const tags = useTags(owner, repo, includeTags && !recentCommits && (open || (notABranch && !isSha)))
  const commits = useRecentCommits(owner, repo, defaultBranch, !!recentCommits && open)
  const isTag = (tags.data ?? []).some((t) => t.name === value) && !(branches.data ?? []).some((b) => b.name === value)
  const tabs = recentCommits ? (['branch', 'commit'] as const) : includeTags ? (['branch', 'tag'] as const) : null
  const kind = tabs ? tab : 'branch'
  // Tags may arrive after the picker opened on the Branches tab.
  useEffect(() => {
    if (open && isTag) setTab('tag')
  }, [open, isTag])

  const items = useMemo((): Array<{ name: string; protected: boolean; message?: string }> => {
    const f = filter.toLowerCase()
    if (kind === 'commit')
      return (commits.data ?? []).filter((c) => c.sha.startsWith(f) || c.message.toLowerCase().includes(f)).map((c) => ({ name: c.sha, message: c.message, protected: false }))
    if (kind === 'tag') return (tags.data ?? []).filter((x) => x.name.toLowerCase().includes(f)).slice(0, 100).map((x) => ({ name: x.name, protected: false }))
    return (branches.data ?? [])
      .filter((x) => x.name.toLowerCase().includes(f))
      .sort((a, c) => (a.name === defaultBranch ? -1 : c.name === defaultBranch ? 1 : a.name.localeCompare(c.name)))
      .slice(0, 200)
      .map((x) => ({ name: x.name, protected: x.protected }))
  }, [branches.data, tags.data, commits.data, filter, kind, defaultBranch])
  const loading = kind === 'tag' ? tags.isLoading : kind === 'commit' ? commits.isLoading : branches.isLoading

  const close = () => setOpen(false)
  const plural = kind === 'branch' ? 'branches' : kind === 'tag' ? 'tags' : 'commits'

  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => {
        setFilter('')
        setTab(isTag ? 'tag' : recentCommits && isSha ? 'commit' : 'branch')
        setOpen(true)
      }}
      onClose={close}
      width="medium"
      focusTrapSettings={{ initialFocusRef: inputRef }}
      renderAnchor={(anchorProps) => (
        <Button {...anchorProps} size={size} leadingVisual={isTag ? TagIcon : GitBranchIcon} trailingVisual={TriangleDownIcon} aria-label={`${value} ${isTag ? 'tag' : 'branch'}`}>
          {prefix && <span className="fg-muted text-bold">{prefix} </span>}
          <span className="text-truncate" style={{ maxWidth: 180, display: 'inline-block', verticalAlign: 'bottom' }}>
            {isSha ? value.slice(0, 7) : value}
          </span>
        </Button>
      )}
    >
      <div className="ref-picker">
        <div className="ref-picker-header">
          <h2>{recentCommits ? 'Pick a branch or recent commit' : includeTags ? 'Switch branches/tags' : 'Switch branches'}</h2>
          <IconButton icon={XIcon} variant="invisible" size="small" aria-label="Cancel" className="fg-muted" onClick={close} />
        </div>
        <div className="ref-picker-filter">
          <TextInput
            ref={inputRef}
            block
            leadingVisual={SearchIcon}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={kind === 'tag' ? 'Search' : kind === 'commit' ? 'Find a commit...' : 'Find a branch...'}
            aria-label={`Filter ${plural}`}
          />
        </div>
        {tabs && (
          <div className="ref-picker-tabs" role="tablist" aria-label="Ref type">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className="ref-picker-tab" onClick={() => setTab(t)}>
                <span>{t === 'branch' ? 'Branches' : t === 'tag' ? 'Tags' : 'Recent Commits'}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ref-picker-list">
          {loading ? (
            <div className="ref-picker-empty">
              <Spinner size="medium" aria-label={`Loading ${plural}...`} />
            </div>
          ) : items.length === 0 ? (
            <div className="ref-picker-empty">Nothing to show</div>
          ) : (
            <ActionList selectionVariant="single" role="listbox" aria-label={kind === 'tag' ? 'Tags' : kind === 'commit' ? 'Recent Commits' : 'Branches'}>
              {items.map((x) => (
                <ActionList.Item
                  key={x.name}
                  role="option"
                  selected={x.name === value}
                  onSelect={() => {
                    onChange(x.name)
                    close()
                  }}
                >
                  {x.message !== undefined ? (
                    <span className="ref-picker-name">
                      <code className="fg-muted">{x.name.slice(0, 7)}</code> {x.message}
                    </span>
                  ) : (
                    <span className="ref-picker-name">{x.name}</span>
                  )}
                  {(x.name === defaultBranch && kind === 'branch') || x.protected ? (
                    <ActionList.TrailingVisual>
                      {x.protected && <ShieldLockIcon aria-label="Protected" />}
                      {x.name === defaultBranch && kind === 'branch' && <Label>default</Label>}
                    </ActionList.TrailingVisual>
                  ) : null}
                </ActionList.Item>
              ))}
            </ActionList>
          )}
        </div>
        {!recentCommits && (
          <Link to={`/${owner}/${repo}/${plural}`} className="ref-picker-footer" onClick={close}>
            View all {plural}
          </Link>
        )}
      </div>
    </AnchoredOverlay>
  )
}
