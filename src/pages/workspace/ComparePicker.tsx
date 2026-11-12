import { useMemo, useRef, useState } from 'react'
import { ActionList, AnchoredOverlay, IconButton, Label, TextInput } from '@primer/react'
import { GitCompareIcon, SearchIcon, TriangleDownIcon, XIcon } from '@primer/octicons-react'
import type { BranchState } from '../../lib/git'

/** Picks the branch History compares the open one with. The default branch comes first, since it's the usual one. */
export function ComparePicker({ branches, value, defaultBranch, onChange }: { branches: BranchState[]; value: string | null; defaultBranch: string | null; onChange(name: string): void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const items = useMemo(() => {
    const f = filter.toLowerCase()
    return branches
      .filter((b) => b.name !== 'HEAD' && b.name.toLowerCase().includes(f))
      .sort((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch))
      .slice(0, 200)
  }, [branches, filter, defaultBranch])
  const close = () => setOpen(false)
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => {
        setFilter('')
        setOpen(true)
      }}
      onClose={close}
      width="medium"
      focusTrapSettings={{ initialFocusRef: inputRef }}
      renderAnchor={(anchorProps) => (
        <button {...anchorProps} type="button" className="ws-history-filter ws-compare-anchor" aria-pressed={!!value} aria-label={value ? `Comparing with ${value}` : 'Compare with a branch'}>
          <GitCompareIcon size={12} />
          <span className="ws-compare-name">{value ?? 'Compare'}</span>
          <TriangleDownIcon size={12} />
        </button>
      )}
    >
      <div className="ref-picker">
        <div className="ref-picker-header">
          <h2>Compare with a branch</h2>
          <IconButton icon={XIcon} variant="invisible" size="small" aria-label="Cancel" className="fg-muted" onClick={close} />
        </div>
        <div className="ref-picker-filter">
          <TextInput ref={inputRef} block leadingVisual={SearchIcon} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a branch..." aria-label="Filter branches" />
        </div>
        <div className="ref-picker-list">
          {items.length === 0 ? (
            <div className="ref-picker-empty">Nothing to show</div>
          ) : (
            <ActionList selectionVariant="single" role="listbox" aria-label="Branches">
              {items.map((b) => (
                <ActionList.Item
                  key={b.name}
                  role="option"
                  selected={b.name === value}
                  onSelect={() => {
                    onChange(b.name)
                    close()
                  }}
                >
                  <span className="ref-picker-name">{b.name}</span>
                  {b.name === defaultBranch && (
                    <ActionList.TrailingVisual>
                      <Label>default</Label>
                    </ActionList.TrailingVisual>
                  )}
                </ActionList.Item>
              ))}
            </ActionList>
          )}
        </div>
      </div>
    </AnchoredOverlay>
  )
}
